import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { getMembership, requireMembership, requireUserId } from "./lib/authz";
import { slackIsConfigured } from "./lib/slack";
import {
  anchorOverlap,
  assembleDigest,
  detectCollisions,
  detectCrossPaperCollisions,
  MAX_DIGEST_ITEMS,
  type Collision,
  type DigestAnnotation,
  type DigestItem,
} from "../lib/digest/engine";
import { papersToScan, planSinceAway } from "../lib/digest/since-away";

/**
 * Boundary-delivered digests.
 *
 * The architecture decision puts delivery at boundaries and nowhere else: a
 * prep digest computed two hours before a session, a refresh at session start,
 * and an in-app "since you were away" built when a member comes back to a lab
 * they have been gone from. There are no per-write notifications, ever.
 *
 * This module is the plumbing — reads, authorization, writes. The policy it
 * runs is `lib/digest/engine.ts`, which is pure and unit-tested: deterministic
 * typed-pair collision detection over overlapping passage anchors, gold pairs
 * promoted to their own line, everything else coalesced to one line per paper,
 * hard cap five. The "since you were away" boundary additionally pairs across
 * papers — it is the only one whose pool spans more than one — and those pairs
 * rank behind every same-paper one.
 *
 * ## Three things this file will not do
 *
 * 1. **It never reads a private annotation.** Every query here is pinned to
 *    `by_paper_and_visibility` at `"lab"`. Privacy is not a filter applied
 *    late; it is the index the read goes through.
 * 2. **It never says who hasn't read something.** A delta is "what's new since
 *    you last looked" — a count of what arrived, computed against the
 *    recipient's own cursor. Nothing in a digest is derived from anyone else's
 *    cursor, so there is no phrasing of the output that could report on
 *    another member's attention. The privacy constitution forbids read
 *    tracking, and the digest is where that rule would be tempting to bend.
 * 3. **It writes no ledger event.** `events` records collective facts — what
 *    happened in the lab. A digest delivery is per-recipient and derived: it
 *    adds nothing that the annotations it summarizes don't already say, and
 *    recording "we told Ana about Ben's critique" would put an attention trail
 *    for every member into the one table the whole product reads back from.
 *    The `eventDoc` union has no digest variant, and that is deliberate.
 */

/* -------------------------------------------------------------------------
 * Policy constants
 * ---------------------------------------------------------------------- */

/**
 * How far back a member with no cursor for a paper is shown.
 *
 * A member who has never opened a paper has no "since you last looked", so
 * the fallback is the moment they joined the lab — everything written before
 * they arrived is somebody else's history, not their delta. That is capped at
 * two weeks because the alternative, for someone who joined a year ago and is
 * opening this paper for the first time, is a digest that reaches back a year
 * and is uniformly stale. The cap can only ever shrink a delta, never grow it.
 */
const NO_CURSOR_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Ceiling on how many of a paper's annotations one digest run considers.
 *
 * Read newest-first, so a paper that has run away with itself contributes its
 * most recent thousand rather than its oldest thousand. Collision detection is
 * quadratic in this number and a journal club is not a comment section; if a
 * paper ever gets past it, the digest degrades to "the recent part of the
 * conversation" rather than timing out.
 */
const POOL_LIMIT = 1000;

/** How many digests a member's inbox hands back at once. */
const INBOX_PAGE = 20;

/**
 * How much of the ledger an arrival reads to find out which papers moved.
 *
 * Newest-first over the window since the member's cursor. It is a sample, not
 * a census: all it has to do is name the handful of papers below, and the
 * newest two hundred facts in a lab name the papers currently being argued
 * about far more reliably than the oldest two hundred would.
 */
const SINCE_AWAY_EVENT_SCAN = 200;

/**
 * How many papers one "since you were away" digest reads annotations for, and
 * how many of each paper's annotations it pools.
 *
 * The product of the two is `POOL_LIMIT`: an arrival costs the same ceiling in
 * reads as a session boundary does, spread across the papers a lab actually
 * touched instead of concentrated on one. Five is also the digest's own cap,
 * and the papers arrive most-recently-written-first — so a lab that moved on
 * six papers spends its five lines on the five it is currently arguing about
 * and drops the quietest one, which is the same order the cap would have cut
 * in anyway.
 */
const SINCE_AWAY_PAPERS = 5;
const SINCE_AWAY_POOL_LIMIT = 200;

/**
 * How old one of your own notes has to be before a one-member lab may hand it
 * back to you.
 *
 * A fortnight, and the number is doing one job: separating a *memory* from the
 * paragraph you typed on Tuesday. Handing back something recent is not recall,
 * it is an echo — the reader remembers writing it, so the line spends one of
 * five slots telling them something they already hold. Two weeks is the
 * shortest gap that reliably clears that: it survives a week of holiday, a
 * conference, and the ordinary case of picking a paper back up after other
 * work. Longer would read better in a demo and be invisible for a month to the
 * solo researcher who has only just started keeping notes, and a feature that
 * cannot fire in a new user's first month is a feature they never find.
 *
 * It is a floor and not the whole rule — see `catchUp`, which also refuses
 * anything written inside the window this arrival is reporting on, so a note
 * cannot be both the writing that made a paper interesting again and the
 * memory that writing turned up.
 */
const SOLO_RECALL_MIN_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Where a recalled note stops being "weeks ago" and starts being a month.
 *
 * Six weeks, because "7 weeks ago" is a number a reader has to do arithmetic on
 * and "in March" is one they can place immediately. Under six weeks the
 * relative form is the more useful of the two — the month name of something
 * three weeks old is often just "this month", which locates nothing.
 */
const RELATIVE_WHEN_LIMIT_MS = 6 * WEEK_MS;

/** Longest quote a recall line inlines before eliding. */
const MAX_RECALL_QUOTE_CHARS = 100;

/* -------------------------------------------------------------------------
 * Validators
 * ---------------------------------------------------------------------- */

