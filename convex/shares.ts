import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalQuery, mutation, query } from "./_generated/server";
import { requireMembership } from "./lib/authz";
import { recordEvent } from "./lib/ledger";
import { annotationType, epistemicStatus } from "./schema";
import { canApprove } from "./sessions";
import { countWithdrawn } from "./synthesis";
import { redactWhenAnyWithdrawn } from "../lib/citations/redaction";
import { isStillShared } from "../lib/citations/visibility";
import { looksLikeShareToken, mintShareToken } from "../lib/shares/token";

/**
 * Read-only public links — the product's first surface that does not ask who
 * you are.
 *
 * `docs/PLG.md` rung 0: a researcher pastes a Margin link into their lab's
 * Slack and whoever opens it reads the paper with the margin conversation
 * beside it. No account, no wall. The wall moves to *contributing*, which is
 * where Overleaf put it and the only place it has ever worked.
 *
 * Everything below exists to make that safe enough to mean it, and it comes
 * down to four rules:
 *
 * 1. **Opt-in, per artifact, unlisted.** Nothing is public until somebody
 *    shares it, and nothing anywhere lists what is. See the `shares` table.
 * 2. **Consent decomposes per author.** A paper share renders a note only if
 *    the note is lab-visible *and* its author has opted in for that paper.
 *    Private notes are never queried at all — the read goes through
 *    `by_paper_and_visibility`, so there is no filter to forget.
 * 3. **Sign-off is the consent model for a write-up.** A synthesis share
 *    carries the copy a person read, edited and put the lab's name on, and
 *    nothing else. No signature, no link.
 * 4. **Every read re-checks everything.** A share is a pointer, not a
 *    snapshot: revocation, deletion, a note gone private, a member opting back
 *    out, a citation withdrawn since approval — all of it is asked again on
 *    every single read, because the alternative is a URL that goes on
 *    publishing writing somebody has taken back.
 *
 * And one rule about what is *not* here: **no public read is ever recorded.**
 * Not who, not when, not how many. The privacy constitution's ban on read
 * tracking does not soften because the reader is a stranger — if anything it
 * binds harder, since a stranger has agreed to nothing. `share.created` and
 * `share.revoked` are decisions the lab made and go in the ledger; following a
 * link is not a decision anybody made about anybody, and goes nowhere.
 */

/* -------------------------------------------------------------------------
 * Ceilings
 * ---------------------------------------------------------------------- */

/**
 * The same ceiling `annotations.listForPaper` reads a margin under, and for
 * the same reason: a page anyone can open is not permission to run an
 * unbounded query. Restated rather than imported because that module does not
 * export it, and a cross-module import for one number would be a worse
 * coupling than a number.
 */
const MAX_ANNOTATIONS_PER_PAPER = 1_000;

/** A lab is a research group; every member having opted in is the ceiling. */
const MAX_OPT_INS_PER_PAPER = 500;

/* -------------------------------------------------------------------------
 * The public view model
 * ---------------------------------------------------------------------- */

/**
 * What stands in for a note the public page may no longer show.
 *
 * Carried in `body` rather than signalled only by the flag beside it, on the
 * same reasoning as `synthesis.WITHDRAWN_ITEM_TEXT`: a client that reads only
 * the text — a cache, a scraper, the next surface somebody builds — must get
 * the redaction rather than the sentence it replaced.
 *
 * It appears in exactly one situation, and the narrowness is the point: a
 * top-level note that may no longer be shown but still has replies underneath
 * it that may. Dropping it would drop other people's consented writing with
 * it. Every *other* unshowable note — one whose author never opted in, one
 * withdrawn with nothing hanging off it — is simply absent, with no
 * placeholder to count. Absence of consent is absence: a column of "a note was
 * here" markers would publish the shape of what the non-consenting members
 * wrote, which is the thing they declined.
 */
export const REDACTED_NOTE_TEXT = "A note here is no longer shared.";

/**
 * A name a stranger may be shown.
 *
 * Deliberately *not* `annotations.displayName`, which falls back to the
 * member's email address. That fallback is right inside a lab — you know these
 * people, and an address is how you tell two Sara Chens apart — and it is a
 * disaster on a page anyone can open, where it would publish the email of
 * every member who never filled in their name. Consenting to have a note read
 * is not consenting to be mailed by strangers.
 */
