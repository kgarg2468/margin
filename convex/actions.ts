import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { getMembership, requireUserId } from "./lib/authz";
import { recordEvent } from "./lib/ledger";
import { actionKind } from "./schema";
import { canApprove } from "./sessions";
import { isStillShared } from "./synthesis";
import {
  canRecord,
  carryForward,
  normalizeBody,
  settles,
  MAX_OUTCOME_BODY,
  type Outcome,
} from "../lib/actions";

/**
 * Discussion to action: what the lab is carrying out of the room.
 *
 * The back half of the ritual. `convex/briefs.ts` assembles what the lab
 * already wrote *into* a meeting; this records what the meeting produced —
 * something settled, something left open, or something somebody agreed to do —
 * and carries the unfinished half onto the next session about the same paper.
 * The loop closes there: this week's outcomes are what make next week's page
 * worth opening.
 *
 * This module is the plumbing: reads, authorization, writes. The policy —
 * which kinds have an open state, what carries forward, in what order — is
 * `lib/actions/outcomes.ts`, which is pure and unit-tested.
 *
 * ## An outcome is authored, not derived
 *
 * That single fact decides most of what follows. A brief line and a synthesis
 * item are rearrangements of annotations, so when their sources stop being
 * shared the line itself has to go. An outcome is a sentence a member typed
 * while the room was talking. It may *cite* a note, and that citation is
 * re-resolved on every read like every other citation in this product — but
 * "the lab settled on the 4°C protocol" does not stop being true because the
 * critique that prompted it went private. So a withdrawn citation redacts the
 * quote and leaves the outcome standing, which is the honest threshold for an
 * artifact nobody derived.
 *
 * ## What the ledger gets
 *
 * References, never prose. `action.recorded` names the row, its kind, the note
 * it cites and the member it was handed to — and none of the words. The
 * `events` table is append-only, so a body copied into it would outlive its
 * author's ability to take it back, and the text lives on the mutable `actions`
 * row where they can still reach it.
 *
 * ## Nothing here is a read receipt
 *
 * `settledAt` moves when a member says a thing is done. There is no query in
 * this file that can answer who has looked at an outcome, and `by_owner` is
 * scoped to one person — "what am I on the hook for", never "what is everybody
 * behind on".
 */

/* -------------------------------------------------------------------------
 * Bounds
 * ---------------------------------------------------------------------- */

/**
 * How many outcomes one meeting may leave behind. Far past a real hour — a lab
 * that records two hundred decisions in one session is being scripted at — and
 * a ceiling on the panel rather than a page, since the whole list is what a
 * reader came for.
 */
const MAX_OUTCOMES_PER_SESSION = 200;

/**
 * How much of a paper's history the carry-forward read considers, newest first.
 * A paper the lab has been arguing about for two years contributes the live end
 * of that argument rather than its opening months.
 */
const MAX_PAPER_OUTCOMES = 500;

/**
 * How many earlier meetings on this paper carrying-forward reaches back
 * through. The same number, and the same reasoning, as `convex/briefs.ts`: a
 * lab that has read one paper across fifty sessions has a different problem
 * than this feature solves.
 */
const PRIOR_SESSION_LIMIT = 50;

/* -------------------------------------------------------------------------
 * Shapes
 * ---------------------------------------------------------------------- */

/**
 * The note an outcome came out of, as the reader may still be shown it.
 *
 * The id is always here; the quote is not. A citation outliving its quote is
 * the honest shape for a row that recorded a real reference to something the
 * lab has since taken back — the panel says a note was cited and that it is
 * gone, rather than either quoting it anyway or pretending it never existed.
 */
const citationView = v.object({
  annotationId: v.id("annotations"),
  /** All three absent once the note stops being shared with the lab. */
  quote: v.optional(v.string()),
  authorName: v.optional(v.string()),
  pageIndex: v.optional(v.number()),
  /** True when the note has since been withdrawn or made private again. */
  withdrawn: v.boolean(),
});

