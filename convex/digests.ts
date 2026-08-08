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

/**
 * Mark a paper or a session as looked at, now.
 *
 * The reader calls this on open. It is the only thing Margin stores about
 * attention, and note what it is *not*: a view count, a dwell time, or a
 * record that anyone can query about anyone else. A cursor is a single
 * timestamp, readable only by its owner's own digests, and it exists so that
 * "what's new since you last looked" has a meaning. Nothing reads it to ask
 * whether a member has kept up.
 *
 * Exactly one of `paperId` / `sessionId` — a cursor addresses one thing.
 */
export const markSeen = mutation({
  args: {
    paperId: v.optional(v.id("papers")),
    sessionId: v.optional(v.id("sessions")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if ((args.paperId === undefined) === (args.sessionId === undefined)) {
      throw new ConvexError("Mark either a paper or a session as seen.");
    }
    const userId = await requireUserId(ctx);
    const now = Date.now();

    if (args.paperId !== undefined) {
      const paper = await ctx.db.get(args.paperId);
      const membership =
        paper === null ? null : await getMembership(ctx, paper.labId, userId);
      if (paper === null || membership === null) {
        throw new ConvexError(NO_SUCH_TARGET);
      }
      const existing = await paperCursor(ctx, userId, args.paperId);
      if (existing === null) {
        await ctx.db.insert("seenCursors", {
          userId,
          labId: paper.labId,
          paperId: args.paperId,
          lastSeenAt: now,
        });
      } else {
        await ctx.db.patch(existing._id, { lastSeenAt: now });
      }
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
    const existing = await sessionCursor(ctx, userId, sessionId);
    if (existing === null) {
      await ctx.db.insert("seenCursors", {
        userId,
        labId: session.labId,
        sessionId,
        lastSeenAt: now,
      });
    } else {
      await ctx.db.patch(existing._id, { lastSeenAt: now });
    }
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

    // What this session has already told each member. Two boundaries an hour
    // apart must not deliver the same collision twice, and a member who never
    // opened the paper in between has no cursor movement to say so.
    const alreadyTold = new Map<Id<"users">, number>();
    for (const previous of await ctx.db
      .query("digests")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect()) {
      const seen = alreadyTold.get(previous.userId) ?? 0;
      if (previous.generatedAt > seen) {
        alreadyTold.set(previous.userId, previous.generatedAt);
      }
    }

    const now = Date.now();
    const paperTitles = new Map<Id<"papers">, string>([
      [paper._id, paper.title],
    ]);

    for (const membership of memberships) {
      const cursor = await paperCursor(ctx, membership.userId, session.paperId);
      const floor =
        cursor?.lastSeenAt ??
        Math.max(membership.joinedAt, now - NO_CURSOR_LOOKBACK_MS);
      const since = Math.max(floor, alreadyTold.get(membership.userId) ?? 0);

      const delta = pool.filter(
        (a) => a.memberId !== membership.userId && a.createdAt > since,
      );
      if (delta.length === 0) {
        continue;
      }

      const { items, droppedCount } = assembleDigest({
        recipientId: membership.userId,
        pool,
        delta,
        paperTitles,
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
      throw new ConvexError("That digest isn't in your inbox.");
    }
    const now = Date.now();
    await ctx.db.patch(args.digestId, {
      deliveredAt: digest.deliveredAt ?? now,
      acknowledgedAt: now,
    });
    return null;
  },
});