export function publicName(user: Doc<"users"> | null): string {
  return user?.name ?? "A lab member";
}

const publicReply = v.object({
  _id: v.id("annotations"),
  authorName: v.string(),
  type: annotationType,
  body: v.string(),
  createdAt: v.number(),
});

const publicNote = v.object({
  _id: v.id("annotations"),
  authorName: v.string(),
  type: annotationType,
  body: v.string(),
  /** The passage the note sits on, as its author selected it. */
  quote: v.string(),
  /** 0-based, so the page can put the card beside the right sheet. */
  pageIndex: v.number(),
  createdAt: v.number(),
  /**
   * Where the lab said the claim stands, and no more than that.
   *
   * The word travels; the name of whoever ruled does not. A status is set by a
   * PI or a presenter, who may be neither the note's author nor anybody who
   * opted this margin into being public — so publishing their name would
   * attach a person to a public page on somebody else's consent.
   */
  status: v.optional(epistemicStatus),
  /** True when `body` is the redaction sentence rather than a note. */
  redacted: v.boolean(),
  replies: v.array(publicReply),
});

const publicPaperView = v.object({
  kind: v.literal("paper"),
  /** Whose margin this is. The provenance is half of what makes it worth reading. */
  labName: v.string(),
  title: v.string(),
  authors: v.optional(v.array(v.string())),
  year: v.optional(v.number()),
  venue: v.optional(v.string()),
  doi: v.optional(v.string()),
  pageCount: v.optional(v.number()),
  /** Whether there are bytes to fetch from the token-scoped delivery route. */
  hasPdf: v.boolean(),
  notes: v.array(publicNote),
});

const publicSynthesisView = v.object({
  kind: v.literal("synthesis"),
  labName: v.string(),
  /** The paper the meeting was about. */
  paperTitle: v.string(),
  sessionTitle: v.optional(v.string()),
  /** The approved copy: markdown a person wrote and signed off. */
  text: v.string(),
  approvedAt: v.number(),
});

/* -------------------------------------------------------------------------
 * Reaching a share
 * ---------------------------------------------------------------------- */

/**
 * The live share a token names, or `null`.
 *
 * One function for every entry point — the page query, the PDF route — so
 * "live" cannot come to mean two things. Revoked reads exactly as missing:
 * both answer `null`, and every caller turns that into the same 404, so a
 * stranger holding a dead link cannot tell it from one that was never minted.
 *
 * The shape check runs first and costs no read. It is not the security
 * boundary — an index miss is already the right answer — it just keeps the
 * endpoint from paying for a database round trip on the crawler and scanner
 * traffic that makes up nearly all of what a public URL receives.
 */
async function liveShare(
  ctx: QueryCtx,
  token: string,
): Promise<Doc<"shares"> | null> {
  if (!looksLikeShareToken(token)) {
    return null;
  }
  const share = await ctx.db
    .query("shares")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
  if (share === null || share.revokedAt !== undefined) {
    return null;
  }
  return share;
}

/** The lab's name, for the one line of provenance a public page carries. */
async function labNameOf(ctx: QueryCtx, labId: Id<"labs">): Promise<string> {
  return (await ctx.db.get(labId))?.name ?? "A research lab";
}

/* -------------------------------------------------------------------------
 * The public read — a paper and its margin
 * ---------------------------------------------------------------------- */

/**
 * The members who have said their notes on this paper may be read publicly.
 *
 * A set of ids, built from rows whose *presence* is the consent — there is no
 * boolean to read the wrong way round, and opting back out deletes the row, so
 * a note stops being public in the same instant and by the same act.
 */
async function optedInAuthors(
  ctx: QueryCtx,
  paperId: Id<"papers">,
): Promise<Set<Id<"users">>> {
  const rows = await ctx.db
    .query("paperShareOptIns")
    .withIndex("by_paper", (q) => q.eq("paperId", paperId))
    .take(MAX_OPT_INS_PER_PAPER);
  return new Set(rows.map((row) => row.userId));
}

export type PublicReply = {
  _id: Id<"annotations">;
  authorName: string;
  type: Doc<"annotations">["type"];
  body: string;
  createdAt: number;
};

export type PublicNote = {
  _id: Id<"annotations">;
  authorName: string;
  type: Doc<"annotations">["type"];
  body: string;
  quote: string;
  pageIndex: number;
  createdAt: number;
  status?: Doc<"annotations">["status"];
  redacted: boolean;
  replies: PublicReply[];
};

