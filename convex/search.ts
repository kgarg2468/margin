import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { query } from "./_generated/server";
import { requireMembership } from "./lib/authz";
import {
  annotationType,
  annotationVisibility,
  ingestStatus,
  sessionStatus,
} from "./schema";

/**
 * Retrieval for the ⌘K palette: one lab's papers, notes and meetings, by name.
 *
 * Three things are worth saying about how this is written, because none of
 * them is the obvious way round.
 *
 * 1. **Private stays private, structurally.** The annotation half is two
 *    separate search-index reads — the lab's shared notes, and the caller's
 *    own — and they are combined only after both have come back. There is no
 *    read here that *could* return another member's private note, which is
 *    stronger than a filter that happens to remove them. It is the same shape
 *    `annotations.listForPaper` uses, for the same reason.
 *
 * 2. **Nothing is written.** Not a query string, not a hit count, not a
 *    timestamp. The privacy constitution forbids read tracking, and a log of
 *    what a member searched for is a record of what they were thinking about —
 *    which is exactly the thing Margin promises not to keep. This module is a
 *    `query`, so the platform enforces that too.
 *
 * 3. **It is deliberately shallow.** Titles and note bodies, not the text of
 *    the papers themselves. `paperPages` carries no `labId`, so a search index
 *    over it could not be filtered to the caller's lab, and full-text search
 *    across a library is a different feature with a different cost.
 */

/**
 * Per category, not overall. Eight is about where a grouped list stops being
 * scannable in one look — and a palette that returns forty results is asking
 * the reader to do the ranking it was supposed to do for them.
 */
const RESULTS_PER_CATEGORY = 6;

/**
 * How many rows to ask the index for before filtering.
 *
 * Withdrawn notes and (for the annotation half) the round-robin merge both
 * discard rows after the read, so asking for exactly the cap would quietly
 * return four results when six matched.
 */
const OVERFETCH = 4;

/**
 * A search string is a claim about length like anything else from a client.
 * Long enough for a title typed out in full, short enough that nobody is
 * pasting a paragraph into the index.
 */
export const MAX_SEARCH_LENGTH = 200;

/** Around the matched word, in the preview. */
const PREVIEW_LENGTH = 180;

const paperHit = v.object({
  _id: v.id("papers"),
  title: v.string(),
  authors: v.optional(v.array(v.string())),
  year: v.optional(v.number()),
  ingestStatus,
  /** Whether the reader would open, so the palette can offer it as a second move. */
  readable: v.boolean(),
});

const annotationHit = v.object({
  _id: v.id("annotations"),
  paperId: v.id("papers"),
  paperTitle: v.optional(v.string()),
  type: annotationType,
  visibility: annotationVisibility,
  /** A window of the note around the word that matched, not the whole thing. */
  preview: v.string(),
  authorName: v.string(),
  mine: v.boolean(),
  /** 0-based, as the anchor stores it. The palette renders it 1-based. */
  pageIndex: v.number(),
});

const sessionHit = v.object({
  _id: v.id("sessions"),
  title: v.optional(v.string()),
  paperTitle: v.optional(v.string()),
  scheduledAt: v.number(),
  status: sessionStatus,
});

/** Falls back through the fields a member might not have filled in. */
function displayName(user: Doc<"users"> | null): string {
  return user?.name ?? user?.email ?? "A lab member";
}

/**
 * The words the reader typed, for finding where in a note the match landed.
 *
 * Single characters are dropped: they occur in every note and windowing on one
 * would put the preview somewhere arbitrary. This is presentation only — the
 * ranking is the index's.
 */
function searchTerms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 1);
}

/**
 * A note, cut down to the part worth reading in a list.
 *
 * A body runs to four thousand characters and a palette row holds two lines,
 * so something has to choose which two. Showing the opening of the note would
 * frequently show none of the reason it matched, so the window is centred on
 * the first term that actually occurs — backed up to a word boundary, with an
 * ellipsis wherever the text was cut.
 */
function preview(body: string, terms: string[]): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= PREVIEW_LENGTH) {
    return flat;
  }

  const haystack = flat.toLowerCase();
  const hit = terms
    .map((term) => haystack.indexOf(term))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  if (hit === undefined || hit < PREVIEW_LENGTH / 2) {
    return `${flat.slice(0, PREVIEW_LENGTH).trimEnd()}…`;
  }

  const from = flat.lastIndexOf(" ", hit - Math.floor(PREVIEW_LENGTH / 3)) + 1;
  const to = from + PREVIEW_LENGTH;
  return `…${flat.slice(from, to).trim()}${to < flat.length ? "…" : ""}`;
}

/**
 * Two ranked lists into one, a row at a time.
 *
 * The alternative — the lab's notes first, then the caller's — means a member
 * whose own six notes matched sees none of them the moment the lab has six
 * too. Convex exposes no relevance score to sort a merged list by, so
 * alternating is the honest way to keep both lists' own ranking while
 * guaranteeing each of them a place.
 */
