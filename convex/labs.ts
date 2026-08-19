import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
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
 * How many opt-in rows one transaction will withdraw before handing the rest
 * to the next one.
 *
 * The bound exists because the alternative is a departure that cannot happen.
 * A member who opted a few thousand papers in would have made their own
 * removal a transaction too large to commit — and removal is the one operation
 * that must never be blocked, since the whole reason to remove somebody may be
 * that they should not be in the lab another minute.
 */
const OPT_IN_SWEEP_BATCH = 256;

/**
 * Withdraw a departing member's public-sharing consent, a batch at a time.
 *
 * **Bounded by when the departure happened, not by whether they are back.**
 *
 * The obvious protection — abort if the member has rejoined — is wrong in the
 * direction that matters. It leaves the *pre-departure* rows in place, and
 * those rows come back to life the moment the membership does: `optedInAuthors`
 * asks for a row and a membership, and after a rejoin both are true again. A
 * member who left and was later re-invited would find notes they had opened up
 * a year ago republished to strangers, having consented to nothing since.
 *
 * A cutoff gets both cases right at once. Every row stamped before the moment
 * they left is consent given before the departure, and the departure withdrew
 * it — so it goes, rejoined or not. Every row stamped after the cutoff can only
 * have been written after they came back, which makes it a fresh decision by a
 * current member, and it stays. No branch on membership at all.
 *
 * The comparison is inclusive, so a row stamped in the very millisecond of the
 * departure is withdrawn rather than kept. The boundary has to fall somewhere
 * and it falls on the side of taking consent back, because the cost of being
 * wrong the other way is somebody's writing staying public after they left.
 *
 * The stamp compared is `optedInAt`, the row's own record of when the consent
 * was given, rather than the system `_creationTime` beside it. Same fact, and
 * it belongs to the schema: a rule this load-bearing should rest on a field
 * this codebase writes and can reason about, not on metadata whose semantics
 * are the platform's to change.
 *
 * The membership row is already gone by the time this runs, so the sweep is
 * catching up to a departure that has happened rather than gating it.
 *
 * **Accepted residual.** A member who leaves and rejoins before the sweep has
 * finished has, for that window, rows that are both present and backed by a
 * live membership — so an unswept pre-departure row is briefly readable again.
 * The window is scheduler latency, not indefinite: the cutoff guarantees those
 * rows die, and it does not care that the membership came back. What the
 * member re-affirms in the meantime survives, because `shares.optIn` restamps
 * on re-affirmation. So the exposure is bounded, and it is bounded to exactly
 * the rows the member has not spoken about since returning. That is the price
 * of sweeping lazily instead of holding a departure open until every row is
 * accounted for, and it is worth paying: the alternative makes leaving a lab a
 * transaction whose size is the member's whole history.
 */
async function sweepOptIns(
  ctx: MutationCtx,
  userId: Id<"users">,
  labId: Id<"labs">,
  departedAt: number,
): Promise<void> {
  const optIns = await ctx.db
    .query("paperShareOptIns")
    .withIndex("by_user_and_lab", (q) =>
      q.eq("userId", userId).eq("labId", labId),
    )
    .take(OPT_IN_SWEEP_BATCH);

  let stale = 0;
  for (const optIn of optIns) {
    if (optIn.optedInAt <= departedAt) {
      await ctx.db.delete(optIn._id);
      stale++;
    }
  }

  // A full batch means there may be more. Counted on rows *seen* rather than
  // rows deleted: a batch that was entirely post-rejoin rows deletes nothing
  // and would otherwise stop the sweep with stale rows still behind them.
  //
  // An exactly-full last batch costs one extra scheduled mutation that finds
  // nothing, which is the cheap way to be wrong here.
  if (optIns.length === OPT_IN_SWEEP_BATCH && stale > 0) {
    await ctx.scheduler.runAfter(0, internal.labs.continueOptInSweep, {
      userId,
      labId,
      departedAt,
    });
  }
}

/**
 * The scheduled continuation of `sweepOptIns`. Internal: no caller outside.
 *
 * Carries the departure time rather than re-deriving it, because the thing it
 * must not do is treat a decision made after the rejoin as one made before it,
 * and the only way to tell those apart is the moment the member left.
 *
 * Nothing depends on this finishing. `shares.optedInAuthors` asks for current
 * membership on every public read, so a member who left has already stopped
 * being published whether or not the rest of their rows are gone.
 */
export const continueOptInSweep = internalMutation({
  args: {
    userId: v.id("users"),
    labId: v.id("labs"),
    departedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await sweepOptIns(ctx, args.userId, args.labId, args.departedAt);
    return null;
  },
});

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
  //
  // The stamp travels with the sweep because it is what separates consent
  // given before this moment from consent given after a future rejoin — see
  // `sweepOptIns` for why "has the member come back?" is the wrong question.
  await sweepOptIns(ctx, membership.userId, membership.labId, Date.now());

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
