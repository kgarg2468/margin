import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/**
 * The single write path into the Ledger.
 *
 * `events` is append-only: this module inserts, and nothing anywhere patches
 * or deletes. Keeping the insert in one place is what makes that claim
 * auditable rather than aspirational — and `eslint.config.mjs` enforces both
 * halves of it.
 */

/** `Omit` collapses a union; this preserves one member per event type. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/**
 * An event as callers write it: the discriminated union from the schema minus
 * the system fields and `at`, which only this module is allowed to stamp.
 * Because it stays a union, TypeScript rejects a payload that belongs to a
 * different `type` — the whole point of typing the ledger.
 */
export type LedgerEvent = DistributiveOmit<
  Doc<"events">,
  "_id" | "_creationTime" | "at"
>;

export async function recordEvent(
  ctx: MutationCtx,
  event: LedgerEvent,
): Promise<Id<"events">> {
  return await ctx.db.insert("events", { ...event, at: Date.now() });
}