function interleave<T>(first: T[], second: T[], limit: number): T[] {
  const merged: T[] = [];
  for (let i = 0; merged.length < limit; i++) {
    const next = [first[i], second[i]].filter(
      (row): row is T => row !== undefined,
    );
    if (next.length === 0) {
      break;
    }
    merged.push(...next.slice(0, limit - merged.length));
  }
  return merged;
}

/** One `db.get` per distinct id rather than one per hit; results repeat papers constantly. */
async function resolvePapers(
  ctx: QueryCtx,
  ids: Id<"papers">[],
): Promise<Map<Id<"papers">, Doc<"papers">>> {
  const resolved = new Map<Id<"papers">, Doc<"papers">>();
  for (const id of new Set(ids)) {
    const paper = await ctx.db.get(id);
    if (paper !== null) {
      resolved.set(id, paper);
    }
  }
  return resolved;
}

/**
 * Everything in one lab that answers to `text`, grouped by what it is.
 *
 * Grouped rather than one ranked list because the three kinds are not
 * comparable: a paper is a place to go, a note is something someone said, a
 * session is a date. Ranking them against each other would be inventing a
 * number, and the reader already knows which of the three they are after.
 *
 * An empty search returns empty groups without touching an index — the palette
 * subscribes as soon as it opens, and the first thing it sends is "".
 */
export const everything = query({
  args: { labId: v.id("labs"), text: v.string() },
  returns: v.object({
    papers: v.array(paperHit),
    annotations: v.array(annotationHit),
    sessions: v.array(sessionHit),
  }),
  handler: async (ctx, args) => {
    const membership = await requireMembership(ctx, args.labId);
    const text = args.text.trim().slice(0, MAX_SEARCH_LENGTH);
    if (text.length === 0) {
      return { papers: [], annotations: [], sessions: [] };
    }
    const terms = searchTerms(text);

    const papers = await ctx.db
      .query("papers")
      .withSearchIndex("search_title", (q) =>
        q.search("title", text).eq("labId", args.labId),
      )
      .take(RESULTS_PER_CATEGORY);

    // The two halves of the visibility rule, read separately and never joined
    // in the database. `shared` is what the lab published; `own` is the
    // caller's private notebook, and `memberId` is what keeps it theirs.
    const shared = await ctx.db
      .query("annotations")
      .withSearchIndex("search_body", (q) =>
        q
          .search("body", text)
          .eq("labId", args.labId)
          .eq("visibility", "lab"),
      )
      .take(RESULTS_PER_CATEGORY * OVERFETCH);
    const own = await ctx.db
      .query("annotations")
      .withSearchIndex("search_body", (q) =>
        q
          .search("body", text)
          .eq("labId", args.labId)
          .eq("visibility", "private")
          .eq("memberId", membership.userId),
      )
      .take(RESULTS_PER_CATEGORY * OVERFETCH);

    // A withdrawn note has an empty body and would not match anyway; the check
    // is here so that stops being a coincidence.
    const live = (rows: Doc<"annotations">[]) =>
      rows.filter((row) => row.deletedAt === undefined && row.body.length > 0);
    const annotations = interleave(
      live(shared),
      live(own),
      RESULTS_PER_CATEGORY,
    );

    const sessions = await ctx.db
      .query("sessions")
      .withSearchIndex("search_title", (q) =>
        q.search("title", text).eq("labId", args.labId),
      )
      .take(RESULTS_PER_CATEGORY);

    // Both hit kinds carry the paper they are about, which is how a reader
    // tells two notes on the same word apart.
    const cited = await resolvePapers(ctx, [
      ...annotations.map((row) => row.paperId),
      ...sessions.map((row) => row.paperId),
    ]);

    const authors = new Map<Id<"users">, string>();
    for (const annotation of annotations) {
      if (!authors.has(annotation.memberId)) {
        authors.set(
          annotation.memberId,
          displayName(await ctx.db.get(annotation.memberId)),
        );
      }
    }

    return {
      papers: papers.map((paper) => ({
        _id: paper._id,
        title: paper.title,
        authors: paper.authors,
        year: paper.year,
        ingestStatus: paper.ingestStatus,
        readable:
          paper.ingestStatus === "ready" && paper.storageId !== undefined,
      })),
      annotations: annotations.map((annotation) => ({
        _id: annotation._id,
        paperId: annotation.paperId,
        paperTitle: cited.get(annotation.paperId)?.title,
        type: annotation.type,
        visibility: annotation.visibility,
        preview: preview(annotation.body, terms),
        authorName: authors.get(annotation.memberId) ?? "A lab member",
        mine: annotation.memberId === membership.userId,
        pageIndex: annotation.anchor.pageIndex,
      })),
      sessions: sessions.map((session) => ({
        _id: session._id,
        title: session.title,
        paperTitle: cited.get(session.paperId)?.title,
        scheduledAt: session.scheduledAt,
        status: session.status,
      })),
    };
  },
});
