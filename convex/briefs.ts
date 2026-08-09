import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { getMembership, requireUserId } from "./lib/authz";
import { recordEvent } from "./lib/ledger";
import { briefSectionKey } from "./schema";
import { canApprove } from "./sessions";
import { isStillShared, WITHDRAWN_ITEM_TEXT } from "./synthesis";
import { assembleBrief, type BriefAnnotation } from "../lib/brief/assemble";

/**
 * The presenter's pre-session brief.
 *
 * A journal club's real cost is the Sunday night before it: one person reads a
 * paper twice, scrolls back through a term of Slack, and tries to remember what
 * the lab already decided about the assay. Everything they need is already in
 * the margin — this assembles it.
 *
 * This module is the plumbing: reads, authorization, writes. The policy is
 * `lib/brief/assemble.ts`, which is pure and unit-tested.
 *
 * ## Assembled, never generated
 *
 * There is no model call anywhere in this file and there is not meant to be
 * one. Every line is a rearrangement of annotations the lab wrote, carrying the
 * ids it was built from, so a presenter who doubts a line opens the note behind
 * it. The synthesis pays for its model with a sanitizer that drops anything it
 * cannot trace; a brief never manufactures the problem, which is also why it
 * costs nothing to regenerate and can ride a scheduled boundary without a
 * lease, a timeout, or an API key.
 *
 * ## The same provenance discipline as the synthesis
 *
 * A stored citation is a claim about a row, and the margin moves underneath it:
 * notes get withdrawn and members flip one back to private. So `getForSession`
 * re-resolves every cited id on read and redacts a line whose notes have all
 * gone, using the same `isStillShared` predicate `convex/synthesis.ts` applies
 * — imported rather than restated, because a privacy rule with two definitions
 * has one that is out of date.
 *
 * ## Two things this file will not do
 *
 * 1. **It never reads a private annotation.** The pool is pinned to
 *    `by_paper_and_visibility` at `"lab"`. A brief is read by the PI as well as
 *    the presenter, so a private note reaching this pipeline would be one
 *    leaked field away from a member's private writing appearing in front of
 *    their PI. The presenter's own private notes *are* part of the brief as a
 *    product — and they are assembled in the browser from that presenter's own
 *    subscription (`lib/brief/prep.ts`), never here.
 * 2. **It computes no per-member tally.** The "who has written" section is
 *    derived on the client from rows already delivered to the page, so no
 *    function in this backend gains the ability to answer "who has annotated" —
 *    which is the promise `getSessionContext` makes in `convex/sessions.ts`,
 *    and it stays literally true.
 */

/* -------------------------------------------------------------------------
 * Policy constants
 * ---------------------------------------------------------------------- */

/**
 * Ceiling on how much of a paper's margin one assembly considers.
 *
 * The same number `convex/digests.ts` uses, and for the same reason: collision
 * detection is quadratic in it, and read newest-first so a paper that has run
 * away with itself contributes the live end of its conversation rather than its
 * opening months.
 */
const POOL_LIMIT = 1000;

/**
 * How many earlier meetings on this paper the carried-over section reaches
 * back through. A lab that has read one paper across twenty sessions has a
 * different problem than this feature solves.
 */
const PRIOR_SESSION_LIMIT = 50;

/* -------------------------------------------------------------------------
 * Shapes
 * ---------------------------------------------------------------------- */

const briefItem = v.object({
  text: v.string(),
  annotationIds: v.array(v.id("annotations")),
  pairType: v.optional(v.string()),
  fromSessionId: v.optional(v.id("sessions")),
  fromSessionAt: v.optional(v.number()),
});

const briefSection = v.object({
  key: briefSectionKey,
  heading: v.string(),
  droppedCount: v.number(),
  items: v.array(briefItem),
});

/* -------------------------------------------------------------------------
 * Gating
 * ---------------------------------------------------------------------- */

/** Same words as `convex/sessions.ts` — a session id tells an outsider nothing. */
const NO_SUCH_SESSION = "That session is no longer on the calendar.";

/**
 * Who a brief is for: the presenter, or the PI.
 *
 * Deliberately `canApprove` rather than `canManage`. A brief is prep — it says
 * which of somebody's questions went unanswered and whose critique drew a
 * crowd, laid out for the person who has to stand up and run the hour. The
 * organiser who booked the room can move the meeting and start it, and has no
 * business reading the presenter's agenda; the two people who do are the one
 * presenting and the one who answers for the lab. Imported from
 * `convex/sessions.ts` rather than restated, because a permission with two
 * definitions has one that is out of date.
 */