/**
 * The two boundaries that arrive as a scheduled job. The `digests` table has a
 * third, `since-away`, which is built by `catchUp` when a member comes back to
 * the lab rather than queued in advance — so it is not a value this argument
 * ever takes.
 */
const sessionBoundary = v.union(
  v.literal("session-prep"),
  v.literal("session-start"),
);

const digestItem = v.object({
  kind: v.union(v.literal("collision"), v.literal("coalesced")),
  paperId: v.id("papers"),
  /** The second paper of a cross-paper collision; absent on every other item. */
  otherPaperId: v.optional(v.id("papers")),
  annotationIds: v.array(v.id("annotations")),
  pairType: v.optional(v.string()),
  line: v.string(),
});

const digestSummary = v.object({
  _id: v.id("digests"),
  sessionId: v.optional(v.id("sessions")),
  boundary: v.union(
    v.literal("session-prep"),
    v.literal("session-start"),
    v.literal("since-away"),
  ),
  generatedAt: v.number(),
  deliveredAt: v.optional(v.number()),
  acknowledgedAt: v.optional(v.number()),
  droppedCount: v.optional(v.number()),
  items: v.array(digestItem),
});

/* -------------------------------------------------------------------------
 * Seen cursors
 * ---------------------------------------------------------------------- */

/**
 * The one refusal for a cursor target the caller may not have, whatever the
 * reason — same posture as `requireMembership` in `lib/authz.ts`, where "no
 * such lab" and "not a member" are one message.
 */
const NO_SUCH_TARGET = "That's no longer in this lab.";

/** A member's cursor for one paper, if they have ever had one. */
async function paperCursor(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  paperId: Id<"papers">,
): Promise<Doc<"seenCursors"> | null> {
  return await ctx.db
    .query("seenCursors")
    .withIndex("by_user_and_paper", (q) =>
      q.eq("userId", userId).eq("paperId", paperId),
    )
    .unique();
}

async function sessionCursor(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  sessionId: Id<"sessions">,
): Promise<Doc<"seenCursors"> | null> {
  return await ctx.db
    .query("seenCursors")
    .withIndex("by_user_and_session", (q) =>
      q.eq("userId", userId).eq("sessionId", sessionId),
    )
    .unique();
}

/**
 * A member's lab-wide cursor: how far into the *lab* they have caught up,
 * as opposed to into one paper or one session.
 *
 * It is the row in `seenCursors` with neither a `paperId` nor a `sessionId` —
 * the schema has always allowed one, and "since you were away" is what finally
 * needs it, because an absence is from the lab rather than from a document.
 * There is at most one per member per lab: only `markSeen` creates it, and only
 * when there isn't one.
 *
 * The read is bounded by the cursors this member holds *in this one lab* —
 * `by_user_and_lab` cannot see another lab's, and a member's cursor count in a
 * lab is bounded by the papers they have caught up on.
 */
async function labCursor(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  labId: Id<"labs">,
): Promise<Doc<"seenCursors"> | null> {
  return await ctx.db
    .query("seenCursors")
    .withIndex("by_user_and_lab", (q) =>
      q.eq("userId", userId).eq("labId", labId),
    )
    .filter((q) =>
      q.and(
        q.eq(q.field("paperId"), undefined),
        q.eq(q.field("sessionId"), undefined),
      ),
    )
    .first();
}

/** The one refusal for a digest that isn't the caller's — as `markDigestSeen`. */
const NOT_YOUR_DIGEST = "That digest isn't in your inbox.";

/**
 * A cursor only ever moves forward.
 *
 * `markSeen` can be told to stamp a moment that has already passed (the
 * digest's own `generatedAt`), and digests do not arrive in the order they
 * were written: acknowledging last week's after this morning's would otherwise
 * drag the cursor backwards and re-deliver a fortnight the member has already
 * read. A cursor answers "what's new since you last looked", and looking is
 * not something that can be undone.
 */
async function advanceCursor(
  ctx: MutationCtx,
  existing: Doc<"seenCursors"> | null,
  at: number,
  fresh: Omit<Doc<"seenCursors">, "_id" | "_creationTime" | "lastSeenAt">,
): Promise<void> {
  if (existing === null) {
    await ctx.db.insert("seenCursors", { ...fresh, lastSeenAt: at });
  } else if (at > existing.lastSeenAt) {
    await ctx.db.patch(existing._id, { lastSeenAt: at });
  }
}

/**
 * Mark a paper, a session or a whole lab as looked at.
 *
 * **Only ever an explicit act by the person it is about.** Nothing calls this
 * on open, and nothing may: a cursor that moved because a panel scrolled into
 * view is dwell tracking, which the privacy constitution forbids outright.
 * "I'm caught up" is a button with a person behind it. This is the only thing
 * Margin stores about attention, and note what it is *not*: a view count, a
 * dwell time, or a record that anyone can query about anyone else. A cursor is
 * a single timestamp, readable only by its owner's own digests, and it exists
 * so that "what's new since you last looked" has a meaning. Nothing reads it
 * to ask whether a member has kept up.
 *
 * Exactly one of `paperId` / `sessionId` / `labId` — a cursor addresses one
 * thing. The lab-wide one is what a "since you were away" digest is
 * acknowledged against: that digest is about an absence from the lab, and no
 * per-paper cursor can record the end of one.
 *
 * ## Why `digestId` rather than `now`
 *
 * The click that moves a cursor is somebody acknowledging a *digest*, and the
 * digest was assembled earlier — minutes, or a night's sleep. Stamping the
 * clock at click time buried everything written in between: those annotations
 * were never in the digest the member read, and they were now behind the
 * cursor, so no later digest would ever mention them. What the member is
 * saying is "I have read up to what this told me", and the only honest cursor
 * is the digest's own `generatedAt`.
 *
 * It is derived here from the id rather than passed as a timestamp, because a
 * timestamp is an argument a client can be wrong about — or lie about — and
 * this one decides what a member is never shown again. The digest must be the
 * caller's own, and must actually address the paper, session or lab being
 * stamped; otherwise a stale acknowledgement could be pointed at an unrelated
 * cursor.
 *
 * Without `digestId` the stamp is `now`, which is what an acknowledgement of
 * something other than a digest would mean.
 */
