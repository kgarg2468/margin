import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { getMembership, requireMembership, requireUserId } from "./lib/authz";
import { recordEvent } from "./lib/ledger";
import { annotationType, epistemicStatus } from "./schema";
import { canApprove } from "./sessions";
import { countWithdrawn } from "./synthesis";
import { redactWhenAnyWithdrawn } from "../lib/citations/redaction";
import { referenceIdentity } from "../lib/reference-import/normalize";
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

/**
 * The abuse guard on the PDF route, and on nothing else.
 *
 * Scoped deliberately, because the first version of this was not. Throttling
 * the *page* meant making its read a mutation, and that was wrong three ways
 * at once: a thousand-row annotation scan moved inside a write transaction, so
 * every stranger loading the page joined the conflict set of every member
 * annotating that paper; a refused request still cost a full serialized
 * transaction, which is strictly more than the query it replaced; and a
 * mutation fired during a Server Component render runs on prefetches and
 * abandoned renders that never reach a reader.
 *
 * The page needs no guard, because Convex already gives it one for free:
 * query results are cached per function and arguments until the data under
 * them changes, so a loop pointed at one live link is answered from cache and
 * costs almost nothing. The *mutation* was the expense. Removing it removed
 * the problem it was added to solve.
 *
 * What is genuinely expensive is this: the PDF route streams the whole file
 * with `no-store`, so every request pays for the bytes again. That is worth a
 * ceiling.
 *
 * **Keyed by the share, and by nothing else.** Not by IP, not by session, not
 * by any fingerprint of the reader — the privacy constitution's ban on read
 * tracking is not softened by the reader being a stranger, and a per-viewer
 * counter is a read log whatever it is called. What this counts is how hard
 * one *link* is being pulled, which is a fact about the link.
 *
 * The ceiling is deliberately generous. A paper that gets posted somewhere
 * busy must survive being popular; the guard exists for the loop, not for the
 * crowd. Ten fetches a second, sustained, on a single link is already far past
 * anything a lab sharing a paper produces.
 */
const READ_WINDOW_MS = 60_000;
const MAX_READS_PER_WINDOW = 600;


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
  /**
   * What the delivery route will do about the file, in the three states that
   * are genuinely different to a reader.
   *
   * `included` — there are bytes and the sharer said to send them.
   * `withheld` — there are bytes and the sharer did not. The page says so, in
   * its own words: this is a choice somebody made, not something taken back,
   * and it must not borrow the vocabulary of withdrawal.
   * `none` — the library never had the file. Nobody decided anything.
   *
   * A boolean would have collapsed the last two, and the page would have had
   * to either accuse the sharer of withholding a file that never existed or
   * stay silent about a decision ruling 3 asks it to state.
   *
   * The delivery route makes no such distinction — see `pdfForShare`, where
   * `withheld` and `none` are the same `null`.
   */
  pdf: v.union(
    v.literal("included"),
    v.literal("withheld"),
    v.literal("none"),
  ),
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

/**
 * The live share *and* the live paper a token names, or `null`.
 *
 * Two surfaces now start from a token and have to end at a paper — the public
 * page, and the redemption that puts that paper on somebody's own shelf — and
 * they must agree about what "still there" means down to the last condition.
 * A second copy of these four lines is how they would stop agreeing: the read
 * would keep a check the write had quietly dropped, and the write is the one
 * that leaves rows behind.
 *
 * The lab is asked for as well as the paper, which the page's own read did not
 * need — it falls back to a name when the lab is gone. A redemption cannot
 * fall back to anything: a paper whose lab has been deleted is a paper nobody
 * is left to have consented to sharing, so it is a dead link like any other.
 */
type PaperShare = Extract<Doc<"shares">, { kind: "paper" }>;

async function sharedPaper(
  ctx: QueryCtx,
  token: string,
): Promise<{ share: PaperShare; paper: Doc<"papers"> } | null> {
  const share = await liveShare(ctx, token);
  return share === null ? null : await paperBehind(ctx, share);
}

/** The second half of `sharedPaper`, for a caller that already holds the share. */
async function paperBehind(
  ctx: QueryCtx,
  share: Doc<"shares">,
): Promise<{ share: PaperShare; paper: Doc<"papers"> } | null> {
  if (share.kind !== "paper") {
    return null;
  }
  const paper = await ctx.db.get(share.paperId);
  // The share names a lab, and the row it points at has to still agree with
  // it: a paper deleted under a live link, or one that somehow moved.
  if (paper === null || paper.labId !== share.labId) {
    return null;
  }
  if ((await ctx.db.get(share.labId)) === null) {
    return null;
  }
  return { share, paper };
}

/**
 * Count this fetch against the link's window, and say whether to serve it.
 *
 * One row per share. Windows are aligned to wall-clock minutes rather than
 * started wherever the first request happened to land, so the boundary is a
 * fact about the clock rather than about who arrived first.
 *
 * Fails **open** on contention, and the claim is narrower than it used to be.
 * Two fetches landing in the same instant may cost one increment between them,
 * which is the right way for this to be wrong: a guard that occasionally
 * undercounts still stops a loop. What it does *not* do is swallow a genuine
 * failure — Convex exhausting its retries on this row surfaces to the caller,
 * which turns it into the same 429 the ceiling gives, and every other error
 * surfaces as the fault it is.
 *
 * Nothing is written once the ceiling is reached, which is deliberate — under
 * the attack this exists for, the cheapest possible response is a read and a
 * refusal, not a write.
 */