async function requireBriefAccess(
  ctx: QueryCtx | MutationCtx,
  sessionId: Id<"sessions">,
): Promise<{ session: Doc<"sessions">; userId: Id<"users"> }> {
  const userId = await requireUserId(ctx);
  const session = await ctx.db.get(sessionId);
  const membership =
    session === null ? null : await getMembership(ctx, session.labId, userId);
  if (session === null || membership === null) {
    throw new ConvexError(NO_SUCH_SESSION);
  }
  if (!canApprove(session, membership)) {
    throw new ConvexError(
      "Only the presenter or the lab's PI can open this session's brief.",
    );
  }
  return { session, userId };
}

/* -------------------------------------------------------------------------
 * Assembling
 * ---------------------------------------------------------------------- */

async function existingBrief(
  ctx: QueryCtx | MutationCtx,
  sessionId: Id<"sessions">,
): Promise<Doc<"briefs"> | null> {
  return await ctx.db
    .query("briefs")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .unique();
}

/**
 * Which earlier meetings on this paper the carried-over section may draw from.
 *
 * `ended` and `synthesized` only. A meeting that was cancelled was never held,
 * so a question written while it sat on the calendar was never taken to a floor
 * and is ordinary prep rather than something the lab failed to settle. One
 * still `scheduled` has not happened yet, and this session itself is obviously
 * not prior to itself.
 *
 * Both of those rules are conditions on the *query* rather than a pass over its
 * results, because the cap has to fall on rows that qualify. Filtering
 * afterwards spends the budget on cancellations and on meetings still ahead of
 * the lab, and a held meeting pushed out of the window that way does not go
 * missing quietly: its unanswered questions stop being carried-over and are
 * assembled as fresh, so the brief silently claims the lab has never discussed
 * them.
 *
 * Newest first, so if a paper somehow outruns the cap the meetings kept are the
 * recent ones — the further back a question was left open, the less the room
 * remembers of it. Ordering is by creation rather than by `scheduledAt`, which
 * is what `by_paper` offers; they differ only for a session backdated after the
 * fact, and buying an index for that is not worth a schema change.
 */
async function priorSessions(
  ctx: QueryCtx | MutationCtx,
  session: Doc<"sessions">,
): Promise<Map<Id<"sessions">, number>> {
  const onPaper = await ctx.db
    .query("sessions")
    .withIndex("by_paper", (q) => q.eq("paperId", session.paperId))
    .order("desc")
    .filter((q) =>
      q.and(
        q.neq(q.field("_id"), session._id),
        q.or(
          q.eq(q.field("status"), "ended"),
          q.eq(q.field("status"), "synthesized"),
        ),
      ),
    )
    .take(PRIOR_SESSION_LIMIT);
  return new Map(
    onPaper.map((one) => [one._id, one.scheduledAt] as const),
  );
}

/**
 * Assemble a brief and store it, replacing whatever generation came before.
 *
 * Returns `null` when there is nothing to say. An empty brief is not a brief —
 * a panel of four empty headings tells a presenter less than no panel at all —
 * so a session whose paper has no shared annotations yet simply doesn't get a
 * row, and the boundary job leaves nothing behind to clean up.
 */
