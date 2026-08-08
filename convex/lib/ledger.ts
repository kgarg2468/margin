import type { Infer } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { eventType } from "../schema";

/**
 * The single write path into the Ledger.
 *
 * `events` is append-only: this module inserts, and nothing anywhere patches
 * or deletes. Keeping the insert in one place is what makes that claim
 * auditable rather than aspirational.
 */
export async function recordEvent(
  ctx: MutationCtx,
  event: {
    labId: Id<"labs">;
    type: Infer<typeof eventType>;
    actorId: Id<"users">;
    paperId?: Id<"papers">;
    sessionId?: Id<"sessions">;
    annotationId?: Id<"annotations">;
    subjectUserId?: Id<"users">;
    meta?: Record<string, string>;
  },
): Promise<Id<"events">> {
  return await ctx.db.insert("events", { at: Date.now(), ...event });
}