async function admitRead(
  ctx: MutationCtx,
  shareId: Id<"shares">,
): Promise<boolean> {
  const windowStart = Math.floor(Date.now() / READ_WINDOW_MS) * READ_WINDOW_MS;
  const row = await ctx.db
    .query("shareRateWindows")
    .withIndex("by_share", (q) => q.eq("shareId", shareId))
    .unique();

  if (row === null) {
    await ctx.db.insert("shareRateWindows", { shareId, windowStart, count: 1 });
    return true;
  }
  // A window that has ended is reset in place rather than left beside a new
  // one. The old minute's timestamp is gone the moment anybody touches the
  // link again, so the only stale row that can exist belongs to a link nobody
  // came back to — and the cron takes those.
  if (row.windowStart !== windowStart) {
    await ctx.db.patch(row._id, { windowStart, count: 1 });
    return true;
  }
  if (row.count >= MAX_READS_PER_WINDOW) {
    return false;
  }
  await ctx.db.patch(row._id, { count: row.count + 1 });
  return true;
}

/** How many stale counters one transaction clears before handing on the rest. */
const RATE_SWEEP_BATCH = 500;

/**
 * Delete counters for links nobody has come back to.
 *
 * A live link's row is overwritten by its next fetch, so this exists for the
 * abandoned ones: without it, a link opened once and forgotten would leave a
 * number and a minute sitting in the database forever, and the table's promise
 * about what survives at rest would be bounded by nothing.
 *
 * Batched and continued, on the same discipline as the opt-in sweep and for a
 * sharper reason. A single bounded pass with nothing behind it makes the
 * retention promise false exactly when it matters most: a deployment busy
 * enough to strand more than a batch of stale windows per interval accumulates
 * a backlog, and rows outlive the interval the schema comment advertises. The
 * continuation is what makes that comment a bound rather than a hope.
 *
 * Cheap when there is nothing to do — one index scan for windows that ended,
 * and on a quiet deployment it finds none and schedules nothing.
 */
export const sweepRateWindows = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const cutoff = Date.now() - READ_WINDOW_MS;
    const stale = await ctx.db
      .query("shareRateWindows")
      .withIndex("by_window_start", (q) => q.lt("windowStart", cutoff))
      .take(RATE_SWEEP_BATCH);
    for (const row of stale) {
      await ctx.db.delete(row._id);
    }
    // A full batch means there may be more. An exactly-full last batch costs
    // one scheduled run that finds nothing, which is the cheap way to be wrong.
    if (stale.length === RATE_SWEEP_BATCH) {
      await ctx.scheduler.runAfter(0, internal.shares.sweepRateWindows, {});
    }
    return null;
  },
});

/** The lab's name, for the one line of provenance a public page carries. */
async function labNameOf(ctx: QueryCtx, labId: Id<"labs">): Promise<string> {
  return (await ctx.db.get(labId))?.name ?? "A research lab";
}

/* -------------------------------------------------------------------------
 * The public read — a paper and its margin
 * ---------------------------------------------------------------------- */

/**
 * The members whose notes on this paper may be read publicly.
 *
 * **Two facts, both required: the opt-in row, and current membership.**
 *
 * The row alone was not enough, and the gap was real rather than theoretical.
 * Leaving a lab withdraws consent by deleting these rows, but a member with
 * more rows than one batch has the rest deleted by a scheduled continuation —
 * and until that job ran, or forever if it died, their writing went on being
 * published to strangers with no way for them to stop it, since the toggle
 * that would stop it needs the membership they no longer have. Asking for
 * membership *here* closes that: departure takes effect on the very next read,
 * and the sweep goes back to being hygiene rather than the thing correctness
 * hangs on.
 *
 * The rows are still where consent lives — their presence is the yes, there is
 * no boolean to read the wrong way round, and opting out deletes the row so a
 * note stops being public in the same instant and by the same act. Membership
 * is the second question: is this still one of the people whose lab this is.
 *
 * One membership lookup per distinct author who opted in, which is a small set
 * — bounded by `MAX_OPT_INS_PER_PAPER`, and in practice by the size of a
 * research group.
 */