/** A top-level note and whether the consent gates left anything of it. */
type Thread = { root: Doc<"annotations">; redacted: boolean };

/** A card on the public page: a surviving thread, or a promoted orphan reply. */
type Card = {
  root: Doc<"annotations">;
  redacted: boolean;
  replies: Doc<"annotations">[];
  /** What the card sorts by — see the redaction rule about `createdAt`. */
  createdAt: number;
};

/**
 * The paper's margin, as much of it as consent allows.
 *
 * Three gates, applied in this order, all of them on every read:
 *
 * 1. **The index.** Only `visibility: "lab"` rows are fetched. A private note
 *    is not filtered out here — it is never read, so there is no code path
 *    along which one could survive a careless edit.
 * 2. **Withdrawal.** `isStillShared` is the same predicate the briefs, the
 *    write-ups and the scout apply to their citations, asked here about the
 *    note itself.
 * 3. **The author's own consent.** Lab-visible is a decision about the lab.
 *    Public is a second decision, and it belongs to the author.
 *
 * A thread whose top-level note fails while its replies pass is the awkward
 * case, and *why* the root failed decides what happens to it. The two reasons
 * are not the same kind of fact and must not produce the same page.
 *
 * **Missing consent — the root is dropped whole, and its consented replies are
 * promoted to cards of their own.** Nothing is left where it stood: no marker,
 * no id, no page number, no timestamp. Its author never agreed to appear here,
 * and a placeholder would still say *somebody in this lab wrote a note on this
 * passage, and here is when* — which is a disclosure about a person who
 * declined to make one. Their colleagues' replies are their colleagues' own
 * writing and survive on their own feet.
 *
 * **Withdrawal — the root keeps a redaction marker.** Here the note *was*
 * public, somebody may already have read it, and the all-or-nothing rule from
 * `lib/citations/redaction.ts` is exactly right: the item loses its text
 * outright rather than vanishing, because the replies underneath are answers
 * to something and a page that silently reparented them would misattribute a
 * conversation. The marker carries the sentence, the page it sat on, and
 * nothing else — in particular not `createdAt`, which is taken from the first
 * surviving reply instead. The minute a note was written is not part of its
 * redaction sentence, and a withdrawn note's exact timestamp is a fact about
 * the author's working day that survives nothing else about it.
 *
 * Consent is checked *before* withdrawal for the root, so a note that fails
 * both fails as a consent case and leaves nothing behind. The stricter
 * disclosure rule wins.
 */