async function writeBrief(
  ctx: MutationCtx,
  session: Doc<"sessions">,
  trigger: "scheduled" | "manual",
  actorId: Id<"users">,
): Promise<Id<"briefs"> | null> {
  const paper = await ctx.db.get(session.paperId);
  if (paper === null) {
    return null;
  }

  // Privacy is the index, not a filter: `by_paper_and_visibility` at "lab"
  // cannot return a private annotation. Newest-first so the cap keeps the live
  // end of the conversation.
  const visible = await ctx.db
    .query("annotations")
    .withIndex("by_paper_and_visibility", (q) =>
      q.eq("paperId", session.paperId).eq("visibility", "lab"),
    )
    .order("desc")
    .take(POOL_LIMIT);
  const live = visible.filter((a) => a.deletedAt === undefined);

  // Author display names, resolved once for the whole assembly.
  const names = new Map<Id<"users">, string>();
  for (const authorId of new Set(live.map((a) => a.memberId))) {
    const user = await ctx.db.get(authorId);
    names.set(authorId, user?.name ?? user?.email ?? "A lab member");
  }

  const pool: BriefAnnotation<
    Id<"papers">,
    Id<"annotations">,
    Id<"users">,
    Id<"sessions">
  >[] = live.map((a) => ({
    id: a._id,
    paperId: a.paperId,
    memberId: a.memberId,
    memberName: names.get(a.memberId) ?? "A lab member",
    type: a.type,
    pageIndex: a.anchor.pageIndex,
    start: a.anchor.start,
    end: a.anchor.end,
    quote: a.anchor.quote,
    body: a.body,
    createdAt: a._creationTime,
    ...(a.parentId === undefined ? {} : { parentId: a.parentId }),
    ...(a.sessionId === undefined ? {} : { sessionId: a.sessionId }),
  }));

  const { sections, citationCount } = assembleBrief({
    pool,
    paperTitle: paper.title,
    priorSessions: await priorSessions(ctx, session),
  });
  if (citationCount === 0) {
    return null;
  }

  const previous = await existingBrief(ctx, session._id);
  const generation = (previous?.generation ?? 0) + 1;
  const itemCount = sections.reduce(
    (total, one) => total + one.items.length,
    0,
  );
  const row = {
    sessionId: session._id,
    labId: session.labId,
    paperId: session.paperId,
    generation,
    generatedAt: Date.now(),
    generatedBy: actorId,
    trigger,
    sections,
  };

  // Replaced rather than patched, so a re-assembly cannot inherit the previous
  // generation's `approvedAt`. Approving a brief means "I have read this
  // assembly"; a new one has nobody's name on it, and the generations that were
  // signed off are in the ledger.
  let briefId: Id<"briefs">;
  if (previous === null) {
    briefId = await ctx.db.insert("briefs", row);
  } else {
    briefId = previous._id;
    await ctx.db.replace(previous._id, row);
  }

  await recordEvent(ctx, {
    labId: session.labId,
    actorId,
    paperId: session.paperId,
    sessionId: session._id,
    type: "brief.generated",
    briefId,
    generation,
    itemCount,
    trigger,
  });
  return briefId;
}

/**
 * Assemble the brief now, because somebody asked. Presenter or PI.
 *
 * A mutation rather than an action: there is no model to call, so the whole
 * thing is one transaction over rows the deployment already holds. That is the
 * dividend of assembling rather than generating — no lease, no timeout, no
 * half-written artifact to reason about, and pressing the button twice costs
 * two reads of the same margin.
 */
export const generate = mutation({
  args: { sessionId: v.id("sessions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { session, userId } = await requireBriefAccess(ctx, args.sessionId);
    if (session.status === "cancelled") {
      throw new ConvexError(
        "That session was cancelled, so there is no meeting left to prepare for.",
      );
    }
    const briefId = await writeBrief(ctx, session, "manual", userId);
    if (briefId === null) {
      throw new ConvexError(
        "There's nothing to brief on yet — nobody has shared an annotation on this paper. A brief is assembled from what the lab wrote, so it has nothing to rearrange.",
      );
    }
    return null;
  },
});

/**
 * The T−2h assembly, queued by the prep-digest boundary.
 *
 * Deliberately not a scheduled job of its own. `convex/sessions.ts` already
 * owns one handle per session (`prepDigestJobId`) and already re-aims it when a
 * meeting moves and cancels it when a meeting is called off; a second handle
 * would be a second field, a second cancellation path, and a second way for a
 * lab that rescheduled to get an artifact for the time it moved away from. So
 * `digests.buildSessionPrep` — which has just re-read the session and confirmed
 * the boundary is still wanted — queues this, and the brief inherits that guard
 * for free.
 *
 * The guard is re-run here anyway. `runAfter(0)` is a separate transaction, and
 * an internal mutation is a function like any other: the cheapest way for a
 * check to stay true is for it never to be inherited.
 */
export const buildForSession = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    /** The session's `scheduledAt` at the moment the boundary job was queued. */
    expectedScheduledAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (session === null) {
      return null;
    }
    if (
      session.status !== "scheduled" ||
      session.scheduledAt !== args.expectedScheduledAt
    ) {
      return null;
    }

    // A person read this and put their name on it. A timer does not get to
    // take that back — least of all two hours before they stand up, when the
    // brief they reviewed would silently become one they hadn't. Whoever wants
    // a fresher assembly can ask for one.
    const previous = await existingBrief(ctx, args.sessionId);
    if (previous?.approvedAt !== undefined) {
      return null;
    }

    await writeBrief(ctx, session, "scheduled", session.presenterId);
    return null;
  },
});