const outcomeView = v.object({
  _id: v.id("actions"),
  sessionId: v.id("sessions"),
  kind: actionKind,
  body: v.string(),
  recordedAt: v.number(),
  recordedById: v.id("users"),
  recordedByName: v.string(),
  /** True when the caller wrote it — the client gates withdrawal on this. */
  mine: v.boolean(),
  ownerId: v.optional(v.id("users")),
  ownerName: v.optional(v.string()),
  settledAt: v.optional(v.number()),
  settledByName: v.optional(v.string()),
  citation: v.optional(citationView),
  /**
   * Whether the caller may settle or reopen this one, decided on the server so
   * the client never re-derives a permission. Always false for a decision,
   * which has no open state to move.
   */
  canSettle: v.boolean(),
  /** Whether the caller may hand this task to somebody else. */
  canAssign: v.boolean(),
  /** Whether the caller may take it back off the record entirely. */
  canWithdraw: v.boolean(),
});

/* -------------------------------------------------------------------------
 * Gating
 * ---------------------------------------------------------------------- */

/** Same words as `convex/sessions.ts` — a session id tells an outsider nothing. */
const NO_SUCH_SESSION = "That session is no longer on the calendar.";

async function requireSessionAccess(
  ctx: QueryCtx | MutationCtx,
  sessionId: Id<"sessions">,
): Promise<{
  session: Doc<"sessions">;
  membership: Doc<"memberships">;
  userId: Id<"users">;
}> {
  const userId = await requireUserId(ctx);
  const session = await ctx.db.get(sessionId);
  const membership =
    session === null ? null : await getMembership(ctx, session.labId, userId);
  if (session === null || membership === null) {
    throw new ConvexError(NO_SUCH_SESSION);
  }
  return { session, membership, userId };
}

/**
 * Who may move an outcome that is already on the record: whoever wrote it down,
 * whoever is on the hook for it, or whoever answers for the meeting.
 *
 * Three names because all three are the person doing the obvious thing. The
 * member who took the task on ticks it off — that is the entire point of an
 * owner. The member who wrote it down fixes what they mis-heard. And the
 * presenter or PI runs down the list at the next meeting and settles what the
 * lab has since answered, which is `canApprove` — imported from
 * `convex/sessions.ts` rather than restated, because a permission with two
 * definitions has one that is out of date.
 *
 * Everybody else in the lab reads it. An outcome is the lab's shared record of
 * what it agreed, and a record any member can quietly close is not a record.
 */
function canSteward(
  action: Doc<"actions">,
  session: Doc<"sessions">,
  membership: Doc<"memberships">,
): boolean {
  return (
    action.recordedBy === membership.userId ||
    action.ownerId === membership.userId ||
    canApprove(session, membership)
  );
}

/**
 * The one refusal for an outcome the caller may not touch, or that is no longer
 * there. Deliberately one message for both, the posture every guard in this
 * backend takes.
 */
const NO_SUCH_ACTION = "That outcome is no longer on this session's record.";

async function requireAction(
  ctx: MutationCtx,
  actionId: Id<"actions">,
): Promise<{
  action: Doc<"actions">;
  session: Doc<"sessions">;
  membership: Doc<"memberships">;
  userId: Id<"users">;
}> {
  const userId = await requireUserId(ctx);
  const action = await ctx.db.get(actionId);
  if (action === null) {
    throw new ConvexError(NO_SUCH_ACTION);
  }
  const session = await ctx.db.get(action.sessionId);
  const membership = await getMembership(ctx, action.labId, userId);
  if (session === null || membership === null) {
    throw new ConvexError(NO_SUCH_ACTION);
  }
  return { action, session, membership, userId };
}

