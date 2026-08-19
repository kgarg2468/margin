import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import {
  getMembership,
  requireMembership,
  requirePi,
  requireUserId,
} from "./lib/authz";
import { recordEvent } from "./lib/ledger";
import { membershipRole } from "./schema";

const MAX_LAB_NAME_LENGTH = 120;

const SOLE_PI_MESSAGE =
  "A lab has to have a PI. Make someone else the PI before this one steps back.";

/** Create a lab. The creator becomes its PI; there is no lab without a member. */
export const createLab = mutation({
  args: {
    name: v.string(),
    institution: v.optional(v.string()),
  },
  returns: v.id("labs"),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);

    const name = args.name.trim();
    if (name.length === 0) {
      throw new ConvexError("A lab needs a name.");
    }
    if (name.length > MAX_LAB_NAME_LENGTH) {
      throw new ConvexError(
        `Lab names are limited to ${MAX_LAB_NAME_LENGTH} characters.`,
      );
    }
    const institution = args.institution?.trim();

    const labId = await ctx.db.insert("labs", {
      name,
      ...(institution ? { institution } : {}),
      createdBy: userId,
      memberCount: 1,
    });

    await ctx.db.insert("memberships", {
      labId,
      userId,
      role: "pi",
      joinedAt: Date.now(),
    });

    await recordEvent(ctx, {
      labId,
      type: "lab.created",
      actorId: userId,
      name,
    });
    await recordEvent(ctx, {
      labId,
      type: "member.joined",
      actorId: userId,
      subjectUserId: userId,
      role: "pi",
      via: "founding",
    });

    return labId;
  },
});

/**
 * Every lab the caller belongs to, oldest membership first. Drives the sidebar
 * switcher, so it reads the denormalized `memberCount` rather than counting
 * memberships per lab — that was one extra query per lab on every render.
 */
export const getMyLabs = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("labs"),
      name: v.string(),
      institution: v.optional(v.string()),
      role: membershipRole,
      memberCount: v.number(),
      joinedAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    const labs = [];
    for (const membership of memberships) {
      const lab = await ctx.db.get(membership.labId);
      if (lab === null) {
        continue;
      }
      labs.push({
        _id: lab._id,
        name: lab.name,
        institution: lab.institution,
        role: membership.role,
        memberCount: lab.memberCount,
        joinedAt: membership.joinedAt,
      });
    }

    labs.sort((a, b) => a.joinedAt - b.joinedAt);
    return labs;
  },
});

/**
 * One lab, gated on membership. Returns `null` rather than throwing when the
 * caller is not a member so a stale lab id in the client can't crash the app
 * — and so the response is identical whether the lab is missing or forbidden.
 */
export const getLab = query({
  args: { labId: v.id("labs") },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id("labs"),
      name: v.string(),
      institution: v.optional(v.string()),
      createdAt: v.number(),
      role: membershipRole,
      memberCount: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const membership = await getMembership(ctx, args.labId, userId);
    if (membership === null) {
      return null;
    }
    const lab = await ctx.db.get(args.labId);
    if (lab === null) {
      return null;
    }
    return {
      _id: lab._id,
      name: lab.name,
      institution: lab.institution,
      createdAt: lab._creationTime,
      role: membership.role,
      memberCount: lab.memberCount,
    };
  },
});

/** The lab's roster. Members-only; emails are visible to labmates and nobody else. */
export const listMembers = query({
  args: { labId: v.id("labs") },
  returns: v.array(
    v.object({
      userId: v.id("users"),
      name: v.optional(v.string()),
      email: v.optional(v.string()),
      role: membershipRole,
      joinedAt: v.number(),
      /** Saves the roster from having to cross-reference `users.viewer`. */
      isYou: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const viewer = await requireMembership(ctx, args.labId);

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_lab", (q) => q.eq("labId", args.labId))
      .collect();

    const members = [];
    for (const membership of memberships) {
      const user = await ctx.db.get(membership.userId);
      members.push({
        userId: membership.userId,
        name: user?.name,
        email: user?.email,
        role: membership.role,
        joinedAt: membership.joinedAt,
        isYou: membership.userId === viewer.userId,
      });
    }

    // PI first, then longest-standing member first.
    members.sort((a, b) => {
      if (a.role !== b.role) {
        return a.role === "pi" ? -1 : 1;
      }
      return a.joinedAt - b.joinedAt;
    });
    return members;
  },
});

/**
 * Is this membership the lab's last PI? A lab with no PI has nobody who can
 * mint invites or manage the roster, so both departure paths refuse it.
 */
async function isSolePi(
  ctx: MutationCtx,
  membership: Doc<"memberships">,
): Promise<boolean> {
  if (membership.role !== "pi") {
    return false;
  }
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_lab", (q) => q.eq("labId", membership.labId))
    .collect();
  return memberships.filter((m) => m.role === "pi").length <= 1;
}

/**
 * The one way a membership ends. Deleting the row, moving the denormalized
 * count, and writing the `member.left` fact happen in a single mutation, so
 * the roster, the counter, and the ledger can never disagree.
 */
async function endMembership(
  ctx: MutationCtx,
  membership: Doc<"memberships">,
  actorId: Id<"users">,
  reason: "left" | "removed",
): Promise<void> {
  await ctx.db.delete(membership._id);

  // Consent to be read by strangers has to stay withdrawable by the person who
  // gave it, and somebody who has left cannot reach the toggle that would
  // withdraw it — `setPaperOptIn` requires a membership, so it would answer
  // them with a refusal. Leaving the rows in place would make their notes go
  // on publishing with no way back, which is the one state this consent model
  // must not be able to reach. So leaving is the withdrawal.
  //
  // Not ledgered per paper. The departure is the fact, and it is already
  // recorded below; a row per paper would bury it in its own consequences.
  const optIns = await ctx.db
    .query("paperShareOptIns")
    .withIndex("by_user_and_lab", (q) =>
      q.eq("userId", membership.userId).eq("labId", membership.labId),
    )
    .collect();
  for (const optIn of optIns) {
    await ctx.db.delete(optIn._id);
  }

  const lab = await ctx.db.get(membership.labId);
  if (lab !== null) {
    await ctx.db.patch(lab._id, {
      memberCount: Math.max(0, lab.memberCount - 1),
    });
  }

  await recordEvent(ctx, {
    labId: membership.labId,
    type: "member.left",
    actorId,
    subjectUserId: membership.userId,
    reason,
  });
}

/**
 * Take someone off the roster. PI only.
 *
 * Idempotent: removing someone who already left is a no-op rather than an
 * error, so a stale member list can't produce a confusing failure. The last PI
 * cannot be removed — including by themselves.
 */
export const removeMember = mutation({
  args: { labId: v.id("labs"), userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requirePi(ctx, args.labId);

    const target = await getMembership(ctx, args.labId, args.userId);
    if (target === null) {
      return null;
    }
    if (await isSolePi(ctx, target)) {
      throw new ConvexError(SOLE_PI_MESSAGE);
    }

    await endMembership(ctx, target, actor.userId, "removed");
    return null;
  },
});

/**
 * Leave a lab you belong to. Anyone can, except a lab's only PI — they would
 * be locking the door behind them on everyone still inside.
 */
export const leaveLab = mutation({
  args: { labId: v.id("labs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const membership = await requireMembership(ctx, args.labId);
    if (await isSolePi(ctx, membership)) {
      throw new ConvexError(SOLE_PI_MESSAGE);
    }

    await endMembership(ctx, membership, membership.userId, "left");
    return null;
  },
});