/* -------------------------------------------------------------------------
 * Reading it back
 * ---------------------------------------------------------------------- */

/**
 * Which of a brief's citations the lab may still be shown.
 *
 * One read per distinct annotation. Bounded by the row: four sections of at
 * most six lines, each citing one or two annotations.
 */
async function stillSharedAmong(
  ctx: QueryCtx,
  labId: Id<"labs">,
  citations: Iterable<Id<"annotations">>,
): Promise<Set<Id<"annotations">>> {
  const stillShared = new Set<Id<"annotations">>();
  for (const annotationId of citations) {
    if (isStillShared(await ctx.db.get(annotationId), labId)) {
      stillShared.add(annotationId);
    }
  }
  return stillShared;
}

/** A stored section, as it sits on the row. */
type StoredSection = Doc<"briefs">["sections"][number];

/**
 * Re-apply the margin's current state to an assembly that was frozen when it
 * was written.
 *
 * A brief item's text is not a description of the notes it cites — it is those
 * notes, formatted. A collision line carries both members' names and what each
 * of them wrote; the other sections carry one member's name and their words. So
 * the rule is all-or-nothing: unless *every* note behind a line is still shared
 * with the lab, the text goes.
 *
 * That is stricter than `synthesis.applyWithdrawals`, which keeps a partly
 * withdrawn item's text and drops its attribution instead. It can afford to,
 * because a synthesis item is a model's paraphrase and its names are a union
 * that cannot be mapped back to particular ids — strip them and nothing points
 * at anybody. Here the mapping is the sentence. Stripping the attribution off
 * "Ana defined the term Ben left a question on" leaves a sentence that is still
 * about Ana and Ben, and rewriting it to say less would mean re-deriving the
 * line from a note the reader is no longer allowed to read.
 *
 * The ids are left in place. The citations are what a redacted line still
 * honestly is — a line was here, resting on these — and the caller counts
 * withdrawals off them.
 */
export function redactWithdrawn(
  sections: readonly StoredSection[],
  stillShared: ReadonlySet<Id<"annotations">>,
): StoredSection[] {
  return sections.map((section) => ({
    ...section,
    items: section.items.map((item) =>
      item.annotationIds.every((id) => stillShared.has(id))
        ? item
        : { ...item, text: WITHDRAWN_ITEM_TEXT },
    ),
  }));
}

/** Every annotation a brief rests on, deduped, so each is read once. */
function collectCitations(
  sections: readonly Doc<"briefs">["sections"][number][],
): Set<Id<"annotations">> {
  const cited = new Set<Id<"annotations">>();
  for (const section of sections) {
    for (const item of section.items) {
      for (const annotationId of item.annotationIds) cited.add(annotationId);
    }
  }
  return cited;
}

/**
 * The session's brief, for the presenter or the PI.
 *
 * The row is not the answer. It was assembled against the margin as it stood,
 * and the margin moves: a note gets withdrawn, or its author flips it back to
 * private. So every citation is re-checked here and the lines are redacted on
 * the way out — before the text crosses the wire rather than after it has
 * landed in a reader's cache, because a brief that keeps quoting a note
 * somebody took back is a way around `visibility: "private"`.
 *
 * The threshold is all-or-nothing, and deliberately stricter than the one
 * `synthesis.getForSession` applies. A synthesis item is a model's paraphrase,
 * so when one of its several citations goes the sentence can stand with its
 * attribution stripped — no particular name is provably still behind it. A
 * brief item is not a paraphrase. Its text was *built* from the notes it cites:
 * a collision line names both members and quotes what each of them wrote. Drop
 * one of those two and the surviving half of the sentence is still the
 * withdrawn member's name against the passage they marked. So a line loses its
 * text the moment *any* note behind it stops being shared, not only when they
 * have all gone.
 *
 * Replaced rather than dropped, which is the part synthesis has right and this
 * keeps: saying a line was here is honest, where silently shortening the brief
 * would make the lab's prep look thinner than it was.
 *
 * `null` for anyone else in the lab, so the panel simply doesn't render — the
 * same answer a member gets for a session that was never theirs to see.
 */