function cleanOutcomeBody(input: string): string {
  const body = normalizeBody(input);
  if (body.trim().length === 0) {
    throw new ConvexError(
      "An outcome needs a sentence — what the lab decided, asked, or agreed to do.",
    );
  }
  if (body.length > MAX_OUTCOME_BODY) {
    throw new ConvexError(
      `An outcome tops out at ${MAX_OUTCOME_BODY} characters. This one is ${body.length}. The write-up is where the prose goes.`,
    );
  }
  return body;
}

/* -------------------------------------------------------------------------
 * Recording
 * ---------------------------------------------------------------------- */

/**
 * Write down what the room just produced.
 *
 * Any member of the lab, not only the presenter. A decision is heard by
 * everybody in the room and the person best placed to write it down is whoever
 * noticed it was one — making the presenter the only scribe would mean the
 * outcomes of a meeting are whatever the person running it had a spare hand to
 * type.
 *
 * `ownerId` is for tasks and is optional even there, because a room usually
 * agrees a thing needs doing a beat before it agrees who is doing it, and a
 * form that refuses the first without the second is a form people give up on
 * mid-meeting. It is refused outright on a decision or a question: an owner is
 * a promise to do something, and neither of those is a thing to do.
 *
 * ## The citation rule
 *
 * An outcome may only cite an annotation the lab can already see. A private
 * note is invisible to everyone but its author, so citing one would publish its
 * existence to the whole lab through the side door of a decision — and the
 * check has to be made here, on the way in, as well as on every read out.
 */
export const record = mutation({
  args: {
    sessionId: v.id("sessions"),
    kind: actionKind,
    body: v.string(),
    /** The lab-visible note this came out of, if it came out of one. */
    citedAnnotationId: v.optional(v.id("annotations")),
    /** Tasks only: the member taking it on. */
    ownerId: v.optional(v.id("users")),
  },
  returns: v.id("actions"),
  handler: async (ctx, args) => {
    const { session, userId } = await requireSessionAccess(
      ctx,
      args.sessionId,
    );
    // An outcome is a claim about an hour that happened, so the hour has to
    // have happened. `canRecord` is the shared predicate the panel reads too,
    // which is what stops the affordance and the refusal from disagreeing.
    if (!canRecord(session.status)) {
      throw new ConvexError(
        session.status === "scheduled"
          ? "That meeting hasn't happened yet. An outcome is something a discussion produced — start the session, and what it settles can be recorded as it goes."
          : "That meeting was called off, so there is no discussion for it to have produced.",
      );
    }

    const body = cleanOutcomeBody(args.body);

    if (args.ownerId !== undefined && args.kind !== "task") {
      throw new ConvexError(
        "Only a task has an owner — a decision and an open question belong to the lab.",
      );
    }
    if (
      args.ownerId !== undefined &&
      (await getMembership(ctx, session.labId, args.ownerId)) === null
    ) {
      throw new ConvexError("That person isn't in this lab.");
    }

    if (args.citedAnnotationId !== undefined) {
      const annotation = await ctx.db.get(args.citedAnnotationId);
      // `isStillShared` covers withdrawn, private, and another lab's rows in
      // one predicate — the same one `convex/synthesis.ts` and
      // `convex/briefs.ts` apply, imported rather than restated.
      if (!isStillShared(annotation, session.labId)) {
        throw new ConvexError(
          "That note isn't shared with the lab, so an outcome can't cite it.",
        );
      }
      if (annotation !== null && annotation.paperId !== session.paperId) {
        throw new ConvexError("That note is on a different paper.");
      }
    }

    const existing = await ctx.db
      .query("actions")
      .withIndex("by_session", (q) => q.eq("sessionId", session._id))
      .take(MAX_OUTCOMES_PER_SESSION);
    if (existing.length >= MAX_OUTCOMES_PER_SESSION) {
      throw new ConvexError(
        `This session is already carrying ${MAX_OUTCOMES_PER_SESSION} outcomes, which is more than a meeting produces. Settle some of them first.`,
      );
    }

    const actionId = await ctx.db.insert("actions", {
      labId: session.labId,
      sessionId: session._id,
      paperId: session.paperId,
      kind: args.kind,
      body,
      recordedBy: userId,
      ...(args.citedAnnotationId === undefined
        ? {}
        : { citedAnnotationId: args.citedAnnotationId }),
      ...(args.ownerId === undefined ? {} : { ownerId: args.ownerId }),
    });

    await recordEvent(ctx, {
      labId: session.labId,
      type: "action.recorded",
      actorId: userId,
      paperId: session.paperId,
      sessionId: session._id,
      actionId,
      kind: args.kind,
      ...(args.citedAnnotationId === undefined
        ? {}
        : { citedAnnotationId: args.citedAnnotationId }),
      ...(args.ownerId === undefined ? {} : { subjectUserId: args.ownerId }),
    });

    // No notification is raised here, and that is a deliberate gap rather than
    // an oversight. `raiseNotification` writes a row whose `annotationId` is
    // required and whose `kind` is `mention | reply` — two kinds, both
    // *addressed*, and the schema says in as many words that there is no third.
    // An assignment is a third: it points at an outcome rather than a note, and
    // every read path in `convex/notifications.ts` (`listMine`, `emailPayload`,
    // `snippetOf`, `clearNotificationsFor`, the `by_annotation` index) resolves
    // an annotation to build its snippet. Forcing it through the existing shape
    // would mail somebody "Ana mentioned you" for a task she assigned them, and
    // would collide with the one-row-per-(note, person) dedupe that mentions
    // rely on. Until notifications can carry a subject that is not an
    // annotation, an owner learns of a task on the session page, where their
    // name is on it.
    return actionId;
  },
});