async function optedInAuthors(
  ctx: QueryCtx,
  paperId: Id<"papers">,
  labId: Id<"labs">,
): Promise<Set<Id<"users">>> {
  const rows = await ctx.db
    .query("paperShareOptIns")
    .withIndex("by_paper", (q) => q.eq("paperId", paperId))
    .take(MAX_OPT_INS_PER_PAPER);

  const authors = new Set<Id<"users">>();
  for (const row of rows) {
    if ((await getMembership(ctx, labId, row.userId)) !== null) {
      authors.add(row.userId);
    }
  }
  return authors;
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
  const optedIn = await optedInAuthors(ctx, paper._id, paper.labId);

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
 * What is at the end of a share link — the one function in this backend with
 * no `requireUserId` anywhere in it.
 *
 * A query, and it must stay one. It was briefly a mutation so a rate counter
 * could be written on the way through, and that was a mistake worth leaving a
 * note about: it put this function's thousand-row annotation scan inside a
 * write transaction, which meant every anonymous page load sat in the conflict
 * set of every member annotating that paper — a lab writing in the margin
 * while its own link was being read would have seen its writes fail. It also
 * made a *refused* request cost a full serialized transaction, more than the
 * read it was protecting, and it fired a write during Server Component render,
 * where prefetches and abandoned renders spend it on pages nobody receives.
 *
 * The throttle it wanted is unnecessary here. Convex caches a query's result
 * per function and arguments until the data beneath it changes, so a flood
 * against one live link is served from cache; the expensive thing on this
 * surface is the PDF route, and that is where the counter lives now.
 *
 * Nothing is written, nothing is recorded about the reader, and the same token
 * gets the same answer every time.
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
      // The same resolution the redemption performs, so the page and the
      // import cannot come to disagree about which links are still alive.
      const live = await paperBehind(ctx, share);
      if (live === null) {
        return null;
      }
      const { paper } = live;
      const { notes } = await paperMargin(ctx, paper);
      return {
        kind: "paper" as const,
        labName: await labNameOf(ctx, share.labId),
        title: paper.title,
        ...(paper.authors === undefined ? {} : { authors: paper.authors }),
        ...(paper.year === undefined ? {} : { year: paper.year }),
        ...(paper.venue === undefined ? {} : { venue: paper.venue }),
        ...(paper.doi === undefined ? {} : { doi: paper.doi }),
        // Only alongside the file it describes. A page count is derived from
        // the PDF, so publishing it on a share that withholds the PDF would
        // publish a fact extracted from the very thing the sharer kept back —
        // small, but it is the withheld artifact talking. No public surface
        // reads it when there are no pages to number: the notes carry their
        // own page numbers, which is what a reader actually navigates by.
        ...(paper.pageCount === undefined ||
        share.includePdf !== true ||
        paper.storageId === undefined
          ? {}
          : { pageCount: paper.pageCount }),
        pdf:
          paper.storageId === undefined
            ? ("none" as const)
            : share.includePdf === true
              ? ("included" as const)
              : ("withheld" as const),
        notes,
      };
    }

    const session = await ctx.db.get(share.sessionId);
    if (session === null || session.labId !== share.labId) {
      return null;
    }
    // The same question `paperBehind` asks about a paper's lab, asked here so
    // the two branches of this query cannot come to disagree about what a live
    // link is. A write-up whose lab has been deleted is prose nobody is left to
    // have signed, and sign-off is the whole consent model for one.
    if ((await ctx.db.get(share.labId)) === null) {
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
/**
 * The PDF route's half of the throttle — the last gate before the bytes.
 *
 * Three answers rather than two, because two conflated the states that matter
 * most. `"dead"` means the link stopped being a link between the lookup and
 * here — a revocation landing mid-request — and the route must answer that
 * with the same 404 it gives a token that never existed, not the 429 it would
 * have given while a boolean could only say "no". `"busy"` is the ceiling.
 *
 * Separate from the lookup beside it so the cheap refusals stay cheap: a token
 * that names nothing is answered by `pdfForShare` without ever reaching this,
 * and therefore without writing a row.
 */
export const admitShare = internalMutation({
  args: { token: v.string() },
  returns: v.union(
    v.literal("ok"),
    v.literal("busy"),
    v.literal("dead"),
  ),
  handler: async (ctx, args) => {
    const share = await liveShare(ctx, args.token);
    if (share === null) {
      return "dead" as const;
    }
    return (await admitRead(ctx, share._id)) ? ("ok" as const) : ("busy" as const);
  },
});

/**
 * Is there a file behind this storage id, without fetching it?
 *
 * `_storage` is a system table, so its metadata row can be read the way any
 * row is read — which is the cheap half of a question the route used to only
 * know how to ask expensively. It has to ask *before* admission, so a paper
 * whose file has gone missing 404s without spending the link's ceiling; and it
 * must not move bytes doing so, or every throttled request would pay the
 * bandwidth the throttle exists to save.
 */
export const storedFileExists = internalQuery({
  args: { storageId: v.id("_storage") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    return (await ctx.db.system.get(args.storageId)) !== null;
  },
});

/**
 * The file behind a share token, if the share carries one at all.
 *
 * `null` is the whole vocabulary of refusal here, and every reason collapses
 * into it deliberately: no such token, revoked, a write-up rather than a paper,
 * the paper deleted or moved to another lab, no file in the library, and — now
 * — a sharer who chose not to include the file. The route turns `null` into
 * one 404 with one body, so a link whose PDF is switched off answers a probe
 * exactly as a paper that never had a file does, and neither can be told from
 * a token that was never minted.
 *
 * That indistinguishability is the point rather than a side effect. The
 * alternative — a distinct status or message for "the sharer said no" — would
 * publish the existence of a file somebody deliberately did not publish, and
 * would let anyone holding a revoked link work out whether the paper had a PDF
 * behind it. The public *page* does say which of those states it is in, and
 * that is a disclosure the sharer makes by sharing; this endpoint adds nothing
 * to it.
 *
 * `=== true` rather than a falsy check, so a row minted before the field
 * existed withholds its file rather than inheriting a default of yes.
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
    // Before the paper is read, and deliberately so — this ordering was
    // reviewed and kept, so please do not "fix" it into the other one.
    //
    // Returning here skips the `ctx.db.get` that the artifact-missing path
    // performs, which makes a withheld link measurably cheaper than a paper
    // that was deleted. Moving the check below the read would even those two
    // and unalign it from the revoked path instead: no ordering makes all
    // three identical, so the question is only which pair to align.
    //
    // This pair, because `revoked` reading exactly as `never existed` is the
    // constitutional promise a share link makes, and it is the one an attacker
    // gains something from breaking. The off-versus-none distinction it leaves
    // exposed is already public by design — the share page states which of the
    // two it is, in words — so a timing measurement of a live link reveals
    // nothing the page does not say outright, and for a dead link the whole
    // difference is one document read inside a single Convex query.
    if (share.includePdf !== true) {
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
 * Rung 0 → rung 1: leaving with the paper
 * ---------------------------------------------------------------------- */

/**
 * How much of the caller's own shelf the last dedupe pass reads.
 *
 * `zotero.newAmong`'s ceiling and `papers.listPapers`'s, restated for the same
 * reason `MAX_ANNOTATIONS_PER_PAPER` is: neither module exports it, and a
 * cross-module import for one number is a worse coupling than a number. Past
 * two hundred papers this stops catching a duplicate that shares neither a DOI
 * nor a file with what is already on the shelf — the same limit the library
 * page itself has, and the 201st paper is the signal to lift both together.
 *
 * It is the *last* pass and not the only one, which is what keeps that ceiling
 * a nuisance rather than a hole: the two passes above it go through indexes and
 * answer for a library of any size. What falls off the end here is a second
 * copy of a paper with no DOI and no file, which is a duplicate row on the
 * reader's own shelf and nothing more.
 */
const IDENTITY_SCAN_LIMIT = 200;

/**
 * How many papers may be claiming one blob before the file pass gives up.
 *
 * Almost every blob in a deployment is claimed by exactly one paper, so this
 * is one indexed read that answers immediately. The exception is the demo PDF,
 * which every personal library points at — and on that one blob this bound is
 * reached and the pass finds nothing, deliberately. The demo paper carries a
 * DOI, so the pass above has already recognised it; spending an unbounded scan
 * of every library in the deployment to reach the same answer is the trade
 * this refuses.
 */
const BLOB_CLAIM_SCAN_LIMIT = 50;

/**
 * What the redeemer's library already holds that this share would repeat.
 *
 * Three passes, in descending order of how much they prove and ascending order
 * of what they cost.
 *
 * 1. **The DOI**, through `by_lab_and_doi`. The one key with no ceiling behind
 *    it, and the one the overwhelming majority of shared papers carry.
 * 2. **The file**, through `by_pdf_storage`. Two rows pointing at one blob are
 *    two names for the same bytes, whatever their metadata says. This catches
 *    a paper the redeemer already had from some other route that happens to
 *    claim the sharer's file — it does *not* catch a second redemption of the
 *    same link, because an import now copies the bytes and its copy has an id
 *    of its own. Pass 1 or pass 3 catches that.
 * 3. **Title and year**, over one bounded read of the shelf. The last resort,
 *    for a preprint with no DOI and no file to be recognised by.
 *
 * **Pass 3 never overrules a DOI.** Two rows that both carry one, and carry
 * different ones, are two different papers however alike their titles read —
 * that is what a DOI is *for* — and merging them would lose one of them behind
 * the other with no way for the reader to tell it had happened. Since pass 1
 * has already returned for a matching DOI, any row that reaches pass 3 holding
 * one alongside a source that also holds one is provably distinct.
 */
async function alreadyOnShelf(
  ctx: QueryCtx,
  labId: Id<"labs">,
  paper: Doc<"papers">,
): Promise<Doc<"papers"> | null> {
  const doi = paper.doi;
  if (doi !== undefined) {
    const byDoi = await ctx.db
      .query("papers")
      .withIndex("by_lab_and_doi", (q) => q.eq("labId", labId).eq("doi", doi))
      .first();
    if (byDoi !== null) {
      return byDoi;
    }
  }

  const storageId = paper.storageId;
  if (storageId !== undefined) {
    const claiming = await ctx.db
      .query("papers")
      .withIndex("by_pdf_storage", (q) => q.eq("storageId", storageId))
      .take(BLOB_CLAIM_SCAN_LIMIT);
    const ours = claiming.find((row) => row.labId === labId);
    if (ours !== undefined) {
      return ours;
    }
  }

  const identity = referenceIdentity(paper.title, paper.year);
  const shelf = await ctx.db
    .query("papers")
    .withIndex("by_lab", (q) => q.eq("labId", labId))
    .take(IDENTITY_SCAN_LIMIT);
  return (
    shelf.find(
      (row) =>
        (doi === undefined || row.doi === undefined) &&
        referenceIdentity(row.title, row.year) === identity,
    ) ?? null
  );
}

/**
 * How much one library may gain in an hour before this door stops opening.
 *
 * The cheapest guard that is a fact about the *caller* rather than about the
 * reader — and the distinction is the whole reason it is written this way.
 * Every other rate limit on this module is keyed by the share, because
 * counting a stranger's reads is a read log whatever it is called. This one is
 * counted against the redeemer's own library, by an authenticated caller,
 * about writes they themselves made: the row it reads is their shelf.
 *
 * It counts every paper the library gained, whatever put it there — a DOI
 * fetch, a Zotero run, an upload, an import. Telling them apart would mean
 * writing down where each paper came from, and a column recording that this
 * one arrived from somebody else's share link is exactly the provenance trail
 * P7 refuses to keep. So the ceiling is set where a library that gained that
 * many papers in one hour has clearly been driven by a script: two hundred is
 * the number every other bound in this codebase's library paths uses, and a
 * researcher who genuinely crosses it has to wait rather than being refused
 * forever.
 *
 * Read before the dedupe rather than after, so the refusal is the cheapest
 * thing this mutation can do. The cost of being wrong that way round is that a
 * *second* redemption of a link — which writes nothing — is also refused at the
 * ceiling, which is the harmless direction.
 */
const IMPORT_WINDOW_MS = 60 * 60 * 1000;
const MAX_IMPORTS_PER_WINDOW = 200;

async function importBurstSpent(
  ctx: QueryCtx,
  labId: Id<"labs">,
): Promise<boolean> {
  const since = Date.now() - IMPORT_WINDOW_MS;
  // Newest first, one row past the ceiling. If that row is itself inside the
  // window then everything above it is too, which is the whole question — and
  // it is answered without reading a shelf of any size.
  const newest = await ctx.db
    .query("papers")
    .withIndex("by_lab", (q) => q.eq("labId", labId))
    .order("desc")
    .take(MAX_IMPORTS_PER_WINDOW + 1);
  const oldestCounted = newest[MAX_IMPORTS_PER_WINDOW];
  return oldestCounted !== undefined && oldestCounted._creationTime > since;
}

/** What the caller ends up holding, whichever way the redemption went. */
const importedPaper = v.union(
  v.null(),
  v.object({
    paperId: v.id("papers"),
    /** The caller's own library, so the shell can switch to it before landing. */
    labId: v.id("labs"),
    /**
     * File present and text read: the one state the margins can be written in.
     *
     * Always false for a paper that has just been created, because the bytes
     * are copied by a scheduled action and cannot have landed yet. It is true
     * only on the idempotent path, where it describes a row the shelf already
     * held.
     */
    ready: v.boolean(),
    /**
     * The file is here, or it is on its way.
     *
     * Deliberately not "there is a `storageId` on the row this instant". What
     * the landing needs to know is whether this paper is going to have a
     * document behind it, so that a reader who pressed "Keep the paper" is put
     * on the paper's own record — where the file section fills itself in — and
     * not on a shelf where a row appears and silently changes under them.
     */
    hasPdf: v.boolean(),
  }),
);

/**
 * Take the paper from a share link into your own library — `docs/PLG.md` P7,
 * the join between rung 0 and rung 1.
 *
 * Somebody read a lab's margin without an account, made one, and is now on the
 * other side of a sign-up holding nothing but the token they arrived with.
 * This is what turns that token into a paper on their own shelf.
 *
 * ## The token did not travel in a URL
 *
 * It came through `sessionStorage` in the reader's own tab and is spent here,
 * once, over an authenticated connection. That is not decoration: a capability
 * forwarded as a query parameter through a sign-up and an OAuth round trip is
 * written into the redirect chain, the referrer, the provider's logs and the
 * browser's history for every hop it survives. Nothing about the client's copy
 * is believed beyond the opaque string — the share is resolved from scratch
 * below, *now*, against live rows.
 *
 * ## What is re-asked at redemption
 *
 * All of it, through `sharedPaper`: the token still resolves, the share is not
 * revoked, the paper is still there and still in the lab the share names, and
 * that lab still exists. A link taken down between the visit and the sign-up
 * imports nothing — and says nothing. `null` is the whole vocabulary of
 * refusal, exactly as it is on the public read, because there is no version of
 * "that lab withdrew this while you were signing up" worth putting on a screen
 * in front of somebody's first five minutes.
 *
 * ## What crosses, and what does not
 *
 * **Metadata, always.** Title, authors, year, venue, DOI — the citable facts
 * the share page already had on it. Nothing is disclosed by writing them down
 * that was not disclosed by rendering them.
 *
 * **The file, only if the live share still says so** — and then as *bytes of
 * the redeemer's own*, never as a second claim on the sharing lab's blob.
 * `includePdf` is the sharer's decision that this document may travel, and it
 * is re-read here rather than inferred from the fact that the visitor could
 * have downloaded it. When it is off the paper lands `needs-pdf`, which is the
 * state the DOI-fetch ingest already produces and the record page already knows
 * how to finish.
 *
 * Copying rather than referencing is the ruling this feature was reviewed into,
 * and both halves of the argument are worth keeping written down. A shared
 * claim is **an oracle**: a sharer who kept the storage id of a file they have
 * since replaced can ask whether those bytes still exist, and survival is the
 * answer to a question they were never entitled to ask — *did anybody take my
 * paper?* It is also **permanent**: `papers.blobIsStillClaimed` refuses to
 * delete a blob any paper still points at, so one stranger's import would take
 * the sharing lab's ability to destroy its own file away for good. Bytes are
 * cheap; both of those are not.
 *
 * A mutation cannot read a blob, so the copy happens in `copySharedPdf` a
 * moment later and the paper is file-less until it lands. Every gate is asked
 * again there, inside the transaction that performs the write, so a link
 * revoked in that moment leaves a paper in exactly the state a withheld file
 * produces — no error, no half-attached document, no explanation.
 *
 * **The margin, never.** Not a note, not a reply, not a thread, not an author's
 * name. The lab's margin is rendered read-only on their page and stops there;
 * what lands here is a paper with nothing written in it yet, which is the whole
 * offer. There is no code below that reads `annotations`, and that absence is
 * the implementation of the rule.
 *
 * ## And nothing goes back
 *
 * The sharing lab learns nothing. No row is written in it, no event is filed
 * in it, no counter moves. "Somebody imported your paper" is a read report
 * about a stranger who agreed to nothing, and the constitution's ban on read
 * tracking on public surfaces does not soften because the read ended in a
 * signup. The one fact recorded is `paper.added` in the *redeemer's own* lab,
 * which is the same fact every other way of putting a paper on a shelf files.
 *
 * Idempotent, by DOI, by file, and by title identity — see `alreadyOnShelf`.
 * Redeeming twice hands back the row the first redemption made.
 */
export const importFromShare = mutation({
  args: { token: v.string() },
  returns: importedPaper,
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);

    const live = await sharedPaper(ctx, args.token);
    if (live === null) {
      return null;
    }
    const { share, paper } = live;

    // Into the caller's own library and nowhere else. A reader who has no
    // personal library is somebody who was already in a lab before P1 shipped,
    // and the honest answer for them is to do nothing: dropping a stranger's
    // paper into a research group's shelf on the strength of a link one member
    // clicked is a write into other people's library that nobody asked for.
    const mine = await ctx.db
      .query("labs")
      .withIndex("by_personal_for", (q) => q.eq("personalFor", userId))
      .first();
    if (mine === null) {
      return null;
    }

    // The one refusal here that is not about the link — see
    // `MAX_IMPORTS_PER_WINDOW`. Same `null`, so it is indistinguishable from
    // every other way this can come to nothing.
    if (await importBurstSpent(ctx, mine._id)) {
      return null;
    }

    const existing = await alreadyOnShelf(ctx, mine._id, paper);
    if (existing !== null) {
      return {
        paperId: existing._id,
        labId: mine._id,
        ready: existing.ingestStatus === "ready" && existing.storageId !== undefined,
        hasPdf: existing.storageId !== undefined,
      };
    }

    // `=== true` rather than a falsy check, for the same reason `pdfForShare`
    // spells it out: a row minted before the field existed withholds its file
    // rather than inheriting a default of yes. And the blob is asked about
    // before anything is promised about it — a file swept out from under the
    // sharing lab would otherwise schedule a copy of nothing and leave a paper
    // waiting for a document that is never coming.
    const fileTravels = (await consentingSource(ctx, share._id)) !== null;

    // Metadata, and nothing derived from a file that is not here yet. The paper
    // lands in exactly the state a DOI fetch that found no open-access copy
    // produces — `needs-pdf`, no `pageCount`, no text layer — which is the
    // state every other surface in the product already knows how to finish.
    const paperId = await ctx.db.insert("papers", {
      labId: mine._id,
      title: paper.title,
      ...(paper.authors === undefined ? {} : { authors: paper.authors }),
      ...(paper.year === undefined ? {} : { year: paper.year }),
      ...(paper.venue === undefined ? {} : { venue: paper.venue }),
      ...(paper.doi === undefined ? {} : { doi: paper.doi }),
      ingestStatus: "needs-pdf",
      addedBy: userId,
    });

    if (fileTravels) {
      // The share's id rather than its token. A scheduled call's arguments are
      // written down and kept until the job runs, and a bearer capability is
      // not a thing to leave lying in a queue when an internal id revalidates
      // exactly as much.
      await ctx.scheduler.runAfter(0, internal.shares.copySharedPdf, {
        shareId: share._id,
        paperId,
      });
    }

    // In the redeemer's own lab, about the redeemer, and nowhere else. The
    // ledger already has a word for this — it is a paper arriving on a shelf —
    // and inventing a second one would be inventing a fact the product would
    // then have to decide who may read.
    await recordEvent(ctx, {
      labId: mine._id,
      type: "paper.added",
      actorId: userId,
      paperId,
      title: paper.title,
    });

    return {
      paperId,
      labId: mine._id,
      ready: false,
      hasPdf: fileTravels,
    };
  },
});

