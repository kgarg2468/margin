import { ConvexError, v } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { getMembership, requirePi, requireUserId } from "./lib/authz";
import { recordEvent } from "./lib/ledger";

/**
 * 32 unambiguous characters: no `I`, `L`, `O`, or `0`, because these codes get
 * read aloud in lab meetings and written on whiteboards. Exactly 32 symbols
 * means a random byte maps to one with `& 31` and no modulo bias.
 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ123456789";
const CODE_LENGTH = 8;
const DEFAULT_TTL_DAYS = 14;
const MAX_TTL_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

function randomCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const byte of bytes) {
    code += CODE_ALPHABET.charAt(byte & 31);
  }
  return code;
}

/** Codes are shared by voice and by paste, so accept any casing, spaces, or dashes. */
function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

async function generateUniqueCode(ctx: MutationCtx): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = randomCode();
    const existing = await ctx.db
      .query("invites")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique();
    if (existing === null) {
      return code;
    }
  }
  throw new ConvexError("Could not generate an invite code. Please try again.");
}

/** Mint a shareable join code for a lab. PI only. */
export const createInvite = mutation({
  args: {
    labId: v.id("labs"),
    ttlDays: v.optional(v.number()),
  },
  returns: v.object({
    code: v.string(),
    expiresAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const membership = await requirePi(ctx, args.labId);

    const ttlDays = args.ttlDays ?? DEFAULT_TTL_DAYS;
    if (!Number.isFinite(ttlDays) || ttlDays <= 0 || ttlDays > MAX_TTL_DAYS) {
      throw new ConvexError(
        `Invite codes can last between 1 and ${MAX_TTL_DAYS} days.`,
      );
    }

    const code = await generateUniqueCode(ctx);
    const expiresAt = Date.now() + ttlDays * DAY_MS;

    const inviteId = await ctx.db.insert("invites", {
      code,
      labId: args.labId,
      createdBy: membership.userId,
      expiresAt,
      usedBy: [],
    });

    await recordEvent(ctx, {
      labId: args.labId,
      type: "invite.created",
      actorId: membership.userId,
      inviteId,
    });

    return { code, expiresAt };
  },
});

/** Live invite codes for a lab, so the PI can re-read one instead of minting a new one. PI only. */
export const listInvites = query({
  args: { labId: v.id("labs") },
  returns: v.array(
    v.object({
      _id: v.id("invites"),
      code: v.string(),
      expiresAt: v.number(),
      usedCount: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    await requirePi(ctx, args.labId);
    const now = Date.now();

    const invites = await ctx.db
      .query("invites")
      .withIndex("by_lab", (q) => q.eq("labId", args.labId))
      .collect();

    return invites
      .filter((invite) => invite.revokedAt === undefined && invite.expiresAt > now)
      .sort((a, b) => b._creationTime - a._creationTime)
      .map((invite) => ({
        _id: invite._id,
        code: invite.code,
        expiresAt: invite.expiresAt,
        usedCount: invite.usedBy.length,
      }));
  },
});

/**
 * Join a lab with a code. Idempotent: redeeming twice (or redeeming a code for
 * a lab you already belong to, including your own) is a no-op that reports
 * `alreadyMember` instead of erroring or duplicating a membership.
 */
export const redeemInvite = mutation({
  args: { code: v.string() },
  returns: v.object({
    labId: v.id("labs"),
    labName: v.string(),
    alreadyMember: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const code = normalizeCode(args.code);

    if (code.length !== CODE_LENGTH) {
      throw new ConvexError("Invite codes are 8 characters.");
    }

    const invite = await ctx.db
      .query("invites")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique();

    // Same message for "wrong code" and "dead code" — an invite code should
    // not be an oracle for which labs exist.
    if (
      invite === null ||
      invite.revokedAt !== undefined ||
      invite.expiresAt <= Date.now()
    ) {
      throw new ConvexError("That invite code is not valid.");
    }

    const lab = await ctx.db.get(invite.labId);
    if (lab === null) {
      throw new ConvexError("That invite code is not valid.");
    }

    const existing = await getMembership(ctx, invite.labId, userId);
    if (existing !== null) {
      return { labId: lab._id, labName: lab.name, alreadyMember: true };
    }

    await ctx.db.insert("memberships", {
      labId: invite.labId,
      userId,
      role: "member",
      joinedAt: Date.now(),
    });

    if (!invite.usedBy.includes(userId)) {
      await ctx.db.patch(invite._id, { usedBy: [...invite.usedBy, userId] });
    }

    await recordEvent(ctx, {
      labId: invite.labId,
      type: "member.joined",
      actorId: userId,
      subjectUserId: userId,
      role: "member",
      via: "invite",
    });

    return { labId: lab._id, labName: lab.name, alreadyMember: false };
  },
});