export async function paperMargin(
  ctx: QueryCtx,
  paper: Doc<"papers">,
): Promise<{ notes: PublicNote[] }> {
  const shared = await ctx.db
    .query("annotations")
    .withIndex("by_paper_and_visibility", (q) =>
      q.eq("paperId", paper._id).eq("visibility", "lab"),
    )
    .take(MAX_ANNOTATIONS_PER_PAPER);
  const optedIn = await optedInAuthors(ctx, paper._id);

  /** Lab-visible, still standing, and its author has said yes to strangers. */
  const shareable = (annotation: Doc<"annotations">): boolean =>
    isStillShared(annotation, paper.labId) && optedIn.has(annotation.memberId);

  const names = new Map<Id<"users">, string>();
  const nameOf = async (id: Id<"users">): Promise<string> => {
    const known = names.get(id);
    if (known !== undefined) {
      return known;
    }
    const resolved = publicName(await ctx.db.get(id));
    names.set(id, resolved);
    return resolved;
  };

  const repliesByParent = new Map<Id<"annotations">, Doc<"annotations">[]>();
  for (const row of shared) {
    // A reply nobody consented to is absent, with nothing left behind to
    // count. Only a *parent* leaves a marker, and only because its thread
    // would otherwise be lost along with it.
    if (row.parentId === undefined || !shareable(row)) {
      continue;
    }
    const existing = repliesByParent.get(row.parentId);
    if (existing === undefined) {
      repliesByParent.set(row.parentId, [row]);
    } else {
      existing.push(row);
    }
  }

  const consented = (annotation: Doc<"annotations">): boolean =>
    optedIn.has(annotation.memberId);

  const rootsById = new Map(
    shared.filter((row) => row.parentId === undefined).map((row) => [row._id, row]),
  );

  // Threads whose root's author consented. Only these can reach the redaction
  // rule below, because a redaction marker is a statement about a note that was
  // once public and a non-consenting author's note never was.
  const threads: Thread[] = shared
    .filter(
      (row) =>
        row.parentId === undefined &&
        consented(row) &&
        (shareable(row) || (repliesByParent.get(row._id)?.length ?? 0) > 0),
    )
    .map((root) => ({ root, redacted: false }));

  const { items: gated } = redactWhenAnyWithdrawn<Id<"annotations">, Thread>(
    threads,
    new Set(
      threads.filter(({ root }) => shareable(root)).map(({ root }) => root._id),
    ),
    ({ root }) => [root._id],
    (thread) => ({ ...thread, redacted: true }),
  );

  const cards: Card[] = gated.map(({ root, redacted }) => {
    const replies = (repliesByParent.get(root._id) ?? []).sort(
      (a, b) => a._creationTime - b._creationTime,
    );
    return {
      root,
      redacted,
      replies,
      // A redacted card borrows the first surviving reply's time rather than
      // carrying its own. Sorting by it keeps the conversation in order without
      // the position of the card itself disclosing when the withdrawn note was
      // written. Zero when nothing survives — which cannot happen, since a
      // thread with no surviving replies and a withdrawn root never got here.
      createdAt: redacted
        ? (replies[0]?._creationTime ?? 0)
        : root._creationTime,
    };
  });

  // Replies orphaned by the consent rule: their thread's root belongs to
  // somebody who never opted in, so the root is gone with nothing left in its
  // place, and these stand on their own. They are their authors' writing and
  // their authors said yes.
  //
  // Replies to a root that is *absent* from `shared` — a private parent — are
  // deliberately not promoted. That root was never part of this margin as far
  // as a public read is concerned, and lifting its replies out would be this
  // function inventing a thread nobody wrote.
  for (const row of shared) {
    if (row.parentId === undefined || !shareable(row)) continue;
    const root = rootsById.get(row.parentId);
    if (root === undefined || consented(root)) continue;
    cards.push({
      root: row,
      redacted: false,
      replies: [],
      createdAt: row._creationTime,
    });
  }

  cards.sort((a, b) => a.createdAt - b.createdAt);

  const notes: PublicNote[] = [];
  for (const { root, redacted, replies, createdAt } of cards) {
    notes.push({
      _id: root._id,
      // What a redacted thread is left with: the sentence, the page it sat on,
      // and a borrowed timestamp. No body, no quote, no author, no type, no
      // status — nothing its author or the lab wrote, and not the minute they
      // wrote it in.
      authorName: redacted ? "" : await nameOf(root.memberId),
      type: redacted ? "note" : root.type,
      body: redacted ? REDACTED_NOTE_TEXT : root.body,
      quote: redacted ? "" : root.anchor.quote,
      // Kept even when redacted: it places the card against the right sheet
      // and says nothing anybody wrote.
      pageIndex: root.anchor.pageIndex,
      createdAt,
      ...(redacted || root.status === undefined ? {} : { status: root.status }),
      redacted,
      replies: await Promise.all(
        replies.map(async (reply) => ({
          _id: reply._id,
          authorName: await nameOf(reply.memberId),
          type: reply.type,
          body: reply.body,
          createdAt: reply._creationTime,
        })),
      ),
    });
  }

  return { notes };
}

/**
 * Whether the approved write-up on this session may still be published.
 *
 * Sign-off is the consent, so it fails in two ways: nobody has signed off, and
 * the signature no longer covers what it was given for. The second is the same
 * computation the authed surface runs to raise its "read this through again"
 * banner — `countWithdrawn` over the approval snapshot — and the *outcome*
 * here is stricter, because the remedies are different.
 *
 * Inside the lab a stale copy can be shown with a banner over it: the readers
 * are the people who wrote it, and the banner asks them to fix it. Outside
 * there is nobody to ask and nothing to explain to, and prose that paraphrases
 * a note somebody has taken back is precisely what the redaction discipline
 * exists to stop. Nor is there a per-line remedy: an approved copy is prose a
 * person wrote, and no machine can say which sentence came from which note.
 * So the link deads, whole — and comes back by itself the moment the lab reads
 * it through and approves it again.
 */
