import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { getMembership, requireMembership, requireUserId } from "./lib/authz";
import { recordEvent } from "./lib/ledger";
import { annotationType, ingestStatus, sessionStatus } from "./schema";

/**
 * Journal-club sessions: the calendar and the lifecycle.
 *
 * A session is `scheduled → live → ended → synthesized`, or
 * `scheduled → cancelled`. Nothing else is a legal move, and every mutation
 * here refuses the ones that aren't — a session cannot be started twice, ended
 * before it starts, or cancelled after it has happened.
 *
 * Scheduling a session also arms the product's only delivery boundary. The
 * architecture decision puts digests at T−2h before the meeting and nowhere
 * else, so `createSession` queues `digests.buildSessionPrep` for that instant
 * and keeps the job handle on the session row: rescheduling re-aims it,
 * cancelling calls it off, and starting the meeting throws it away. The digest
 * itself is a stub until its own PR (see `convex/digests.ts`); the boundary is
 * real from today, which is the part the session lifecycle owns.
 *
 * Who may do what: any member can put a session on the calendar, and after
 * that only the presenter or the lab's PI can move, run, or cancel it.
 */

/** The digest boundary from the architecture decision: two hours before the meeting. */
const PREP_LEAD_MS = 2 * 60 * 60 * 1000;
/**
 * When the boundary is already behind us — someone scheduled a session for an
 * hour from now — the job still runs, just promptly. A minute of slack keeps it
 * out of the same transaction's shadow.
 */
const MIN_SCHEDULE_DELAY_MS = 60 * 1000;
/**
 * A client clock that is a few minutes behind ours should not make "3pm today"
 * unschedulable. Anything older than this really is the past.
 */
const CLOCK_SKEW_GRACE_MS = 5 * 60 * 1000;
/** Nobody schedules a journal club two years out; a date this far away is a typo or a bad epoch. */
const MAX_SCHEDULE_AHEAD_MS = 2 * 365 * 24 * 60 * 60 * 1000;
const MAX_TITLE_LENGTH = 200;
/** Presenter notes are prep, not a manuscript — and they get read into one long-context synthesis call. */
const MAX_NOTES_LENGTH = 20_000;
/** A ceiling on the calendar, not a page. A lab meeting weekly for two years fits. */
const MAX_SESSIONS = 100;
/**
 * How many of a session's annotations `getSessionContext` will count. Well past
 * a real meeting (25 people writing 40 notes each), and the response says when
 * it was hit rather than quietly under-reporting.
 */
const MAX_COUNTED_ANNOTATIONS = 1000;

/**
 * The seven annotation types, read off the schema's own union rather than
 * retyped here. A live view renders a column per type including the empty ones,
 * and an ontology that grew an eighth type while this list didn't would show
 * six of them with no error anywhere.
 */
const ANNOTATION_TYPES = annotationType.members.map((member) => member.value);

type SessionStatus = Doc<"sessions">["status"];

/** How each status reads in a refusal, so the message says what is actually true. */
const STATUS_PROSE: Record<SessionStatus, string> = {
  scheduled: "hasn't started yet",
  live: "is live",
  ended: "has already ended",
  synthesized: "has already been written up",
  cancelled: "was cancelled",
};

/* -------------------------------------------------------------------------
 * Shapes
 * ---------------------------------------------------------------------- */

/**
 * `paperTitle` and `presenterName` are optional because the join can come back
 * empty — a member who left the lab still presented the session they presented,
 * and the calendar should render that row rather than fail on it.
 */
const sessionFields = {
  _id: v.id("sessions"),
  labId: v.id("labs"),
  paperId: v.id("papers"),
  paperTitle: v.optional(v.string()),
  title: v.optional(v.string()),
  scheduledAt: v.number(),
  presenterId: v.id("users"),
  presenterName: v.optional(v.string()),
  status: sessionStatus,
  startedAt: v.optional(v.number()),
  endedAt: v.optional(v.number()),
  cancelledAt: v.optional(v.number()),
};

const sessionSummary = v.object(sessionFields);

const sessionDetail = v.object({
  ...sessionFields,
  paperAuthors: v.optional(v.array(v.string())),
  paperYear: v.optional(v.number()),
  paperVenue: v.optional(v.string()),
  paperIngestStatus: v.optional(ingestStatus),
  paperHasPdf: v.boolean(),
  presenterNotes: v.optional(v.string()),
  synthesis: v.optional(v.string()),
  synthesisApprovedAt: v.optional(v.number()),
  createdAt: v.number(),
  /** Whether the caller may move, run, or cancel this session (presenter or PI). */
  canManage: v.boolean(),
});