/* -------------------------------------------------------------------------
 * The file, a moment later and on its own bytes
 * ---------------------------------------------------------------------- */

/**
 * How many pages of a text layer travel with a copied file.
 *
 * `papers.MAX_PAGES`, restated on the same terms as the other ceilings in this
 * module. It is the bound these rows were written under —
 * `papers.replacePageText` refuses a longer text layer outright — so anything
 * already on a shelf fits inside it, and a read that assumed so without saying
 * so would be an unbounded query wearing a promise.
 */
const IMPORTED_PAGE_LIMIT = 2_000;

/**
 * The file a live share still consents to hand over, and the paper it is on.
 *
 * Every gate, asked from scratch: the share exists, is not revoked, is a paper
 * share, still points at a paper in the lab it names, that lab still exists,
 * the sharer still says the file may travel, and the bytes are still there.
 * Three callers ask it — the redemption, the copy, and the attach — so that
 * consent is re-established at each of the three moments this feature touches
 * a file, rather than inferred from the moment before.
 */
async function consentingSource(
  ctx: QueryCtx,
  shareId: Id<"shares">,
): Promise<{ paper: Doc<"papers">; storageId: Id<"_storage"> } | null> {
  const share = await ctx.db.get(shareId);
  if (share === null || share.revokedAt !== undefined) {
    return null;
  }
  const live = await paperBehind(ctx, share);
  if (live === null || live.share.includePdf !== true) {
    return null;
  }
  const storageId = live.paper.storageId;
  if (storageId === undefined) {
    return null;
  }
  if ((await ctx.db.system.get(storageId)) === null) {
    return null;
  }
  return { paper: live.paper, storageId };
}