export async function approvedWriteUp(
  ctx: QueryCtx,
  session: Doc<"sessions">,
): Promise<{ text: string; approvedAt: number } | null> {
  const { synthesis, synthesisApprovedAt } = session;
  if (synthesis === undefined || synthesisApprovedAt === undefined) {
    return null;
  }

  // The snapshot and nothing else: it is the list the copy was checked against
  // at the moment somebody signed it, which is exactly the scope of the
  // signature. The draft's own citations are re-checked where the draft is
  // read; this link does not carry the draft.
  //
  // An *absent* snapshot is not an empty one, and reading it as `?? []` was a
  // hole: a record approved before the field existed, or written by a path
  // that never set it, would be treated as citing nothing and would therefore
  // pass a withdrawal check it was never actually subjected to. What the field
  // says when it is missing is "nobody knows what this was checked against",
  // and the only safe reading of that on a public surface is no. An empty
  // array still means what it says — a copy deliberately signed against no
  // citations — and still publishes.
  const snapshot = session.synthesisCitedAnnotationIds;
  if (snapshot === undefined) {
    return null;
  }
  const stillShared = new Set<Id<"annotations">>();
  for (const annotationId of new Set(snapshot)) {
    if (isStillShared(await ctx.db.get(annotationId), session.labId)) {
      stillShared.add(annotationId);
    }
  }
  if (countWithdrawn(snapshot, stillShared) > 0) {
    return null;
  }
  return { text: synthesis, approvedAt: synthesisApprovedAt };
}

/**
 * What is at the end of a share link — the one query in this backend with no
 * `requireUserId` anywhere in it.
 *
 * It returns a view model rather than rows, and not for tidiness: a row handed
 * to an anonymous client is a row whose every field is published, and the
 * fields this backend keeps on an annotation include its author's id, its lab,
 * the session it was written in and the character offsets of the passage it
 * sits on. What a stranger gets is a name, a type, a sentence, a quote and a
 * page number — assembled here, checked here, and never a `Doc`.
 *
 * `null` for every way a link can be dead: not a token at all, no such token,
 * revoked, artifact deleted, signature gone. The caller renders the same 404
 * for all of them, so probing distinguishes nothing.
 */
export const view = query({
  args: { token: v.string() },
  returns: v.union(v.null(), publicPaperView, publicSynthesisView),
  handler: async (ctx, args) => {
    const share = await liveShare(ctx, args.token);
    if (share === null) {
      return null;
    }

    if (share.kind === "paper") {
      const paper = await ctx.db.get(share.paperId);
      // The share names a lab, and the row it points at has to still agree
      // with it: a paper deleted under a live link, or one that somehow moved.
      if (paper === null || paper.labId !== share.labId) {
        return null;
      }
      const { notes } = await paperMargin(ctx, paper);
      return {
        kind: "paper" as const,
        labName: await labNameOf(ctx, share.labId),
        title: paper.title,
        ...(paper.authors === undefined ? {} : { authors: paper.authors }),
        ...(paper.year === undefined ? {} : { year: paper.year }),
        ...(paper.venue === undefined ? {} : { venue: paper.venue }),
        ...(paper.doi === undefined ? {} : { doi: paper.doi }),
        ...(paper.pageCount === undefined ? {} : { pageCount: paper.pageCount }),
        hasPdf: paper.storageId !== undefined,
        notes,
      };
    }

    const session = await ctx.db.get(share.sessionId);
    if (session === null || session.labId !== share.labId) {
      return null;
    }
    const approved = await approvedWriteUp(ctx, session);
    if (approved === null) {
      return null;
    }
    const paper = await ctx.db.get(session.paperId);
    return {
      kind: "synthesis" as const,
      labName: await labNameOf(ctx, share.labId),
      paperTitle: paper?.title ?? "A paper",
      ...(session.title === undefined ? {} : { sessionTitle: session.title }),
      text: approved.text,
      approvedAt: approved.approvedAt,
    };
  },
});

/**
 * The PDF behind a paper share, for the HTTP route that delivers it.
 *
 * `internalQuery`, so the only way to reach it is through `convex/http.ts` —
 * which hands it a token and nothing else. The authed route's
 * `papers.pdfForDelivery` next door is untouched and still demands a bearer
 * header; this is a second door with its own key rather than a hole in the
 * first one.
 */