function toSummary(
  session: Doc<"sessions">,
  paper: Doc<"papers"> | null,
  presenter: Doc<"users"> | null,
) {
  return {
    _id: session._id,
    labId: session.labId,
    paperId: session.paperId,
    paperTitle: paper?.title,
    title: session.title,
    scheduledAt: session.scheduledAt,
    presenterId: session.presenterId,
    presenterName: presenter?.name ?? presenter?.email,
    status: session.status,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    cancelledAt: session.cancelledAt,
  };
}

function toDetail(
  session: Doc<"sessions">,
  paper: Doc<"papers"> | null,
  presenter: Doc<"users"> | null,
  membership: Doc<"memberships">,
) {
  return {
    ...toSummary(session, paper, presenter),
    paperAuthors: paper?.authors,
    paperYear: paper?.year,
    paperVenue: paper?.venue,
    paperIngestStatus: paper?.ingestStatus,
    paperHasPdf: paper?.storageId !== undefined,
    presenterNotes: session.presenterNotes,
    synthesis: session.synthesis,
    synthesisApprovedAt: session.synthesisApprovedAt,
    createdAt: session._creationTime,
    canManage: canManage(session, membership),
  };
}

/* -------------------------------------------------------------------------
 * Guards
 * ---------------------------------------------------------------------- */

/**
 * A session the caller is allowed to touch, plus the membership that allowed
 * it — same shape, and same reasoning, as `requirePaperAccess` in `papers.ts`.
 */
async function requireSessionAccess(
  ctx: QueryCtx | MutationCtx,
  sessionId: Id<"sessions">,
): Promise<{ session: Doc<"sessions">; membership: Doc<"memberships"> }> {
  const session = await ctx.db.get(sessionId);
  if (session === null) {
    throw new ConvexError("That session is no longer on the calendar.");
  }
  const membership = await requireMembership(ctx, session.labId);
  return { session, membership };
}

/** The presenter runs their own session; the PI runs anyone's. */
function canManage(
  session: Doc<"sessions">,
  membership: Doc<"memberships">,
): boolean {
  return membership.role === "pi" || session.presenterId === membership.userId;
}

function requireManage(
  session: Doc<"sessions">,
  membership: Doc<"memberships">,
): void {
  if (!canManage(session, membership)) {
    throw new ConvexError(
      "Only the presenter or the lab's PI can change this session.",
    );
  }
}

/**
 * The single refusal for every illegal transition. Says where the session
 * actually is, because "invalid state" tells the presenter standing in front of
 * their lab nothing at all.
 */
function refuse(session: Doc<"sessions">, attempted: string): never {
  throw new ConvexError(
    `That session ${STATUS_PROSE[session.status]}, so it can't be ${attempted}.`,
  );
}

function cleanTitle(input: string | undefined): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  const title = input.trim().replace(/\s+/g, " ").slice(0, MAX_TITLE_LENGTH);
  return title.length > 0 ? title : undefined;
}

/** Notes keep their line breaks — they are an outline, not a headline. */
function cleanNotes(input: string): string | undefined {
  const notes = input.trim().slice(0, MAX_NOTES_LENGTH);
  return notes.length > 0 ? notes : undefined;
}

/**
 * A meeting time has to be a real instant, roughly ahead of now, and this side
 * of absurd. "Roughly" is the point: a lab scheduling the session it is about
 * to hold is normal, so `now` is allowed and only the genuine past is refused.
 */
function cleanScheduledAt(input: number): number {
  if (!Number.isFinite(input)) {
    throw new ConvexError("That isn't a valid date and time.");
  }
  const at = Math.round(input);
  const now = Date.now();
  if (at < now - CLOCK_SKEW_GRACE_MS) {
    throw new ConvexError("A session can't be scheduled in the past.");
  }
  if (at > now + MAX_SCHEDULE_AHEAD_MS) {
    throw new ConvexError("Sessions can be scheduled up to two years ahead.");
  }
  return at;
}

/** Somebody has to be in the lab to present to it. */
async function requirePresenterMembership(
  ctx: QueryCtx | MutationCtx,
  labId: Id<"labs">,
  presenterId: Id<"users">,
): Promise<void> {
  if ((await getMembership(ctx, labId, presenterId)) === null) {
    throw new ConvexError("The presenter has to be a member of this lab.");
  }
}

/* -------------------------------------------------------------------------
 * The prep-digest boundary
 * ---------------------------------------------------------------------- */