/* -------------------------------------------------------------------------
 * Moving it
 * ---------------------------------------------------------------------- */

/**
 * Hand a task to somebody — or to somebody else.
 *
 * Its own mutation and its own ledger fact rather than a patch of the row,
 * because who agreed to do a thing, and when the lab stopped expecting it of
 * them, is exactly what a PI is asking about six weeks later. The row holds
 * only the current answer; the ledger holds the history.
 */
export const setOwner = mutation({
  args: { actionId: v.id("actions"), ownerId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { action, session, membership, userId } = await requireAction(
      ctx,
      args.actionId,
    );
    if (action.kind !== "task") {
      throw new ConvexError(
        "Only a task has an owner — a decision and an open question belong to the lab.",
      );
    }
    if (!canSteward(action, session, membership)) {
      throw new ConvexError(
        "Only whoever recorded this task, whoever holds it, or the presenter or PI can hand it on.",
      );
    }
    if ((await getMembership(ctx, action.labId, args.ownerId)) === null) {
      throw new ConvexError("That person isn't in this lab.");
    }
    if (action.ownerId === args.ownerId) {
      return null;
    }

    await ctx.db.patch(action._id, { ownerId: args.ownerId });
    await recordEvent(ctx, {
      labId: action.labId,
      type: "action.assigned",
      actorId: userId,
      paperId: action.paperId,
      sessionId: action.sessionId,
      actionId: action._id,
      subjectUserId: args.ownerId,
    });
    return null;
  },
});

/**
 * Say it carried no further — the question is answered, the task is done — or
 * put it back.
 *
 * One mutation taking the state it moves *to*, the shape `setVisibility` uses,
 * because the two directions are one decision a member is making about one row
 * and splitting them would be two ways to get the row into the same state.
 *
 * Reopening exists because settling is one click and a meeting is a noisy
 * place. It writes its own fact rather than deleting the settling one: the lab
 * did believe this was finished, and a memory that edits out the fortnight it
 * believed so is worth less than one that says it.
 *
 * A decision is refused in both directions. Recording a decision *is* the
 * settling of it, so a decision with a "mark it done" control beside it would
 * be a decision the lab had not yet made.
 */