export const pdfForShare = internalQuery({
  args: { token: v.string() },
  returns: v.union(
    v.null(),
    v.object({ storageId: v.id("_storage"), title: v.string() }),
  ),
  handler: async (ctx, args) => {
    const share = await liveShare(ctx, args.token);
    if (share === null || share.kind !== "paper") {
      return null;
    }
    const paper = await ctx.db.get(share.paperId);
    if (
      paper === null ||
      paper.labId !== share.labId ||
      paper.storageId === undefined
    ) {
      return null;
    }
    return { storageId: paper.storageId, title: paper.title };
  },
});

/* -------------------------------------------------------------------------
 * Managing a share, from inside the lab
 * ---------------------------------------------------------------------- */

const shareState = v.union(
  v.null(),
  v.object({
    _id: v.id("shares"),
    token: v.string(),
    createdAt: v.number(),
    createdByName: v.string(),
    /** Whether the caller may take this link down: its creator, or the PI. */
    canRevoke: v.boolean(),
  }),
);

/** The live share for one artifact, if it has one. At most one ever does. */
async function liveShareForPaper(
  ctx: QueryCtx,
  paperId: Id<"papers">,
): Promise<Doc<"shares"> | null> {
  return await ctx.db
    .query("shares")
    .withIndex("by_paper", (q) =>
      q.eq("paperId", paperId).eq("revokedAt", undefined),
    )
    .first();
}

async function liveShareForSession(
  ctx: QueryCtx,
  sessionId: Id<"sessions">,
): Promise<Doc<"shares"> | null> {
  return await ctx.db
    .query("shares")
    .withIndex("by_session", (q) =>
      q.eq("sessionId", sessionId).eq("revokedAt", undefined),
    )
    .first();
}

async function describeShare(
  ctx: QueryCtx,
  share: Doc<"shares"> | null,
  membership: Doc<"memberships">,
): Promise<{
  _id: Id<"shares">;
  token: string;
  createdAt: number;
  createdByName: string;
  canRevoke: boolean;
} | null> {
  if (share === null) {
    return null;
  }
  const creator = await ctx.db.get(share.createdBy);
  return {
    _id: share._id,
    token: share.token,
    createdAt: share.createdAt,
    // The email fallback is right here and wrong on the public page: inside a
    // lab it is how you tell two people with the same name apart, and this
    // string never leaves a membership check. See `publicName`.
    createdByName: creator?.name ?? creator?.email ?? "A lab member",
    canRevoke: mayRevoke(share, membership),
  };
}

/**
 * Who may take a link down.
 *
 * Asymmetric on purpose, and in the direction that favours taking things back.
 *
 * A **paper** share may be revoked by any current member of the lab, because
 * any current member could have created it — the mint is unrestricted, and a
 * control anyone can press but only one person can un-press is a control whose
 * failure mode is a link nobody present can stop. The margin on the other end
 * is written by the whole lab; the whole lab can close it.
 *
 * A **write-up** share stays with its creator or the PI, because minting one
 * required `canApprove` in the first place. Widening revocation past the set
 * that can publish would be the only asymmetry worth avoiding here, and it
 * points the other way: everyone who can mint can revoke.
 */
function mayRevoke(
  share: Doc<"shares">,
  membership: Doc<"memberships">,
): boolean {
  if (share.kind === "paper") {
    return true;
  }
  return share.createdBy === membership.userId || membership.role === "pi";
}

/**
 * What the paper's share panel draws: the link, if there is one, and — always
 * — this member's own answer about their own notes.
 *
 * Every member sees the share, not only whoever made it. A link only its
 * creator can see is a link the rest of the lab cannot police, and the people
 * whose writing is at the other end of it are exactly the ones owed the
 * knowledge that it exists.
 */