/**
 * Queue the T−2h prep digest and hand back the handle to store on the session.
 *
 * A session scheduled for less than two hours from now — or for right now,
 * which happens when a lab writes down the meeting it is already in — has a
 * boundary that is already behind it. Rather than skip the digest, we run it
 * shortly: the member who joins a session an hour after it was put on the
 * calendar still wants to know what their labmates wrote.
 */
async function schedulePrepDigest(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  scheduledAt: number,
): Promise<Id<"_scheduled_functions">> {
  const boundary = scheduledAt - PREP_LEAD_MS;
  const runAt = Math.max(boundary, Date.now() + MIN_SCHEDULE_DELAY_MS);
  return await ctx.scheduler.runAt(runAt, internal.digests.buildSessionPrep, {
    sessionId,
  });
}

/**
 * Call off a session's queued prep digest, if it still has one.
 *
 * Safe to call whatever the job's state: cancelling one that has already run,
 * or already been cancelled, does nothing.
 */
async function cancelPrepDigest(
  ctx: MutationCtx,
  session: Doc<"sessions">,
): Promise<void> {
  if (session.prepDigestJobId !== undefined) {
    await ctx.scheduler.cancel(session.prepDigestJobId);
  }
}

/* -------------------------------------------------------------------------
 * Lifecycle
 * ---------------------------------------------------------------------- */

/**
 * Put a session on the lab's calendar.
 *
 * Any member can schedule one — journal clubs are organised by whoever is
 * organising them, not only by the PI — and the presenter defaults to whoever
 * is doing the scheduling, which is the common case.
 */
export const createSession = mutation({
  args: {
    labId: v.id("labs"),
    paperId: v.id("papers"),
    scheduledAt: v.number(),
    presenterId: v.optional(v.id("users")),
    title: v.optional(v.string()),
  },
  returns: v.id("sessions"),
  handler: async (ctx, args) => {
    const membership = await requireMembership(ctx, args.labId);

    // The paper id is a claim like any other. Membership in the lab says
    // nothing about a paper that belongs to a different one.
    const paper = await ctx.db.get(args.paperId);
    if (paper === null || paper.labId !== args.labId) {
      throw new ConvexError("That paper isn't in this lab's library.");
    }

    const scheduledAt = cleanScheduledAt(args.scheduledAt);
    const presenterId = args.presenterId ?? membership.userId;
    if (presenterId !== membership.userId) {
      await requirePresenterMembership(ctx, args.labId, presenterId);
    }

    const title = cleanTitle(args.title);
    const sessionId = await ctx.db.insert("sessions", {
      labId: args.labId,
      paperId: args.paperId,
      ...(title !== undefined ? { title } : {}),
      scheduledAt,
      presenterId,
      status: "scheduled",
      createdBy: membership.userId,
    });

    const prepDigestJobId = await schedulePrepDigest(
      ctx,
      sessionId,
      scheduledAt,
    );
    await ctx.db.patch(sessionId, { prepDigestJobId });

    await recordEvent(ctx, {
      labId: args.labId,
      type: "session.scheduled",
      actorId: membership.userId,
      paperId: args.paperId,
      sessionId,
      scheduledAt,
      presenterId,
    });

    return sessionId;
  },
});

/**
 * Move, re-cast, or annotate a scheduled session. Presenter or PI.
 *
 * The three edits have different windows, because they mean different things.
 * A time can only move while the meeting is still ahead of the lab. A presenter
 * can be swapped right up to and during the meeting — people get sick. Notes
 * stay editable for as long as the session exists, since they are what the
 * synthesis reads afterwards. A cancelled session is closed to all three.
 */