export const getForSession = query({
  args: { sessionId: v.id("sessions") },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id("briefs"),
      generation: v.number(),
      generatedAt: v.number(),
      trigger: v.union(v.literal("scheduled"), v.literal("manual")),
      sections: v.array(briefSection),
      /** Distinct cited notes still shared with the lab right now. */
      citationCount: v.number(),
      approval: v.union(
        v.null(),
        v.object({
          approvedAt: v.number(),
          approvedByName: v.optional(v.string()),
          /**
           * How many of the notes this generation rests on are no longer
           * shared. Above zero, what the presenter reviewed has changed under
           * them and the panel says so.
           */
          withdrawnSince: v.number(),
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const session = await ctx.db.get(args.sessionId);
    if (session === null) {
      return null;
    }
    const membership = await getMembership(ctx, session.labId, userId);
    if (membership === null || !canApprove(session, membership)) {
      return null;
    }

    const brief = await existingBrief(ctx, args.sessionId);
    if (brief === null) {
      return null;
    }

    const cited = collectCitations(brief.sections);
    const stillShared = await stillSharedAmong(ctx, session.labId, cited);

    // Unlike a synthesis, a brief needs no separate approval snapshot: the
    // approved artifact *is* this structured, cited row, and the row is frozen
    // until somebody assembles a new generation. So the citations it was
    // reviewed against are exactly the ones in front of us, and staleness is
    // the plain difference between them and what is still shared.
    const withdrawnSince = cited.size - stillShared.size;

    const approver =
      brief.approvedBy === undefined ? null : await ctx.db.get(brief.approvedBy);
    const approverName = approver?.name ?? approver?.email;

    return {
      _id: brief._id,
      generation: brief.generation,
      generatedAt: brief.generatedAt,
      trigger: brief.trigger,
      sections: redactWithdrawn(brief.sections, stillShared),
      citationCount: stillShared.size,
      approval:
        brief.approvedAt === undefined
          ? null
          : {
              approvedAt: brief.approvedAt,
              ...(approverName === undefined
                ? {}
                : { approvedByName: approverName }),
              withdrawnSince,
            },
    };
  },
});

/* -------------------------------------------------------------------------
 * Signing it off
 * ---------------------------------------------------------------------- */

/**
 * Mark a brief reviewed: the presenter has read this and will run the meeting
 * from it.
 *
 * Lighter than approving a synthesis, because the artifacts are different
 * animals. A synthesis approval publishes prose a person wrote and edited, and
 * has to pin which version that prose was written against. A brief is not
 * edited — every line is the lab's own writing, rearranged — so approving it
 * makes exactly one claim: *this assembly has been read by the person it is
 * for*.
 *
 * `generatedAt` is still required, for the narrow race that remains: the T−2h
 * boundary, or the other approver, can re-assemble the brief while it sits open
 * on somebody's screen, and a claim to have read a generation nobody can point
 * at is worth nothing. A mismatch is refused rather than reconciled — the
 * superseded assembly is gone, and the person is the only one who can say
 * whether they have read what is there now.
 *
 * Re-approvable on purpose. A brief goes stale when a note it rests on is
 * withdrawn, and the remedy is to read it again and say so; a warning that
 * cannot be discharged is one people learn to scroll past.
 */
export const approve = mutation({
  args: {
    sessionId: v.id("sessions"),
    /** The assembly the approver actually read. */
    generatedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { session, userId } = await requireBriefAccess(ctx, args.sessionId);
    const brief = await existingBrief(ctx, args.sessionId);
    if (brief === null) {
      throw new ConvexError(
        "There's no brief for this session yet. Assemble it first.",
      );
    }
    if (brief.generatedAt !== args.generatedAt) {
      throw new ConvexError(
        "The brief was assembled again while this was open, so what you read is no longer the one on the page. Nothing has been saved — read the new one, then mark it reviewed.",
      );
    }

    const stillShared = await stillSharedAmong(
      ctx,
      session.labId,
      collectCitations(brief.sections),
    );

    await ctx.db.patch(brief._id, {
      approvedAt: Date.now(),
      approvedBy: userId,
    });

    await recordEvent(ctx, {
      labId: session.labId,
      actorId: userId,
      paperId: session.paperId,
      sessionId: args.sessionId,
      type: "brief.approved",
      briefId: brief._id,
      generation: brief.generation,
      citationCount: stillShared.size,
    });
    return null;
  },
});