export const forPaper = query({
  args: { paperId: v.id("papers") },
  returns: v.object({
    share: shareState,
    /** Whether the caller's own notes on this paper travel with the link. */
    optedIn: v.boolean(),
    /** How many members have said yes, so the panel can say whose margin it is. */
    optedInCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const paper = await ctx.db.get(args.paperId);
    if (paper === null) {
      throw new ConvexError("That paper is no longer in the library.");
    }
    const membership = await requireMembership(ctx, paper.labId);
    const share = await liveShareForPaper(ctx, paper._id);
    const optedIn = await optedInAuthors(ctx, paper._id);
    return {
      share: await describeShare(ctx, share, membership),
      optedIn: optedIn.has(membership.userId),
      optedInCount: optedIn.size,
    };
  },
});

/** The same, for a session's signed-off write-up. */
export const forSession = query({
  args: { sessionId: v.id("sessions") },
  returns: v.object({
    share: shareState,
    /** Whether somebody has signed a copy, which is what a link needs. */
    approved: v.boolean(),
    /** Whether the caller may mint one: the presenter, or the PI. */
    canShare: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (session === null) {
      throw new ConvexError("That session is no longer there.");
    }
    const membership = await requireMembership(ctx, session.labId);
    return {
      share: await describeShare(
        ctx,
        await liveShareForSession(ctx, session._id),
        membership,
      ),
      // Signed, not merely drafted. `synthesis` is the text; `synthesisApprovedAt`
      // is somebody's signature on it, and the signature is what the public read
      // requires — so a panel that offered a link on the strength of the text
      // alone would offer a link to a 404.
      approved: session.synthesisApprovedAt !== undefined,
      canShare: canApprove(session, membership),
    };
  },
});

/**
 * Give this paper a public address, and put the sharer's own notes at it.
 *
 * The two halves are one act on purpose. Sharing a margin you have written in
 * and *not* consenting to your own notes appearing would produce a link to an
 * empty page, which nobody means to do; and asking the sharer to flip a second
 * toggle to publish their own writing is ceremony in the one place the product
 * is trying to remove it. In the personal-library case — one researcher, one
 * lab, one margin — this is the entire consent model, and it asks nobody
 * anything.
 *
 * Idempotent. A second press hands back the link that already exists rather
 * than minting a rival: two live tokens on one paper would mean revoking one
 * of them silently did nothing, which is the worst possible property for a
 * control whose whole job is taking something back.
 */
export const sharePaper = mutation({
  args: { paperId: v.id("papers") },
  returns: v.object({ token: v.string() }),
  handler: async (ctx, args) => {
    const paper = await ctx.db.get(args.paperId);
    if (paper === null) {
      throw new ConvexError("That paper is no longer in the library.");
    }
    const membership = await requireMembership(ctx, paper.labId);
    await optIn(ctx, paper, membership.userId);

    const existing = await liveShareForPaper(ctx, paper._id);
    if (existing !== null) {
      return { token: existing.token };
    }

    const token = mintShareToken();
    const shareId = await ctx.db.insert("shares", {
      kind: "paper",
      token,
      labId: paper.labId,
      paperId: paper._id,
      createdBy: membership.userId,
      createdAt: Date.now(),
    });
    await recordEvent(ctx, {
      type: "share.created",
      labId: paper.labId,
      actorId: membership.userId,
      paperId: paper._id,
      shareId,
      kind: "paper",
    });
    return { token };
  },
});

/**
 * Give a signed-off write-up a public address.
 *
 * Narrower than sharing a paper, and narrower on purpose: an approved write-up
 * is *the lab's account of what it worked out*, so publishing one is the same
 * kind of act as signing it. `canApprove` is asked rather than plain
 * membership — the same two people, the presenter who ran the discussion and
 * the PI who answers for the lab. A member who could publish the lab's record
 * without either of them agreeing would be the sign-off model with a hole in
 * it.
 */
export const shareSynthesis = mutation({
  args: { sessionId: v.id("sessions") },
  returns: v.object({ token: v.string() }),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (session === null) {
      throw new ConvexError("That session is no longer there.");
    }
    const membership = await requireMembership(ctx, session.labId);
    if (!canApprove(session, membership)) {
      throw new ConvexError(
        "Only the presenter or the lab's PI can publish the write-up.",
      );
    }
    // The same fact `approvedWriteUp` checks, asked at the same strength. A
    // cleared signature used to still mint a token here — and ledger it —
    // producing a live row whose page had never been publishable.
    if (
      session.synthesis === undefined ||
      session.synthesisApprovedAt === undefined
    ) {
      throw new ConvexError(
        "There is no approved write-up to share yet. Sign one off first — the signature is what makes it publishable.",
      );
    }

    const existing = await liveShareForSession(ctx, session._id);
    if (existing !== null) {
      return { token: existing.token };
    }

    const token = mintShareToken();
    const shareId = await ctx.db.insert("shares", {
      kind: "synthesis",
      token,
      labId: session.labId,
      sessionId: session._id,
      createdBy: membership.userId,
      createdAt: Date.now(),
    });
    await recordEvent(ctx, {
      type: "share.created",
      labId: session.labId,
      actorId: membership.userId,
      paperId: session.paperId,
      sessionId: session._id,
      shareId,
      kind: "synthesis",
    });
    return { token };
  },
});

/**
 * Take the link down.
 *
 * Stamped rather than deleted, so the lab keeps the record that the artifact
 * was public and when it stopped being — and so the ledger's two rows have
 * something that still exists to point at. Every read path treats a stamped
 * row as missing, so the link is dead on the next request; there is no cache
 * in front of it and nothing to wait for.
 *
 * Who may press it is `mayRevoke`: any member for a paper's link, the creator
 * or the PI for a write-up's. The rule is that everyone who could have made a
 * link can unmake it.
 */
export const revoke = mutation({
  args: { shareId: v.id("shares") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const share = await ctx.db.get(args.shareId);
    if (share === null) {
      throw new ConvexError("That link is already gone.");
    }
    const membership = await requireMembership(ctx, share.labId);
    if (!mayRevoke(share, membership)) {
      throw new ConvexError(
        "Only whoever made this link, or the lab's PI, can take it down.",
      );
    }
    if (share.revokedAt !== undefined) {
      // Already down. Not an error: two people pressing the same button about
      // the same link both meant the same thing, and both got it.
      return null;
    }
    await ctx.db.patch(share._id, { revokedAt: Date.now() });

    // The paper rides along even for a write-up's link, resolved through the
    // session, so a paper's own history (`by_paper_and_at`) shows the link
    // going down as well as going up. A record with only the first half of
    // that pair is a record that says the artifact is still public.
    const paperId =
      share.kind === "paper"
        ? share.paperId
        : (await ctx.db.get(share.sessionId))?.paperId;
    await recordEvent(ctx, {
      type: "share.revoked",
      labId: share.labId,
      actorId: membership.userId,
      ...(paperId === undefined ? {} : { paperId }),
      ...(share.kind === "synthesis" ? { sessionId: share.sessionId } : {}),
      shareId: share._id,
      kind: share.kind,
    });
    return null;
  },
});

/** Write the row that is the consent, unless it is already there. */
async function optIn(
  ctx: MutationCtx,
  paper: Doc<"papers">,
  userId: Id<"users">,
): Promise<void> {
  const existing = await ctx.db
    .query("paperShareOptIns")
    .withIndex("by_paper_and_user", (q) =>
      q.eq("paperId", paper._id).eq("userId", userId),
    )
    .unique();
  if (existing !== null) {
    return;
  }
  await ctx.db.insert("paperShareOptIns", {
    labId: paper.labId,
    paperId: paper._id,
    userId,
    optedInAt: Date.now(),
  });
  await recordEvent(ctx, {
    type: "share.optin_changed",
    labId: paper.labId,
    actorId: userId,
    paperId: paper._id,
    included: true,
  });
}

/**
 * A member deciding whether their own notes on this paper travel with its
 * link.
 *
 * Their own, and only ever their own: there is no argument by which one member
 * could set this for another, so the mutation takes no subject and reads the
 * caller. The paper need not have a share — a member can answer in advance,
 * and the answer stands for whenever one is made.
 *
 * Opting out deletes the row rather than flipping a flag on it. Presence is
 * the consent, so the absence of the row is the whole of the refusal, and
 * there is no second state anywhere for a read to get wrong.
 */
export const setPaperOptIn = mutation({
  args: { paperId: v.id("papers"), included: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const paper = await ctx.db.get(args.paperId);
    if (paper === null) {
      throw new ConvexError("That paper is no longer in the library.");
    }
    const membership = await requireMembership(ctx, paper.labId);

    if (args.included) {
      await optIn(ctx, paper, membership.userId);
      return null;
    }

    const existing = await ctx.db
      .query("paperShareOptIns")
      .withIndex("by_paper_and_user", (q) =>
        q.eq("paperId", paper._id).eq("userId", membership.userId),
      )
      .unique();
    if (existing === null) {
      return null;
    }
    await ctx.db.delete(existing._id);
    await recordEvent(ctx, {
      type: "share.optin_changed",
      labId: paper.labId,
      actorId: membership.userId,
      paperId: paper._id,
      included: false,
    });
    return null;
  },
});
