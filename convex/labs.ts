import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getMembership, requireMembership, requireUserId } from "./lib/authz";
import { recordEvent } from "./lib/ledger";
import { membershipRole } from "./schema";

const MAX_LAB_NAME_LENGTH = 120;

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
      throw new Error("A lab needs a name.");
    }
    if (name.length > MAX_LAB_NAME_LENGTH) {
      throw new Error(`Lab names are limited to ${MAX_LAB_NAME_LENGTH} characters.`);
    }
    const institution = args.institution?.trim();

    const labId = await ctx.db.insert("labs", {
      name,
      ...(institution ? { institution } : {}),
      createdBy: userId,
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
      meta: { name },
    });
    await recordEvent(ctx, {
      labId,
      type: "member.joined",
      actorId: userId,
      subjectUserId: userId,
      meta: { role: "pi" },
    });

    return labId;
  },
});

/** Every lab the caller belongs to, oldest membership first. Drives the sidebar switcher. */
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
      const members = await ctx.db
        .query("memberships")
        .withIndex("by_lab", (q) => q.eq("labId", lab._id))
        .collect();
      labs.push({
        _id: lab._id,
        name: lab.name,
        institution: lab.institution,
        role: membership.role,
        memberCount: members.length,
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
    const members = await ctx.db
      .query("memberships")
      .withIndex("by_lab", (q) => q.eq("labId", lab._id))
      .collect();

    return {
      _id: lab._id,
      name: lab.name,
      institution: lab.institution,
      createdAt: lab._creationTime,
      role: membership.role,
      memberCount: members.length,
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
    }),
  ),
  handler: async (ctx, args) => {
    await requireMembership(ctx, args.labId);

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
