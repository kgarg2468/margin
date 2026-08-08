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
 * rescheduled, and call it off when they are cancelled — so the contract
 * between the session lifecycle and the digest is real and exercised from the
 * day sessions ship. The body below is deliberately empty; the typed-pair
 * collision detection and the `digest_gold5` policy that fills it are the
 * subject of their own PR, and wiring the scheduler there would have meant
 * changing session code again to add it.
 */

/**
 * Build the T−2h prep digest for a session. No-op stub.
 *
 * It writes nothing — not a `digests` row, not a ledger event — so a session
 * scheduled today produces exactly the same database as one scheduled before
 * this function existed. Every caller is the scheduler; nothing reads a result.
 */
export const buildSessionPrep = internalMutation({
  args: { sessionId: v.id("sessions") },
  returns: v.null(),
  handler: async () => {
    return null;
  },
});