export const markSeen = mutation({
  args: {
    paperId: v.optional(v.id("papers")),
    sessionId: v.optional(v.id("sessions")),
    /** The lab a "since you were away" digest was an absence from. */
    labId: v.optional(v.id("labs")),
    /** The digest this acknowledgement is of; its `generatedAt` is the stamp. */
    digestId: v.optional(v.id("digests")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const targets = [args.paperId, args.sessionId, args.labId].filter(
      (target) => target !== undefined,
    );
    if (targets.length !== 1) {
      throw new ConvexError("Mark one paper, session or lab as seen.");
    }
    const userId = await requireUserId(ctx);

    let at = Date.now();
    if (args.digestId !== undefined) {
      const digest = await ctx.db.get(args.digestId);
      if (digest === null || digest.userId !== userId) {
        throw new ConvexError(NOT_YOUR_DIGEST);
      }
      // A lab-wide cursor may only be moved by a lab-wide digest. A session's
      // prep covers one paper, so letting it stamp the lab cursor would mark a
      // whole lab caught up on the strength of one meeting's reading — and
      // bury every other paper's delta behind a cursor that never saw it.
      const addresses =
        args.labId !== undefined
          ? digest.labId === args.labId && digest.boundary === "since-away"
          : args.paperId === undefined
            ? digest.sessionId === args.sessionId
            : digest.items.some((item) => item.paperId === args.paperId);
      if (!addresses) {
        throw new ConvexError(NOT_YOUR_DIGEST);
      }
      at = digest.generatedAt;
    }

    if (args.labId !== undefined) {
      const membership = await getMembership(ctx, args.labId, userId);
      if (membership === null) {
        throw new ConvexError(NO_SUCH_TARGET);
      }
      await advanceCursor(
        ctx,
        await labCursor(ctx, userId, args.labId),
        at,
        { userId, labId: args.labId },
      );
      return null;
    }

    if (args.paperId !== undefined) {
      const paper = await ctx.db.get(args.paperId);
      const membership =
        paper === null ? null : await getMembership(ctx, paper.labId, userId);
      if (paper === null || membership === null) {
        throw new ConvexError(NO_SUCH_TARGET);
      }
      await advanceCursor(
        ctx,
        await paperCursor(ctx, userId, args.paperId),
        at,
        { userId, labId: paper.labId, paperId: args.paperId },
      );
      return null;
    }

    const sessionId = args.sessionId;
    if (sessionId === undefined) {
      throw new ConvexError("Mark one paper, session or lab as seen.");
    }
    const session = await ctx.db.get(sessionId);
    const membership =
      session === null ? null : await getMembership(ctx, session.labId, userId);
    if (session === null || membership === null) {
      throw new ConvexError(NO_SUCH_TARGET);
    }
    await advanceCursor(
      ctx,
      await sessionCursor(ctx, userId, sessionId),
      at,
      { userId, labId: session.labId, sessionId },
    );
    return null;
  },
});

/* -------------------------------------------------------------------------
 * The boundary job
 * ---------------------------------------------------------------------- */

/**
 * Build a session's digest at one of its boundaries.
 *
 * ## The argument shape is the contract
 *
 * `{ sessionId, boundary, expectedScheduledAt }` is frozen: every call site in
 * `convex/sessions.ts` passes all three, and `expectedScheduledAt` is the
 * session's meeting time *as it stood when the job was queued*. It is here
 * because a scheduled job cannot be trusted to still be wanted. Cancellation
 * is best-effort — `scheduler.cancel` races a job that has already started —
 * so the argument carries what the job was armed for and the handler decides.
 *
 * ## The guard
 *
 * Before writing anything, re-read the session and bail if the world moved:
 *
 * - `session-prep` — bail unless `status === "scheduled"` and
 *   `scheduledAt === expectedScheduledAt`. A meeting that was moved, started
 *   early, or called off has no T−2h prep left to deliver, and the job aimed
 *   at the old time may still fire.
 * - `session-start` — bail unless `status === "live"`. The refresh belongs to
 *   a meeting that is actually happening; one that ended or was rolled back
 *   before the job ran should get nothing.
 *
 * Every caller is the scheduler; nothing reads a result.
 */
export const buildSessionPrep = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    boundary: sessionBoundary,
    /** The session's `scheduledAt` at the moment this job was queued. */
    expectedScheduledAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (session === null) {
      return null;
    }
    if (args.boundary === "session-prep") {
      if (
        session.status !== "scheduled" ||
        session.scheduledAt !== args.expectedScheduledAt
      ) {
        return null;
      }
    } else if (session.status !== "live") {
      return null;
    }

    // The presenter's brief rides the same boundary rather than carrying a
    // scheduled job of its own. `convex/sessions.ts` already keeps exactly one
    // handle per session and already re-aims it when a meeting moves and calls
    // it off when a meeting is cancelled; a second handle would be a second
    // field and a second way for a lab that rescheduled to get an artifact for
    // the time it moved away from. The guard above has just established that
    // this boundary is still wanted, and the brief inherits that — then checks
    // it again for itself, because `runAfter(0)` is a separate transaction.
    //
    // Prep only. A brief is read *before* the meeting; by the session-start
    // boundary the presenter is already standing up, and re-assembling then
    // would replace the agenda they walked in with.
    //
    // Queued rather than built inline so that an assembly which fails, or a
    // paper with nothing in its margin, cannot cost the lab the digests below.
    // Everything after this point is digest policy and the brief does not
    // inherit any of it.
    if (args.boundary === "session-prep") {
      await ctx.scheduler.runAfter(0, internal.briefs.buildForSession, {
        sessionId: args.sessionId,
        expectedScheduledAt: args.expectedScheduledAt,
      });

      // And the lab's Slack channel, if it has one — the third rider on this
      // one boundary handle, for the same reason the brief is the second.
      //
      // What it posts is *not* one of the digests written below, and must never
      // become one. A `digests` row is one person's mail: its delta is computed
      // against that member's own cursor and its lines are phrased with "you",
      // so a channel post built from one — or from the union of all of them —
      // would publish exactly the attention data the privacy constitution
      // refuses to store an aggregate of. `slack.boundaryPayload` re-reads the
      // paper and posts the part that is a fact about the margin rather than
      // about anybody: where two people have landed on the same passage.
      if (slackIsConfigured(await ctx.db.get(session.labId))) {
        await ctx.scheduler.runAfter(0, internal.slack.deliverBoundary, {
          sessionId: args.sessionId,
          expectedScheduledAt: args.expectedScheduledAt,
        });
      }
    }

    const paper = await ctx.db.get(session.paperId);
    if (paper === null) {
      return null;
    }

    // Privacy is the index, not a filter: `by_paper_and_visibility` at "lab"
    // cannot return a private annotation. Newest-first so the cap keeps the
    // live end of the conversation.
    const visible = await ctx.db
      .query("annotations")
      .withIndex("by_paper_and_visibility", (q) =>
        q.eq("paperId", session.paperId).eq("visibility", "lab"),
      )
      .order("desc")
      .take(POOL_LIMIT);

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_lab", (q) => q.eq("labId", session.labId))
      .collect();
    const memberIds = new Set(memberships.map((one) => one.userId));

    // Membership is the filter, not the annotation's `labId`. A note written by
    // somebody who has since left the lab — or by an author who was never in it
    // — is not news about a colleague, because there is no colleague. It cannot
    // be a delta and it cannot be the far half of a collision.
    const live = visible.filter(
      (a) => a.deletedAt === undefined && memberIds.has(a.memberId),
    );
    if (live.length === 0) {
      return null;
    }

    // Author display names, resolved once for the whole run.
    const names = new Map<Id<"users">, string>();
    for (const authorId of new Set(live.map((a) => a.memberId))) {
      const user = await ctx.db.get(authorId);
      names.set(authorId, user?.name ?? user?.email ?? "Someone");
    }

    const pool: DigestAnnotation<Id<"papers">, Id<"annotations">, Id<"users">>[] =
      live.map((a) => ({
        id: a._id,
        paperId: a.paperId,
        memberId: a.memberId,
        memberName: names.get(a.memberId) ?? "Someone",
        type: a.type,
        pageIndex: a.anchor.pageIndex,
        start: a.anchor.start,
        end: a.anchor.end,
        quote: a.anchor.quote,
        createdAt: a._creationTime,
      }));

    // One detection pass for the whole lab. It is quadratic in the pool and
    // does not depend on the recipient — `assembleDigest` does the
    // recipient-relative filtering against this set — so running it per member
    // was the same answer computed a dozen times.
    const collisions = detectCollisions(pool);

    // What this session has already *delivered* to each member, annotation by
    // annotation. Two boundaries an hour apart must not repeat themselves, and
    // a member who never opened the paper in between has no cursor movement to
    // say so — but the rule has to be "don't repeat", not "start from the last
    // digest". The cap withholds real gold, and flooring the window at the
    // previous `generatedAt` threw away everything it withheld: an annotation
    // that lost the cap at T−2h could never win it at session start. So the
    // window stays wide (the member's own cursor) and the exclusion is exact.
    const delivered = new Map<Id<"users">, Set<Id<"annotations">>>();
    for (const previous of await ctx.db
      .query("digests")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect()) {
      let seen = delivered.get(previous.userId);
      if (seen === undefined) {
        seen = new Set<Id<"annotations">>();
        delivered.set(previous.userId, seen);
      }
      for (const item of previous.items) {
        for (const annotationId of item.annotationIds) seen.add(annotationId);
      }
    }

    const now = Date.now();
    const paperTitles = new Map<Id<"papers">, string>([
      [paper._id, paper.title],
    ]);

    for (const membership of memberships) {
      const cursor = await paperCursor(ctx, membership.userId, session.paperId);
      const since =
        cursor?.lastSeenAt ??
        Math.max(membership.joinedAt, now - NO_CURSOR_LOOKBACK_MS);
      const seen = delivered.get(membership.userId);

      const delta = pool.filter(
        (a) =>
          a.memberId !== membership.userId &&
          a.createdAt > since &&
          seen?.has(a.id) !== true,
      );
      if (delta.length === 0) {
        continue;
      }

      const { items, droppedCount } = assembleDigest({
        recipientId: membership.userId,
        pool,
        delta,
        paperTitles,
        collisions,
      });
      if (items.length === 0) {
        continue;
      }

      await ctx.db.insert("digests", {
        userId: membership.userId,
        labId: session.labId,
        sessionId: args.sessionId,
        boundary: args.boundary,
        generatedAt: now,
        droppedCount: droppedCount > 0 ? droppedCount : undefined,
        items,
      });
    }

    return null;
  },
});