/** `consentingSource`, for the action, which has no database of its own. */
export const sharedPdfSource = internalQuery({
  args: { shareId: v.id("shares") },
  returns: v.union(
    v.null(),
    v.object({ storageId: v.id("_storage") }),
  ),
  handler: async (ctx, args) => {
    const source = await consentingSource(ctx, args.shareId);
    return source === null ? null : { storageId: source.storageId };
  },
});

/**
 * Put the shared file on the redeemer's shelf as bytes of their own.
 *
 * The half of an import a mutation cannot do: reading a blob needs an action,
 * so the paper is inserted first and the document catches up. In practice that
 * is one scheduler hop — the paper is usually complete before the reader has
 * finished looking at its title — and the intervening state is one the product
 * already has a face for, because it is the same one a paper added by DOI with
 * no open-access copy sits in.
 *
 * Silent in every failure. A revoked link, a sharer who switched the file off,
 * a blob that has gone, a paper deleted from the redeemer's own shelf in the
 * meantime: all of them leave the paper file-less, which is a state with a
 * remedy already on screen. There is nothing here worth telling somebody about
 * a lab they have no relationship with.
 */
export const copySharedPdf = internalAction({
  args: { shareId: v.id("shares"), paperId: v.id("papers") },
  returns: v.null(),
  // Annotated because this handler reaches its own module through
  // `internal.shares.*`, and the generated api's type is derived from these
  // exports — a circle TypeScript cannot close on its own.
  handler: async (ctx, args): Promise<null> => {
    const source: { storageId: Id<"_storage"> } | null = await ctx.runQuery(
      internal.shares.sharedPdfSource,
      { shareId: args.shareId },
    );
    if (source === null) {
      return null;
    }
    const bytes = await ctx.storage.get(source.storageId);
    if (bytes === null) {
      return null;
    }
    // Stored before the gates are asked the last time, because storing is the
    // only step here that cannot happen inside a transaction. If the answer has
    // changed by the time the mutation runs, the mutation is what discards
    // these bytes — see `attachImportedPdf` for why the delete has to commit
    // rather than being rolled back by a throw.
    const copied = await ctx.storage.store(bytes);
    await ctx.runMutation(internal.shares.attachImportedPdf, {
      shareId: args.shareId,
      paperId: args.paperId,
      sourceStorageId: source.storageId,
      storageId: copied,
    });
    return null;
  },
});