export const updateSession = mutation({
  args: {
    sessionId: v.id("sessions"),
    scheduledAt: v.optional(v.number()),
    presenterId: v.optional(v.id("users")),
    presenterNotes: v.optional(v.string()),
    title: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { session, membership } = await requireSessionAccess(
      ctx,
      args.sessionId,
    );
    requireManage(session, membership);
    if (session.status === "cancelled") {
      refuse(session, "edited");
    }

    // Assembled and applied once. A key present with `undefined` clears the
    // field, which is how a title or a set of notes gets emptied again.
    const patch: Partial<Doc<"sessions">> = {};
    let rescheduledTo: number | undefined;
    let newPresenterId: Id<"users"> | undefined;

    if (args.title !== undefined) {
      patch.title = cleanTitle(args.title);
    }
    if (args.presenterNotes !== undefined) {
      patch.presenterNotes = cleanNotes(args.presenterNotes);
    }

    if (
      args.presenterId !== undefined &&
      args.presenterId !== session.presenterId
    ) {
      if (session.status !== "scheduled" && session.status !== "live") {
        refuse(session, "handed to a different presenter");
      }
      await requirePresenterMembership(ctx, session.labId, args.presenterId);
      patch.presenterId = args.presenterId;
      newPresenterId = args.presenterId;
    }

    if (args.scheduledAt !== undefined) {
      if (session.status !== "scheduled") {
        refuse(session, "rescheduled");
      }
      const scheduledAt = cleanScheduledAt(args.scheduledAt);
      if (scheduledAt !== session.scheduledAt) {
        // The digest boundary moved with the meeting. Cancel the job aimed at
        // the old time before queueing its replacement, or the lab gets a prep
        // digest for a session that is no longer two hours away.
        await cancelPrepDigest(ctx, session);
        patch.prepDigestJobId = await schedulePrepDigest(
          ctx,
          session._id,
          scheduledAt,
        );
        patch.scheduledAt = scheduledAt;
        rescheduledTo = scheduledAt;
      }
    }

    if (Object.keys(patch).length === 0) {
      return null;
    }
    await ctx.db.patch(session._id, patch);

    if (newPresenterId !== undefined) {
      await recordEvent(ctx, {
        labId: session.labId,
        type: "session.presenter_changed",
        actorId: membership.userId,
        paperId: session.paperId,
        sessionId: session._id,
        presenterId: newPresenterId,
      });
    }
    if (rescheduledTo !== undefined) {
      await recordEvent(ctx, {
        labId: session.labId,
        type: "session.rescheduled",
        actorId: membership.userId,
        paperId: session.paperId,
        sessionId: session._id,
        scheduledAt: rescheduledTo,
      });
    }
    return null;
  },
});

/**
 * Start the meeting. Presenter or PI.
 *
 * Deliberately no check that `scheduledAt` has arrived. Labs run late, rooms
 * get double-booked, and a session that starts forty minutes after the calendar
 * said it would is a normal Tuesday — refusing that would only teach people to
 * reschedule before they can press the button.
 */
export const startSession = mutation({
  args: { sessionId: v.id("sessions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { session, membership } = await requireSessionAccess(
      ctx,
      args.sessionId,
    );
    requireManage(session, membership);
    if (session.status !== "scheduled") {
      refuse(session, "started");
    }

    // A meeting that has begun is past its prep boundary. If the job is still
    // queued — an early start, or a session put on the calendar minutes ago —
    // it has nothing left to prepare for. The session-start refresh the
    // architecture decision calls for is a different boundary and lands with
    // the digest itself.
    await cancelPrepDigest(ctx, session);

    await ctx.db.patch(session._id, {
      status: "live",
      startedAt: Date.now(),
      prepDigestJobId: undefined,
    });
    await recordEvent(ctx, {
      labId: session.labId,
      type: "session.started",
      actorId: membership.userId,
      paperId: session.paperId,
      sessionId: session._id,
    });
    return null;
  },
});

/**
 * End the meeting. Presenter or PI.
 *
 * `ended` is where synthesis becomes possible; the transition to `synthesized`
 * belongs to the synthesis action, not here.
 */
export const endSession = mutation({
  args: { sessionId: v.id("sessions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { session, membership } = await requireSessionAccess(
      ctx,
      args.sessionId,
    );
    requireManage(session, membership);
    if (session.status !== "live") {
      refuse(session, "ended");
    }

    await ctx.db.patch(session._id, {
      status: "ended",
      endedAt: Date.now(),
    });
    await recordEvent(ctx, {
      labId: session.labId,
      type: "session.ended",
      actorId: membership.userId,
      paperId: session.paperId,
      sessionId: session._id,
    });
    return null;
  },
});

/**
 * Call off a meeting that hasn't happened. Presenter or PI.
 *
 * Only from `scheduled`: a session that ran is history, and history is ended,
 * not cancelled. The row stays either way — prep annotations point at it, and
 * the ledger already recorded that it was scheduled.
 */
export const cancelSession = mutation({
  args: { sessionId: v.id("sessions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { session, membership } = await requireSessionAccess(
      ctx,
      args.sessionId,
    );
    requireManage(session, membership);
    if (session.status !== "scheduled") {
      refuse(session, "cancelled");
    }

    await cancelPrepDigest(ctx, session);
    await ctx.db.patch(session._id, {
      status: "cancelled",
      cancelledAt: Date.now(),
      prepDigestJobId: undefined,
    });
    await recordEvent(ctx, {
      labId: session.labId,
      type: "session.cancelled",
      actorId: membership.userId,
      paperId: session.paperId,
      sessionId: session._id,
    });
    return null;
  },
});

