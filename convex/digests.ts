import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/**
 * Boundary-delivered digests.
 *
 * The architecture decision puts delivery at boundaries and nowhere else: a
 * prep digest computed two hours before a session, a refresh at session start,
 * and an in-app "since you were away" per paper. There are no per-write
 * notifications, ever.
 *
 * What lands in this PR is the *boundary*, not the digest. Sessions schedule
 * `buildSessionPrep` when they are created, re-aim it when they are
 * rescheduled, call it off when they are cancelled, and fire it again the
 * moment the meeting starts — so the contract between the session lifecycle
 * and the digest is real and exercised from the day sessions ship. The body
 * below is deliberately empty; the typed-pair collision detection and the
 * `digest_gold5` policy that fills it are the subject of their own PR, and
 * wiring the scheduler there would have meant changing session code again to
 * add it.
 */

/**
 * The two boundaries that arrive as a scheduled job. The `digests` table has a
 * third, `since-away`, which is computed when a member opens a paper rather
 * than queued in advance — so it is not a value this argument ever takes.
 */
const sessionBoundary = v.union(
  v.literal("session-prep"),
  v.literal("session-start"),
);

/**
 * Build a session's digest at one of its boundaries. No-op stub.
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
 * ## The guard the real implementation owes
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
 * It writes nothing today — not a `digests` row, not a ledger event — so a
 * session scheduled now produces exactly the same database as one scheduled
 * before this function existed. Every caller is the scheduler; nothing reads
 * a result.
 */
export const buildSessionPrep = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    boundary: sessionBoundary,
    /** The session's `scheduledAt` at the moment this job was queued. */
    expectedScheduledAt: v.number(),
  },
  returns: v.null(),
  handler: async () => {
    return null;
  },
});