/**
 * Attach the copied file, and the text layer that describes it, in one write.
 *
 * The last gate, and the one that matters most, because it is the only one
 * inside the transaction that performs the write. `consentingSource` is asked
 * again here rather than trusted from the query a network round trip ago: a
 * link revoked in that window must leave the paper exactly as a withheld file
 * would, and the copied bytes must go rather than sitting in the deployment
 * with nothing pointing at them.
 *
 * `sourceStorageId` has to still be the file the share points at. The sharer
 * replacing their PDF between the read and this write would otherwise attach
 * the old document under a consent that now covers a different one.
 *
 * The text layer travels *here*, with the file, rather than in the redemption.
 * It is derived from the document — pdf.js output over the same bytes — so it
 * is the same disclosure and belongs to the same decision: pages copied into a
 * paper whose file never arrived would leave the whole text of the paper on a
 * shelf the ruling says should be empty of it, and would buy nothing, because
 * nothing can be annotated until there is a page on screen to select from.
 *
 * The outcome comes back as a value rather than a throw, for the reason
 * `papers.attachFetchedPdf` documents at length: a handler that throws rolls
 * back its own `ctx.storage.delete` while the action's `store` — which
 * committed outside this transaction — survives, so throwing would leak the
 * blob on exactly the race the delete exists for.
 */