/* -------------------------------------------------------------------------
 * Reads
 * ---------------------------------------------------------------------- */

/**
 * The lab's calendar: furthest-future session first, running back through the
 * ones that have happened. One list rather than an upcoming/past split, because
 * where "now" falls is a client-side question that changes without any data
 * changing — and every row carries `scheduledAt` and `status` to answer it.
 *
 * Bounded like the library is: a hundred sessions is two years of weekly
 * meetings, and the 101st is the signal to build a real paged view.
 */
export const listSessions = query({
  args: { labId: v.id("labs") },
  returns: v.array(sessionSummary),
  handler: async (ctx, args) => {
    await requireMembership(ctx, args.labId);

    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_lab_and_scheduled", (q) => q.eq("labId", args.labId))
      .order("desc")
      .take(MAX_SESSIONS);

    // A lab reads a paper over several sessions and the same few people
    // present; without the caches a hundred rows would be two hundred
    // document reads for a few dozen distinct documents.
    const papers = new Map<Id<"papers">, Doc<"papers"> | null>();
    const presenters = new Map<Id<"users">, Doc<"users"> | null>();

    const summaries = [];
    for (const session of sessions) {
      let paper = papers.get(session.paperId);
      if (paper === undefined) {
        paper = await ctx.db.get(session.paperId);
        papers.set(session.paperId, paper);
      }
      let presenter = presenters.get(session.presenterId);
      if (presenter === undefined) {
        presenter = await ctx.db.get(session.presenterId);
        presenters.set(session.presenterId, presenter);
      }
      summaries.push(toSummary(session, paper, presenter));
    }
    return summaries;
  },
});

/**
 * One session with the paper it is about and the person presenting it.
 *
 * `null` rather than a throw when the caller can't see it, so a stale link
 * renders an honest empty state — and so the answer is the same whether the
 * session is missing or forbidden.
 */
export const getSession = query({
  args: { sessionId: v.id("sessions") },
  returns: v.union(v.null(), sessionDetail),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const session = await ctx.db.get(args.sessionId);
    if (session === null) {
      return null;
    }
    const membership = await getMembership(ctx, session.labId, userId);
    if (membership === null) {
      return null;
    }

    const paper = await ctx.db.get(session.paperId);
    const presenter = await ctx.db.get(session.presenterId);
    return toDetail(session, paper, presenter, membership);
  },
});

/**
 * Everything the live session view needs in one subscription: the session, its
 * paper, and how many annotations of each type the lab has written *in this
 * session*.
 *
 * The counts are an aggregate and are treated as one. A private annotation is
 * counted only for the person who wrote it — the privacy constitution rules out
 * per-member reading dashboards, and a heatmap that silently included notes
 * their author kept to themselves would be one by another name.
 */
export const getSessionContext = query({
  args: { sessionId: v.id("sessions") },
  returns: v.union(
    v.null(),
    v.object({
      session: sessionDetail,
      /** All seven types, including the ones with no annotations, in ontology order. */
      annotationCounts: v.array(
        v.object({ type: annotationType, count: v.number() }),
      ),
      totalAnnotations: v.number(),
      /** True when the session has more annotations than one query will count. */
      countsTruncated: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const session = await ctx.db.get(args.sessionId);
    if (session === null) {
      return null;
    }
    const membership = await getMembership(ctx, session.labId, userId);
    if (membership === null) {
      return null;
    }

    const paper = await ctx.db.get(session.paperId);
    const presenter = await ctx.db.get(session.presenterId);

    // One over the cap, so hitting it is detectable rather than invisible.
    const annotations = await ctx.db
      .query("annotations")
      .withIndex("by_session", (q) => q.eq("sessionId", session._id))
      .take(MAX_COUNTED_ANNOTATIONS + 1);
    const countsTruncated = annotations.length > MAX_COUNTED_ANNOTATIONS;

    const counts = new Map<Doc<"annotations">["type"], number>();
    let totalAnnotations = 0;
    for (const annotation of annotations.slice(0, MAX_COUNTED_ANNOTATIONS)) {
      if (annotation.deletedAt !== undefined) {
        continue;
      }
      if (
        annotation.visibility === "private" &&
        annotation.memberId !== userId
      ) {
        continue;
      }
      counts.set(annotation.type, (counts.get(annotation.type) ?? 0) + 1);
      totalAnnotations++;
    }

    return {
      session: toDetail(session, paper, presenter, membership),
      annotationCounts: ANNOTATION_TYPES.map((type) => ({
        type,
        count: counts.get(type) ?? 0,
      })),
      totalAnnotations,
      countsTruncated,
    };
  },
});