export const setSettled = mutation({
  args: { actionId: v.id("actions"), settled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { action, session, membership, userId } = await requireAction(
      ctx,
      args.actionId,
    );
    if (!settles(action.kind)) {
      throw new ConvexError(
        "A decision is settled by being recorded. There is nothing left to close.",
      );
    }
    if (!canSteward(action, session, membership)) {
      throw new ConvexError(
        "Only whoever recorded this, whoever holds it, or the presenter or PI can settle it.",
      );
    }
    if ((action.settledAt !== undefined) === args.settled) {
      return null;
    }

    if (args.settled) {
      await ctx.db.patch(action._id, {
        settledAt: Date.now(),
        settledBy: userId,
      });
    } else {
      await ctx.db.patch(action._id, {
        settledAt: undefined,
        settledBy: undefined,
      });
    }

    await recordEvent(ctx, {
      labId: action.labId,
      type: args.settled ? "action.settled" : "action.reopened",
      actorId: userId,
      paperId: action.paperId,
      sessionId: action.sessionId,
      actionId: action._id,
      kind: action.kind,
    });
    return null;
  },
});

/**
 * Take it back off the record.
 *
 * Whoever wrote it down, and nobody else — the same right, and the same
 * reasoning, as withdrawing a note: an outcome is one member's account of what
 * the room produced, and a record other people can delete is not a record.
 * Somebody who thinks a decision was mis-heard reopens the conversation rather
 * than editing the minutes.
 *
 * The row goes rather than being tombstoned. Nothing is built on top of an
 * outcome — no replies, no derived artifact cites one — so leaving a redacted
 * husk in the panel would be clutter with nothing holding it up. The ledger
 * already says it existed, which is the part that cannot be rewritten.
 */