export const attachImportedPdf = internalMutation({
  args: {
    shareId: v.id("shares"),
    paperId: v.id("papers"),
    sourceStorageId: v.id("_storage"),
    storageId: v.id("_storage"),
  },
  returns: v.union(v.literal("attached"), v.literal("declined")),
  handler: async (ctx, args) => {
    const source = await consentingSource(ctx, args.shareId);
    const mine = await ctx.db.get(args.paperId);
    if (
      source === null ||
      source.storageId !== args.sourceStorageId ||
      mine === null ||
      mine.storageId !== undefined
    ) {
      await ctx.storage.delete(args.storageId);
      return "declined" as const;
    }

    const pages = await ctx.db
      .query("paperPages")
      .withIndex("by_paper", (q) => q.eq("paperId", source.paper._id))
      .take(IMPORTED_PAGE_LIMIT);
    pages.sort((a, b) => a.pageIndex - b.pageIndex);
    const hasText = pages.some((page) => page.text.trim().length > 0);

    if (hasText) {
      for (const page of pages) {
        await ctx.db.insert("paperPages", {
          paperId: mine._id,
          pageIndex: page.pageIndex,
          text: page.text,
        });
      }
    }

    await ctx.db.patch(mine._id, {
      storageId: args.storageId,
      // Only alongside a text layer, and this is load-bearing rather than
      // tidy: `pdf-panel.tsx` starts extraction for a paper with a file, no
      // text and no `pageCount`, so a page count written without the pages it
      // counts would switch that off and leave a paper stuck one step from
      // readable with nothing on screen offering to finish it.
      ...(hasText ? { pageCount: pages.length } : {}),
      // `pending` is the same state a file fetched from a DOI lands in: the
      // document is here and the first browser to open it reads the text.
      ingestStatus: hasText ? "ready" : "pending",
    });
    return "attached" as const;
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
    /**
     * Whether the file travels with this link. Always false for a write-up
     * share, which has no file to carry — the panel for those never asks.
     */
    includePdf: v.boolean(),
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
  includePdf: boolean;
} | null> {
  if (share === null) {
    return null;
  }
  const creator = await ctx.db.get(share.createdBy);
  return {
    _id: share._id,
    token: share.token,
    createdAt: share.createdAt,
    // A write-up share has no `includePdf` to read and no file to carry, so
    // the answer for one is false rather than absent: the panel asks a
    // `shareState`, not a kind.
    includePdf: share.kind === "paper" && share.includePdf === true,
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
 * A **write-up** share stays with **its creator, or the PI** — not with
 * `canApprove`, which is the set that may mint. The two sets are close but not
 * equal, and the difference is a presenter: a presenter may publish the
 * write-up for their own session, and a presenter who did not create *this*
 * link cannot take it down. That is deliberate. A signed-off write-up is the
 * lab's account of itself, and unpublishing it is a decision for whoever
 * published it or for whoever answers for the lab, rather than for anyone who
 * happens to be running a meeting that week. The PI is always in the set, so
 * there is no link the lab cannot close.
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
    /**
     * Whether the library holds the file at all. The panel asks so that it can
     * omit the question entirely for a paper with nothing to send, rather than
     * offering a control over a file that does not exist.
     */
    hasPdf: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const paper = await ctx.db.get(args.paperId);
    if (paper === null) {
      throw new ConvexError("That paper is no longer in the library.");
    }
    const membership = await requireMembership(ctx, paper.labId);
    const share = await liveShareForPaper(ctx, paper._id);
    const optedIn = await optedInAuthors(ctx, paper._id, paper.labId);
    return {
      share: await describeShare(ctx, share, membership),
      optedIn: optedIn.has(membership.userId),
      optedInCount: optedIn.size,
      hasPdf: paper.storageId !== undefined,
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
      // `approvedWriteUp` itself — the third and last surface to ask this, and
      // now all three ask it the same way. The signature alone was too weak a
      // question here for the same reason it was too weak at the mint: a
      // session with a missing citation snapshot, or one citing a note since
      // withdrawn, is signed and still unpublishable, so the panel offered a
      // button whose mutation could only fail.
      approved: (await approvedWriteUp(ctx, session)) !== null,
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
  args: { paperId: v.id("papers"), includePdf: v.optional(v.boolean()) },
  returns: v.object({ token: v.string() }),
  handler: async (ctx, args) => {
    const paper = await ctx.db.get(args.paperId);
    if (paper === null) {
      throw new ConvexError("That paper is no longer in the library.");
    }
    const membership = await requireMembership(ctx, paper.labId);
    await optIn(ctx, paper, membership.userId);

    // The existing link keeps the terms it was minted under, including this
    // one. A second press is how the panel hands back a link that already
    // exists, and letting it carry a new answer would mean the file could be
    // switched on underneath a URL already sent to people — everyone holding
    // it would silently gain the paper. Changing the terms takes revoking and
    // minting again, so the new terms arrive with a new address.
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
      // Written for every new row even when false, so a row says what was
      // decided rather than leaving the reader to infer it from an absence.
      // Absent keeps meaning false, for the rows minted before the question
      // was asked.
      //
      // Coerced to false when there is no file, and that is the substantive
      // half. Consent has to be about an artifact somebody saw. A yes given
      // for a paper with nothing attached would otherwise sit on the row and
      // wait — and the moment a file arrived, by upload or by a Zotero sync
      // nobody was watching, a URL already in strangers' hands would start
      // serving a document that did not exist when the answer was given. The
      // panel hides the question in that case, so this is only reachable by a
      // direct call, but the rule belongs on the mutation rather than in the
      // UI that usually avoids it.
      includePdf: args.includePdf === true && paper.storageId !== undefined,
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
    // `approvedWriteUp` itself, rather than a restatement of some of what it
    // checks. The restatement drifted immediately: it asked for text and a
    // signature and skipped the citation snapshot, so a session whose snapshot
    // was missing or whose citations had been withdrawn minted a token — and
    // ledgered it — for a page the reader would be 404'd from on arrival. A
    // link that is dead the moment it is born is worse than a refusal, because
    // the member walks away believing they published something.
    if ((await approvedWriteUp(ctx, session)) === null) {
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
 * or the PI for a write-up's — not everyone who could have made one. A
 * presenter may mint a link for their own session and cannot take down a link
 * somebody else made, which is deliberate; the PI is always in the set, so no
 * link is left with nobody able to close it.
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

    // The rate window goes with it. Nothing reads it once the share is dead,
    // and leaving it would be keeping a count of how busy something used to be
    // after the thing itself was taken back.
    const window = await ctx.db
      .query("shareRateWindows")
      .withIndex("by_share", (q) => q.eq("shareId", share._id))
      .unique();
    if (window !== null) {
      await ctx.db.delete(window._id);
    }

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
  // Re-affirming refreshes the stamp rather than doing nothing. The row is
  // already there and the reader's answer does not change, so this looks like
  // a no-op — but `labs.sweepOptIns` deletes by `optedInAt <= departure`, and
  // a member who leaves, rejoins, and opts back in to a paper they had opted
  // in to before would otherwise keep a pre-departure stamp on a decision they
  // just made, and have it swept as though they had never re-affirmed it.
  // The stamp is what makes the cutoff's rule true, so it has to mean the
  // last time consent was given, not the first.
  if (existing !== null) {
    await ctx.db.patch(existing._id, { optedInAt: Date.now() });
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
