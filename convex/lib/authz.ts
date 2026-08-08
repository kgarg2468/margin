import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * Authorization helpers.
 *
 * Rule for every function in this backend: a `labId` arriving from the client
 * is a *claim*, not a fact. Nothing reads or writes lab-scoped data without
 * first resolving that claim against the `memberships` table for the
 * currently signed-in user. These helpers are the only sanctioned way to do
 * that, so the check is impossible to forget by accident.
 */

/** The signed-in user's id, or throw. Use in anything that isn't public. */
export async function requireUserId(
  ctx: QueryCtx | MutationCtx,
): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new ConvexError("Not signed in.");
  }
  return userId;
}

/** The caller's membership row for `labId`, or `null` if they have none. */
export async function getMembership(
  ctx: QueryCtx | MutationCtx,
  labId: Id<"labs">,
  userId: Id<"users">,
): Promise<Doc<"memberships"> | null> {
  return await ctx.db
    .query("memberships")
    .withIndex("by_lab_and_user", (q) =>
      q.eq("labId", labId).eq("userId", userId),
    )
    .unique();
}

/** Membership or bust. Throws for both "no such lab" and "not a member" so the two are indistinguishable to a prober. */
export async function requireMembership(
  ctx: QueryCtx | MutationCtx,
  labId: Id<"labs">,
): Promise<Doc<"memberships">> {
  const userId = await requireUserId(ctx);
  const membership = await getMembership(ctx, labId, userId);
  if (membership === null) {
    throw new ConvexError("You are not a member of this lab.");
  }
  return membership;
}

/** Membership with the `pi` role, or throw. */
export async function requirePi(
  ctx: QueryCtx | MutationCtx,
  labId: Id<"labs">,
): Promise<Doc<"memberships">> {
  const membership = await requireMembership(ctx, labId);
  if (membership.role !== "pi") {
    throw new ConvexError("Only the lab's PI can do that.");
  }
  return membership;
}