export const remove = mutation({
  args: { actionId: v.id("actions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { action, userId } = await requireAction(ctx, args.actionId);
    if (action.recordedBy !== userId) {
      throw new ConvexError(
        "Only the person who recorded an outcome can take it back.",
      );
    }

    await ctx.db.delete(action._id);
    await recordEvent(ctx, {
      labId: action.labId,
      type: "action.withdrawn",
      actorId: userId,
      paperId: action.paperId,
      sessionId: action.sessionId,
      actionId: action._id,
      kind: action.kind,
    });
    return null;
  },
});

/* -------------------------------------------------------------------------
 * Reading it back
 * ---------------------------------------------------------------------- */

/**
 * Which earlier meetings on this paper may hand something forward.
 *
 * `ended` and `synthesized` only, and never this session — the same rule, for
 * the same reasons, that `convex/briefs.ts` applies to its carried-over
 * section. A meeting that was cancelled was never held, so nothing was left
 * open at it; one still `scheduled` has not happened yet; and a session cannot
 * carry its own outcomes forward to itself.
 *
 * ## Earlier means earlier
 *
 * And it is measured on `scheduledAt`, against this session's own. Without that
 * comparison "prior" degrades to "any other held meeting about this paper",
 * which reads correctly only while a lab opens its sessions in the order it
 * held them: open February's session after March's has ended and March's
 * unanswered questions appear under *Still open from earlier meetings* — the
 * future leaking into the past, and the one failure that would make a lab stop
 * believing the panel.
 *
 * The field is `scheduledAt` rather than `_creationTime` because the question
 * is when the room met, not when somebody typed the row. `convex/briefs.ts`
 * notes that the two differ only for a session backdated after the fact and
 * declines to buy an index for the difference — and that reasoning is about
 * *ordering*, which of the qualifying meetings a cap keeps, where being off by
 * one backdated row costs a brief nothing. It does not carry to *qualifying*:
 * here the comparison is what decides whether a meeting is in the past at all,
 * and a lab that backdated a session it forgot to book, or moved one across
 * another, would have the answer silently inverted. So the filter reads
 * `scheduledAt` and the read stays in the creation order `by_paper` offers,
 * which is still the right cap — the further back a question was left open, the
 * less of it the room has.
 *
 * All three conditions are on the query rather than on its results, so the cap
 * falls on meetings that qualify. Filtering afterwards would spend the budget
 * on cancellations and on meetings still ahead of the lab, and quietly drop a
 * held meeting off the end.
 */
async function priorSessions(
  ctx: QueryCtx,
  session: Doc<"sessions">,
): Promise<Map<Id<"sessions">, number>> {
  const onPaper = await ctx.db
    .query("sessions")
    .withIndex("by_paper", (q) => q.eq("paperId", session.paperId))
    .order("desc")
    .filter((q) =>
      q.and(
        q.neq(q.field("_id"), session._id),
        q.lt(q.field("scheduledAt"), session.scheduledAt),
        q.or(
          q.eq(q.field("status"), "ended"),
          q.eq(q.field("status"), "synthesized"),
        ),
      ),
    )
    .take(PRIOR_SESSION_LIMIT);
  return new Map(onPaper.map((one) => [one._id, one.scheduledAt] as const));
}

/** Resolves each distinct person once, however many rows name them. */
function nameResolver(ctx: QueryCtx) {
  const names = new Map<Id<"users">, string>();
  return async function nameOf(userId: Id<"users">): Promise<string> {
    const known = names.get(userId);
    if (known !== undefined) {
      return known;
    }
    const user = await ctx.db.get(userId);
    const resolved = user?.name ?? user?.email ?? "A lab member";
    names.set(userId, resolved);
    return resolved;
  };
}

/**
 * One outcome as the caller may see it, with its citation re-checked against
 * the margin as it stands right now.
 *
 * The re-check is the whole provenance contract, and it happens here rather
 * than at write time only: an outcome recorded in March against a note its
 * author made private in April must stop quoting that note the moment it goes,
 * before the text crosses the wire rather than after it has landed in a
 * reader's cache. What survives is the id and the fact that something was
 * cited — which is what a redacted citation honestly is.
 */
async function toView(
  ctx: QueryCtx,
  action: Doc<"actions">,
  session: Doc<"sessions">,
  membership: Doc<"memberships">,
  nameOf: (userId: Id<"users">) => Promise<string>,
) {
  let citation = undefined;
  if (action.citedAnnotationId !== undefined) {
    const annotation = await ctx.db.get(action.citedAnnotationId);
    citation = isStillShared(annotation, action.labId)
      ? {
          annotationId: action.citedAnnotationId,
          quote: annotation?.anchor.quote,
          authorName:
            annotation === null
              ? undefined
              : await nameOf(annotation.memberId),
          pageIndex: annotation?.anchor.pageIndex,
          withdrawn: false,
        }
      : { annotationId: action.citedAnnotationId, withdrawn: true };
  }

  const steward = canSteward(action, session, membership);
  return {
    _id: action._id,
    sessionId: action.sessionId,
    kind: action.kind,
    body: action.body,
    recordedAt: action._creationTime,
    recordedById: action.recordedBy,
    recordedByName: await nameOf(action.recordedBy),
    mine: action.recordedBy === membership.userId,
    ownerId: action.ownerId,
    ownerName:
      action.ownerId === undefined ? undefined : await nameOf(action.ownerId),
    settledAt: action.settledAt,
    settledByName:
      action.settledBy === undefined
        ? undefined
        : await nameOf(action.settledBy),
    citation,
    canSettle: settles(action.kind) && steward,
    canAssign: action.kind === "task" && steward,
    canWithdraw: action.recordedBy === membership.userId,
  };
}

/**
 * A session's outcomes, and what earlier meetings on the same paper left open.
 *
 * Flat rather than grouped. The three sections and their ordering are policy,
 * they live in `lib/actions/outcomes.ts`, and the client applies the same
 * `groupOutcomes` this module would have — so there is one definition of "open
 * first, then newest" instead of a server shape and a client shape that agree
 * until one of them is edited.
 *
 * The carrying *is* done here, because it needs the sessions table: which
 * earlier meetings count is a query, and `carryForward` is handed the answer.
 *
 * Empty rather than an error for a session the caller cannot see — the same
 * answer a stale link gets everywhere else in this backend, and one that tells
 * a prober nothing about whether the id was real.
 */
export const listForSession = query({
  args: { sessionId: v.id("sessions") },
  returns: v.object({
    outcomes: v.array(outcomeView),
    carried: v.array(
      v.object({
        outcome: outcomeView,
        /** When the meeting that left it open was held. */
        fromSessionAt: v.number(),
        /** What that meeting was called, when it was called anything. */
        fromSessionTitle: v.optional(v.string()),
      }),
    ),
    /** How many carried items the cap held back. */
    carriedDroppedCount: v.number(),
    /**
     * Whether this meeting has happened, and so can be given outcomes at all.
     * Decided by the shared `canRecord`, so the panel's affordance and the
     * mutation's refusal cannot drift apart.
     */
    canRecord: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const empty = {
      outcomes: [],
      carried: [],
      carriedDroppedCount: 0,
      canRecord: false,
    };
    const userId = await requireUserId(ctx);
    const session = await ctx.db.get(args.sessionId);
    if (session === null) {
      return empty;
    }
    const membership = await getMembership(ctx, session.labId, userId);
    if (membership === null) {
      return empty;
    }

    const nameOf = nameResolver(ctx);

    const own = await ctx.db
      .query("actions")
      .withIndex("by_session", (q) => q.eq("sessionId", session._id))
      .take(MAX_OUTCOMES_PER_SESSION);

    const outcomes = [];
    for (const action of own) {
      outcomes.push(await toView(ctx, action, session, membership, nameOf));
    }

    // The carry-forward read. One index pass over the paper's outcomes, then
    // the pure filter — so the ≤ 8 rows that survive are the only ones that
    // cost a name lookup and a citation re-check.
    const priors = await priorSessions(ctx, session);
    const onPaper = await ctx.db
      .query("actions")
      .withIndex("by_paper", (q) => q.eq("paperId", session.paperId))
      .order("desc")
      .take(MAX_PAPER_OUTCOMES);

    const candidates: (Outcome<Id<"users">, Id<"sessions">> & {
      row: Doc<"actions">;
    })[] = onPaper.map((row) => ({
      row,
      kind: row.kind,
      sessionId: row.sessionId,
      recordedAt: row._creationTime,
      ...(row.ownerId === undefined ? {} : { ownerId: row.ownerId }),
      ...(row.settledAt === undefined ? {} : { settledAt: row.settledAt }),
    }));

    const forward = carryForward({ outcomes: candidates, priorSessions: priors });

    // Each carried outcome is judged against the meeting that produced it, not
    // against the one it is being shown on. `canSteward` asks whether the
    // caller presented that session — being this week's presenter is no title
    // to close a task the lab handed somebody in March.
    const origins = new Map<Id<"sessions">, Doc<"sessions"> | null>();
    const carried = [];
    for (const item of forward.items) {
      const originId = item.outcome.sessionId;
      if (!origins.has(originId)) {
        origins.set(originId, await ctx.db.get(originId));
      }
      const origin = origins.get(originId) ?? null;
      if (origin === null) {
        continue;
      }
      carried.push({
        outcome: await toView(ctx, item.outcome.row, origin, membership, nameOf),
        fromSessionAt: item.fromSessionAt,
        ...(origin.title === undefined ? {} : { fromSessionTitle: origin.title }),
      });
    }

    return {
      outcomes,
      carried,
      carriedDroppedCount: forward.droppedCount,
      canRecord: canRecord(session.status),
    };
  },
});
