import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { getMembership, requireMembership, requireUserId } from "./lib/authz";
import {
  assembleDigest,
  detectCollisions,
  type DigestAnnotation,
} from "../lib/digest/engine";

/**
 * Boundary-delivered digests.
 *
 * The architecture decision puts delivery at boundaries and nowhere else: a
 * prep digest computed two hours before a session, a refresh at session start,
 * and an in-app "since you were away" per paper. There are no per-write
 * notifications, ever.
 *
 * This module is the plumbing — reads, authorization, writes. The policy it
 * runs is `lib/digest/engine.ts`, which is pure and unit-tested: deterministic
 * typed-pair collision detection over overlapping passage anchors, gold pairs
 * promoted to their own line, everything else coalesced to one line per paper,
 * hard cap five.
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

/* -------------------------------------------------------------------------
 * Validators
 * ---------------------------------------------------------------------- */

/**
 * The two boundaries that arrive as a scheduled job. The `digests` table has a
 * third, `since-away`, which is computed when a member opens a paper rather
 * than queued in advance — so it is not a value this argument ever takes.
 */
const sessionBoundary = v.union(
  v.literal("session-prep"),
  v.literal("session-start"),
);

const digestItem = v.object({
  kind: v.union(v.literal("collision"), v.literal("coalesced")),
  paperId: v.id("papers"),
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
 * Mark a paper or a session as looked at.
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
 * Exactly one of `paperId` / `sessionId` — a cursor addresses one thing.
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
 * caller's own, and must actually address the paper or session being stamped;
 * otherwise a stale acknowledgement could be pointed at an unrelated cursor.
 *
 * Without `digestId` the stamp is `now`, which is what an acknowledgement of
 * something other than a digest would mean.
 */
export const markSeen = mutation({
  args: {
    paperId: v.optional(v.id("papers")),
    sessionId: v.optional(v.id("sessions")),
    /** The digest this acknowledgement is of; its `generatedAt` is the stamp. */
    digestId: v.optional(v.id("digests")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if ((args.paperId === undefined) === (args.sessionId === undefined)) {
      throw new ConvexError("Mark either a paper or a session as seen.");
    }
    const userId = await requireUserId(ctx);

    let at = Date.now();
    if (args.digestId !== undefined) {
      const digest = await ctx.db.get(args.digestId);
      if (digest === null || digest.userId !== userId) {
        throw new ConvexError(NOT_YOUR_DIGEST);
      }
      const addresses =
        args.paperId === undefined
          ? digest.sessionId === args.sessionId
          : digest.items.some((item) => item.paperId === args.paperId);
      if (!addresses) {
        throw new ConvexError(NOT_YOUR_DIGEST);
      }
      at = digest.generatedAt;
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
      throw new ConvexError("Mark either a paper or a session as seen.");
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
    const live = visible.filter((a) => a.deletedAt === undefined);
    if (live.length === 0) {
      return null;
    }

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_lab", (q) => q.eq("labId", session.labId))
      .collect();

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