/* -------------------------------------------------------------------------
 * Solo recall: the one lab where your past self is the colleague
 * ---------------------------------------------------------------------- */

/**
 * The users who are members of this lab *right now*.
 *
 * Every digest path filters its pool through this set, and that is the only
 * thing standing between "a colleague wrote this" and a row whose author is
 * not in the lab at all — someone who left, or content seeded under an author
 * that was never a member. Membership is the fact; an annotation's `labId` is
 * a place it was written, and the two stop agreeing the moment somebody walks
 * out. A digest that reported a departed author's note as lab activity would
 * be telling a member that a colleague is still writing, which is the one
 * thing a digest is for and so the one thing it must not invent.
 */
async function labMemberIds(
  ctx: QueryCtx | MutationCtx,
  labId: Id<"labs">,
): Promise<Set<Id<"users">>> {
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_lab", (q) => q.eq("labId", labId))
    .collect();
  return new Set(memberships.map((membership) => membership.userId));
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * When a recalled note was written, said the way a person would say it.
 *
 * Two registers, and the boundary between them is `RELATIVE_WHEN_LIMIT_MS`:
 * recent enough to count in weeks, or far enough back to have a month's name.
 * A recall line that said only "earlier" would be the thing this whole feature
 * is against — the point of handing somebody their own note back is that they
 * can place it in the work they were doing at the time, and "in March" does
 * that in two words.
 *
 * UTC, deliberately. The deployment's clock is UTC and this string is written
 * into a stored row, so a local-time reading would make the same note render
 * differently depending on which machine rebuilt the digest. The cost is a
 * note written late on the last night of a month naming the next one.
 */
export function recallWhen(at: number, now: number): string {
  const age = Math.max(0, now - at);
  if (age < RELATIVE_WHEN_LIMIT_MS) {
    const weeks = Math.floor(age / WEEK_MS);
    if (weeks === 0) return "this week";
    return weeks === 1 ? "last week" : `${weeks} weeks ago`;
  }
  const then = new Date(at);
  const month = MONTH_NAMES[then.getUTCMonth()];
  if (month === undefined) {
    return `on ${then.toISOString().slice(0, 10)}`;
  }
  const monthsBack =
    (new Date(now).getUTCFullYear() - then.getUTCFullYear()) * 12 +
    (new Date(now).getUTCMonth() - then.getUTCMonth());
  return monthsBack >= 12 ? `in ${month} ${then.getUTCFullYear()}` : `in ${month}`;
}

/**
 * The ontology type as a noun, with its article.
 *
 * Derived from the token rather than kept as a table: every one of the seven
 * reads correctly with its hyphens opened out, so a second copy of the noun
 * list would be a second thing to keep in step with the schema for no benefit.
 */
function nounFor(type: string): string {
  const noun = type.replace(/-/g, " ");
  return `${/^[aeiou]/.test(noun) ? "an" : "a"} ${noun}`;
}

function elideQuote(quote: string): string {
  const trimmed = quote.trim().replace(/\s+/g, " ");
  if (trimmed.length <= MAX_RECALL_QUOTE_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_RECALL_QUOTE_CHARS - 1).trimEnd()}…`;
}

/**
 * A one-member lab's digest: what *you* wrote, handed back to you.
 *
 * The since-away digest everywhere else in this file is built out of other
 * people — its delta is explicitly `memberId !== recipient`. In a lab of one
 * that delta is empty forever, so the card never appears and the product's
 * whole claim about memory is unreachable for the person who has not brought
 * anybody with them yet. This is the same boundary answering the same
 * question with the only colleague available: the version of you that was
 * reading this paper a month ago.
 *
 * ## What it is allowed to say
 *
 * `recalled` is your own notes old enough to be memory (`catchUp` picks that
 * set); `fresh` is what you have written in the window this arrival covers.
 * Nothing in `fresh` is ever quoted back — a digest that reads out the
 * paragraph you typed on Tuesday is an echo, and an echo is how a reader
 * learns to stop reading the card.
 *
 * ## Two tiers, and the ranking is inverted on purpose
 *
 * A recalled note whose passage you have annotated *again* leads: that is the
 * shape the feature exists for, the "you already thought about this exact
 * sentence" case, and it is the only tier that can say `on this same passage`
 * truthfully. Everything else coalesces per paper.
 *
 * Within both tiers the order is **oldest first**, which is the opposite of
 * every other ranking in this module. Recency wins elsewhere because those
 * digests report news, and the newest news is the most useful. This one
 * reports the opposite of news: between two notes you have forgotten, the
 * older is the one you are less likely to still be holding, so when the cap
 * cuts it should cut the one nearest to memory rather than the one furthest
 * from it.
 */
export function assembleRecall<
  P extends string,
  A extends string,
  U extends string,
>(input: {
  /** Your own notes, old enough to be worth handing back. */
  recalled: readonly DigestAnnotation<P, A, U>[];
  /** Your own notes from the window this arrival covers. Cited, never quoted. */
  fresh: readonly DigestAnnotation<P, A, U>[];
  paperTitles: ReadonlyMap<P, string>;
  now: number;
  cap?: number;
}): { items: DigestItem<P, A>[]; droppedCount: number } {
  const cap = input.cap ?? MAX_DIGEST_ITEMS;
  const titleOf = (paperId: P): string =>
    input.paperTitles.get(paperId) ?? "this paper";
  const cite = (note: DigestAnnotation<P, A, U>): string => {
    const quote = elideQuote(note.quote);
    return quote.length > 0 ? `: “${quote}”` : "";
  };

  const oldestFirst = [...input.recalled].sort((x, y) =>
    x.createdAt !== y.createdAt
      ? x.createdAt - y.createdAt
      : x.id < y.id
        ? -1
        : x.id > y.id
          ? 1
          : 0,
  );

  const onPassage: DigestItem<P, A>[] = [];
  const promoted = new Set<A>();
  for (const note of oldestFirst) {
    // `anchorOverlap` is the same passage test the collision detector uses, so
    // "the same passage" means here exactly what it means in a digest line
    // about two members. It refuses across papers by construction.
    const again = input.fresh.find(
      (recent) => recent.id !== note.id && anchorOverlap(note, recent) !== null,
    );
    if (again === undefined) continue;
    promoted.add(note.id);
    onPassage.push({
      kind: "coalesced",
      paperId: note.paperId,
      // Both halves, the way a collision cites both of its own: the line
      // asserts a relationship between the old note and the new one, and a
      // citation that named only one of them would be asserting more than it
      // shows.
      annotationIds: [note.id, again.id],
      line: `You left ${nounFor(note.type)} on this same passage ${recallWhen(
        note.createdAt,
        input.now,
      )} — ${titleOf(note.paperId)}, p. ${note.pageIndex + 1}${cite(note)}`,
    });
  }

  const byPaper = new Map<P, DigestAnnotation<P, A, U>[]>();
  for (const note of oldestFirst) {
    if (promoted.has(note.id)) continue;
    const bucket = byPaper.get(note.paperId);
    if (bucket === undefined) byPaper.set(note.paperId, [note]);
    else bucket.push(note);
  }

  const perPaper: DigestItem<P, A>[] = [];
  const papers = [...byPaper.entries()].sort((x, y) => {
    const xAt = x[1][0]?.createdAt ?? 0;
    const yAt = y[1][0]?.createdAt ?? 0;
    return xAt !== yAt ? xAt - yAt : x[0] < y[0] ? -1 : 1;
  });
  for (const [paperId, notes] of papers) {
    const oldest = notes[0];
    if (oldest === undefined) continue;
    const when = recallWhen(oldest.createdAt, input.now);
    const opening =
      notes.length === 1
        ? `You left ${nounFor(oldest.type)} on ${titleOf(paperId)} ${when}`
        : `You left ${notes.length} notes on ${titleOf(paperId)}, the oldest ${when}`;
    perPaper.push({
      kind: "coalesced",
      paperId,
      annotationIds: notes.map((note) => note.id),
      line: `${opening} — p. ${oldest.pageIndex + 1}${cite(oldest)}`,
    });
  }

  // Count the notes behind the lines that didn't fit, not the lines — and only
  // recalled ones, since the fresh half of a passage line was never news.
  const all = [...onPassage, ...perPaper];
  const recalledIds = new Set<A>(input.recalled.map((note) => note.id));
  const withheld = new Set<A>();
  for (const item of all.slice(cap)) {
    for (const id of item.annotationIds) {
      if (recalledIds.has(id)) withheld.add(id);
    }
  }
  return { items: all.slice(0, cap), droppedCount: withheld.size };
}

/**
 * Does this lab have exactly one member?
 *
 * The client needs the answer because a solo digest is a different object from
 * a since-away one and must not be introduced with the other's words — "since
 * you were away" over your own March notes is a small lie the reader will
 * catch immediately. It is counted from `memberships` rather than read off
 * `labs.memberCount` so the page and `catchUp` cannot disagree: the digest is
 * built from the membership rows, and a denormalized counter that drifted
 * would have the inbox captioned one way and filled the other.
 *
 * Two rows is all it takes to answer, so that is all it reads.
 */
export const isSolo = query({
  args: { labId: v.id("labs") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await requireMembership(ctx, args.labId);
    const some = await ctx.db
      .query("memberships")
      .withIndex("by_lab", (q) => q.eq("labId", args.labId))
      .take(2);
    return some.length === 1;
  },
});

/**
 * Land one arrival's assembly in the member's inbox.
 *
 * Two assemblies reach this — the ordinary one built from colleagues, and the
 * solo recall built from the member's own margin — and they must land the same
 * way, because "at most one unacknowledged since-away digest per member per
 * lab" is a property of the row rather than of what is written on it.
 *
 * `waiting` is the stale card to write over, or null to insert a fresh one.
 * Writing over it is safe for the reason the caller establishes: an
 * unacknowledged digest is also an undelivered one — `markDigestSeen` stamps
 * both at once — so nothing here rewrites something a member has already read.
 * Same row, same place in the inbox, current contents.
 */
async function writeSinceAway(
  ctx: MutationCtx,
  input: {
    userId: Id<"users">;
    labId: Id<"labs">;
    now: number;
    assembled: {
      items: DigestItem<Id<"papers">, Id<"annotations">>[];
      droppedCount: number;
    };
    waiting: Doc<"digests"> | null;
  },
): Promise<Id<"digests">> {
  const { items, droppedCount } = input.assembled;
  const dropped = droppedCount > 0 ? droppedCount : undefined;
  if (input.waiting !== null) {
    await ctx.db.patch(input.waiting._id, {
      generatedAt: input.now,
      droppedCount: dropped,
      items,
    });
    return input.waiting._id;
  }
  return await ctx.db.insert("digests", {
    userId: input.userId,
    labId: input.labId,
    boundary: "since-away",
    generatedAt: input.now,
    droppedCount: dropped,
    items,
  });
}

/* -------------------------------------------------------------------------
 * The third boundary: coming back
 * ---------------------------------------------------------------------- */

/**
 * Build this member's "since you were away" digest, if they have been away.
 *
 * ## Why a mutation the client calls, and not a job
 *
 * The other two boundaries are on a calendar, so a scheduler can hold them.
 * This one is a fact about a person — they were gone, and now they are back —
 * and the server has no way to learn it in advance. It could only be polled,
 * and polling for "who is away" means keeping the thing the privacy
 * constitution forbids: a record of when each member was last around. There
 * isn't one, and there is not going to be one. So the trigger is the arrival
 * itself. The lab dashboard calls this when it mounts, most calls decide
 * nothing needs building, and the decision is `lib/digest/since-away.ts` —
 * pure, and tested there.
 *
 * ## What an arrival is allowed to write
 *
 * A digest, and nothing else. **It does not move the cursor.** A cursor that
 * advanced because a page mounted would be dwell tracking wearing an
 * acknowledgement's clothes — and it would eat the very delta it claims to
 * report, since the next digest starts where the cursor stopped. The cursor
 * moves in `markSeen`, when the member presses "I'm caught up", and the stamp
 * is this digest's `generatedAt`.
 *
 * The digest row does carry one new fact — that this member opened the lab at
 * `generatedAt`. That is as narrow as the trigger can be made: the row lives in
 * the member's own inbox, `listMine` is pinned to the caller's id, and nothing
 * anywhere aggregates digests or reads another member's. No one but them can
 * learn it.
 *
 * ## A lab of one
 *
 * The delta below is `memberId !== you`, which in a one-member lab is empty
 * forever: the digest that carries this product's claim about memory could
 * never fire for the person working alone. So when the lab has exactly one
 * member — counted from `memberships` at read time, never assumed from a
 * denormalized field — the colleague is your past self, and the rule is:
 *
 * > your own notes on the papers you have written on since your last "I'm
 * > caught up", excluding anything written inside that window *and* anything
 * > younger than `SOLO_RECALL_MIN_AGE_MS`.
 *
 * Both halves of that exclusion are load-bearing. The window keeps this visit's
 * writing out, so the note you just typed cannot come back as a discovery; the
 * age floor keeps last Tuesday out, because a digest is worth reading only when
 * what it hands over is something you had stopped holding. The trigger is
 * unchanged and still the ledger: a solo lab's recall fires because *you* have
 * been writing on a paper again, which is the moment "you already wrote about
 * this in March" is worth saying and the only moment it is not nagging.
 *
 * The second member arriving takes all of this away again with no migration and
 * no flag: the count is two, the delta is the ordinary one, and the digests
 * already sitting in the inbox still read as what they were.
 *
 * ## Idempotent by construction
 *
 * At most one unacknowledged since-away digest exists per member per lab. A
 * revisit finds it and returns it; a revisit an hour later rebuilds it *in
 * place*, over the same row, so the card can neither duplicate nor go stale
 * while it waits. Once acknowledged, the cursor has moved past its window and
 * the next one starts from there.
 *
 * Returns the digest's id when there is one to show, so a caller can tell
 * "built" from "nothing to say" — the UI reads it out of `listMine` either way.
 */
export const catchUp = mutation({
  args: { labId: v.id("labs") },
  returns: v.union(v.id("digests"), v.null()),
  handler: async (ctx, args) => {
    const membership = await requireMembership(ctx, args.labId);
    const userId = membership.userId;
    const now = Date.now();

    // Deduped against exactly the window the inbox can show. A since-away
    // digest that has fallen out of the newest `INBOX_PAGE` is one the member
    // cannot see, so building a fresh one is not a duplicate — and bounding
    // the scan here keeps an arrival's cost flat in a busy inbox.
    const recent = await ctx.db
      .query("digests")
      .withIndex("by_user_and_lab", (q) =>
        q.eq("userId", userId).eq("labId", args.labId),
      )
      .order("desc")
      .take(INBOX_PAGE);
    const waiting =
      recent.find(
        (digest) =>
          digest.boundary === "since-away" &&
          digest.acknowledgedAt === undefined,
      ) ?? null;

    const cursor = await labCursor(ctx, userId, args.labId);
    const plan = planSinceAway({
      now,
      joinedAt: membership.joinedAt,
      cursorAt: cursor?.lastSeenAt ?? null,
      waiting: waiting === null ? null : { generatedAt: waiting.generatedAt },
      lookbackMs: NO_CURSOR_LOOKBACK_MS,
    });
    if (plan.kind !== "build") {
      return plan.kind === "reuse" && waiting !== null ? waiting._id : null;
    }

    // The ledger names the field. A paper nobody has written on since the
    // member's cursor cannot produce a line, so it is not worth a read — and
    // an empty answer here is the "nothing happened while you were gone" case,
    // which is most absences.
    const beats = await ctx.db
      .query("events")
      .withIndex("by_lab_and_at", (q) =>
        q.eq("labId", args.labId).gt("at", plan.since),
      )
      .order("desc")
      .take(SINCE_AWAY_EVENT_SCAN);
    const paperIds = papersToScan<Id<"papers">>(beats, SINCE_AWAY_PAPERS);
    if (paperIds.length === 0) {
      return waiting?._id ?? null;
    }

    // Who is actually in this lab, right now. Two facts come out of one read:
    // which authors a digest may call colleagues at all, and whether there are
    // any — a lab of one is where the recall boundary takes over.
    const memberIds = await labMemberIds(ctx, args.labId);
    const solo = memberIds.size === 1;

    const names = new Map<Id<"users">, string>();
    const paperTitles = new Map<Id<"papers">, string>();
    const pool: DigestAnnotation<Id<"papers">, Id<"annotations">, Id<"users">>[] =
      [];
    const collisions: Collision<
      Id<"papers">,
      Id<"annotations">,
      Id<"users">
    >[] = [];

    for (const paperId of paperIds) {
      const paper = await ctx.db.get(paperId);
      // The ids came out of this lab's own ledger, so the lab check is belt
      // and braces — but a pool is one query away from a member's annotations
      // and that is not a place to rely on an invariant holding elsewhere.
      if (paper === null || paper.labId !== args.labId) {
        continue;
      }

      // Privacy is the index, not a filter, exactly as in the session job:
      // `by_paper_and_visibility` at "lab" cannot return a private annotation.
      const visible = await ctx.db
        .query("annotations")
        .withIndex("by_paper_and_visibility", (q) =>
          q.eq("paperId", paperId).eq("visibility", "lab"),
        )
        .order("desc")
        .take(SINCE_AWAY_POOL_LIMIT);
      // And membership is the second filter, for the reason the session job
      // gives: an author who is not in this lab is not a colleague, so their
      // note is neither news nor the far half of anything. In a solo lab it is
      // also what keeps the pool to one person's own margin, which is the only
      // thing `assembleRecall` may speak in the first person about.
      const live = visible.filter(
        (a) => a.deletedAt === undefined && memberIds.has(a.memberId),
      );
      if (live.length === 0) {
        continue;
      }
      paperTitles.set(paper._id, paper.title);

      for (const authorId of new Set(live.map((a) => a.memberId))) {
        if (names.has(authorId)) continue;
        const user = await ctx.db.get(authorId);
        names.set(authorId, user?.name ?? user?.email ?? "Someone");
      }

      const paperPool = live.map((a) => ({
        id: a._id,
        paperId: a.paperId,
        memberId: a.memberId,
        memberName: names.get(a.memberId) ?? "Someone",
        type: a.type,
        pageIndex: a.anchor.pageIndex,
        start: a.anchor.start,
        end: a.anchor.end,
        quote: a.anchor.quote,
        createdAt: a._creationTime,
      }));

      // Detected per paper and concatenated, rather than in one pass over the
      // whole pool. The answer is identical — a collision is a passage, and a
      // passage is inside one paper — but the cost is not: detection is
      // quadratic, and five papers of 200 is a twenty-fifth of the work of one
      // pass over 1000. `assembleDigest` re-ranks the concatenation itself, so
      // the order the cap cuts against is unchanged.
      //
      // A lab of one has no collisions to find: the detector skips same-author
      // pairs, and every pair here has one author. Running it would be a
      // quadratic pass to reach an empty array.
      if (!solo) {
        collisions.push(...detectCollisions(paperPool));
      }
      pool.push(...paperPool);
    }

    // A lab of one: your past self is the colleague, and the whole assembly is
    // a different one. See the header — the recall floor is the older of "the
    // window this arrival covers" and `SOLO_RECALL_MIN_AGE_MS`, so a note has
    // to be behind *both* to be handed back. Behind only the age floor it could
    // be this visit's writing on an old paper; behind only the window it could
    // be Tuesday's.
    if (solo) {
      const floor = Math.min(plan.since, now - SOLO_RECALL_MIN_AGE_MS);
      const mine = pool.filter((a) => a.memberId === userId);
      const recalled = mine.filter((a) => a.createdAt <= floor);
      const fresh = mine.filter((a) => a.createdAt > plan.since);
      if (recalled.length === 0) {
        return waiting?._id ?? null;
      }
      const recall = assembleRecall({
        recalled,
        fresh,
        paperTitles,
        now,
      });
      if (recall.items.length === 0) {
        return waiting?._id ?? null;
      }
      return await writeSinceAway(ctx, {
        userId,
        labId: args.labId,
        now,
        assembled: recall,
        waiting: plan.rebuild ? waiting : null,
      });
    }

    // The one boundary that can see past a paper.
    //
    // A session's prep pools one paper and has nothing to pair across; an
    // arrival pools every paper the lab moved on while the member was gone,
    // which is the only place in the product where "two people disagreeing
    // about the same claim in two different papers" is a fact that exists in
    // memory rather than in somebody's head. The per-paper passes above cannot
    // find it by construction, so the scan runs once over the assembled pool.
    //
    // Privacy is unchanged and comes from the same place it always did: every
    // row in `pool` arrived through `by_paper_and_visibility` at "lab", from a
    // paper whose `labId` was re-checked above. The scan pairs what it is
    // given and adds no read of its own.
    //
    // `crossPaper.capped` says whether the scan ran out of budget before it ran
    // out of candidates. The row has nowhere to record it today — see the note
    // in `lib/digest/engine.ts` — but the cap is a named constant with the
    // reasoning attached, and the flag is on the assembled result rather than
    // swallowed here.
    const crossPaper = detectCrossPaperCollisions(pool);

    const delta = pool.filter(
      (a) => a.memberId !== userId && a.createdAt > plan.since,
    );
    if (delta.length === 0) {
      return waiting?._id ?? null;
    }

    const { items, droppedCount } = assembleDigest({
      recipientId: userId,
      pool,
      delta,
      paperTitles,
      collisions,
      crossPaper,
    });
    if (items.length === 0) {
      return waiting?._id ?? null;
    }

    return await writeSinceAway(ctx, {
      userId,
      labId: args.labId,
      now,
      assembled: { items, droppedCount },
      waiting: plan.rebuild ? waiting : null,
    });
  },
});

/* -------------------------------------------------------------------------
 * Reading your own inbox
 * ---------------------------------------------------------------------- */

/**
 * The caller's digests for one lab, newest first.
 *
 * Scoped to the caller by construction — `by_user_and_lab` starts at the
 * signed-in user's id, so there is no argument that could make this return
 * somebody else's inbox.
 */
export const listMine = query({
  args: { labId: v.id("labs") },
  returns: v.array(digestSummary),
  handler: async (ctx, args) => {
    const membership = await requireMembership(ctx, args.labId);
    const digests = await ctx.db
      .query("digests")
      .withIndex("by_user_and_lab", (q) =>
        q.eq("userId", membership.userId).eq("labId", args.labId),
      )
      .order("desc")
      .take(INBOX_PAGE);
    return digests.map((digest) => ({
      _id: digest._id,
      sessionId: digest.sessionId,
      boundary: digest.boundary,
      generatedAt: digest.generatedAt,
      deliveredAt: digest.deliveredAt,
      acknowledgedAt: digest.acknowledgedAt,
      droppedCount: digest.droppedCount,
      items: digest.items,
    }));
  },
});

/**
 * Acknowledge one of your own digests.
 *
 * `deliveredAt` is stamped here too rather than in `listMine`, because a query
 * cannot write and because "it reached them" and "they looked at it" are the
 * same moment from the server's side. Somebody else's digest is refused with
 * the same words as one that never existed.
 */
export const markDigestSeen = mutation({
  args: { digestId: v.id("digests") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const digest = await ctx.db.get(args.digestId);
    if (digest === null || digest.userId !== userId) {
      throw new ConvexError(NOT_YOUR_DIGEST);
    }
    const now = Date.now();
    await ctx.db.patch(args.digestId, {
      deliveredAt: digest.deliveredAt ?? now,
      acknowledgedAt: now,
    });
    return null;
  },
});
