import { ConvexError, v } from "convex/values";
/**
 * How far ahead of its scheduled time a session may be started. Generous on
 * purpose — labs move a meeting forward a day without touching the calendar —
 * but a session started a fortnight early is the wrong row, clicked in a list.
 * The rule itself lives in `lib/` so the button that offers the start and the
 * mutation that enforces it cannot drift apart.
 */
import { UNDO_WINDOW_MS, awayProse, startWindow } from "../lib/session-window";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { getMembership, requireMembership, requireUserId } from "./lib/authz";
import { recordEvent } from "./lib/ledger";
import { annotationType, ingestStatus, sessionStatus } from "./schema";
import { GENERATION_LEASE_MS } from "./synthesis";

/**
 * Journal-club sessions: the calendar and the lifecycle.
 *
 * A session is `scheduled → live → ended → synthesized`, or
 * `scheduled → cancelled`. Nothing else is a legal move, and every mutation
 * here refuses the ones that aren't — a session cannot be started twice, ended
 * before it starts, or cancelled after it has happened.
 *
 * Scheduling a session also arms the product's delivery boundaries. The
 * architecture decision puts digests at T−2h before the meeting and at the
 * moment it starts, and nowhere else. So `createSession` queues
 * `digests.buildSessionPrep` for T−2h and keeps the job handle on the session
 * row — rescheduling re-aims it, cancelling calls it off — and `startSession`
 * throws that handle away and fires the start boundary instead. The digest
 * itself is a stub until its own PR (see `convex/digests.ts`); the boundaries
 * are real from today, which is the part the session lifecycle owns.
 *
 * Who may do what: any member can put a session on the calendar, and after
 * that only the presenter, whoever scheduled it, or the lab's PI can move,
 * run, or cancel it.
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
export const MAX_NOTES_LENGTH = 20_000;
/** A ceiling on the calendar, not a page. A lab meeting weekly for two years fits. */
const MAX_SESSIONS = 100;
/**
 * How many meetings a lab may have on the books at once. Fifty is a year of
 * weekly journal club still ahead of you; a lab that wants a fifty-first has
 * either stopped cancelling the ones it isn't holding, or is being scripted at.
 * Sessions that ran, or were called off, don't count — the ceiling is on the
 * future, and on the number of prep-digest jobs one lab can have queued.
 */
const MAX_SCHEDULED_SESSIONS = 50;
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
  /**
   * Whether the caller may move, run, or cancel this session — the presenter,
   * whoever scheduled it, or the PI.
   */
  canManage: v.boolean(),
  /**
   * Whether the caller may approve the write-up — the presenter or the PI
   * only. A narrower rule than `canManage`, and sent separately so the client
   * never has to re-derive it (see `canApprove`).
   */
  canApprove: v.boolean(),
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
    canApprove: canApprove(session, membership),
  };
}

/* -------------------------------------------------------------------------
 * Guards
 * ---------------------------------------------------------------------- */

/**
 * The one answer to every session a caller may not have. Deliberately the same
 * words whether the id was never real, was deleted, or belongs to a lab the
 * caller has nothing to do with — an outsider holding a session id learns
 * nothing from asking about it. This is the posture `requireMembership` takes
 * in `lib/authz.ts`, where "no such lab" and "not a member" are also one
 * message.
 */
const NO_SUCH_SESSION = "That session is no longer on the calendar.";

/**
 * A session the caller is allowed to touch, plus the membership that allowed
 * it — same shape as `requirePaperAccess` in `papers.ts`.
 *
 * The membership lookup is done by hand rather than through
 * `requireMembership` because that helper throws its own message, and a
 * distinct "you are not a member of this lab" reply would confirm that the
 * session exists to someone who is only guessing.
 */
async function requireSessionAccess(
  ctx: QueryCtx | MutationCtx,
  sessionId: Id<"sessions">,
): Promise<{ session: Doc<"sessions">; membership: Doc<"memberships"> }> {
  const userId = await requireUserId(ctx);
  const session = await ctx.db.get(sessionId);
  const membership =
    session === null ? null : await getMembership(ctx, session.labId, userId);
  if (session === null || membership === null) {
    throw new ConvexError(NO_SUCH_SESSION);
  }
  return { session, membership };
}

/**
 * The presenter runs their own session; the PI runs anyone's; and so does
 * whoever put it on the calendar. That last one is the common case in a lab
 * where an admin or a rotating organiser schedules the term's meetings on
 * other people's behalf — leaving them unable to fix the time they typed
 * wrong, or to cancel a meeting the presenter is off sick for, makes the PI a
 * bottleneck for clerical work.
 */
function canManage(
  session: Doc<"sessions">,
  membership: Doc<"memberships">,
): boolean {
  return (
    membership.role === "pi" ||
    session.presenterId === membership.userId ||
    session.createdBy === membership.userId
  );
}

/**
 * Who may sign the write-up off: the presenter, or the PI. Deliberately
 * narrower than `canManage`.
 *
 * Whoever put the session on the calendar can move it, start it, and generate
 * a draft — that is clerical work, and making the PI a bottleneck for it helps
 * nobody. Approving is not clerical. The approved copy is the lab's account of
 * what it worked out, published under the name of the person who presented it,
 * and an organiser who booked the room has no standing to put words in that
 * person's mouth. The two people who do are the one who ran the discussion and
 * the one who answers for the lab.
 *
 * Exported because `convex/synthesis.ts` enforces the same rule on the way in
 * and a duplicated permission check is a permission check that drifts.
 */
export function canApprove(
  session: Doc<"sessions">,
  membership: Doc<"memberships">,
): boolean {
  return (
    membership.role === "pi" || session.presenterId === membership.userId
  );
}

function requireManage(
  session: Doc<"sessions">,
  membership: Doc<"memberships">,
): void {
  if (!canManage(session, membership)) {
    throw new ConvexError(
      "Only the presenter, whoever scheduled this session, or the lab's PI can change it.",
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

/** Exported for `sessionTemplates.ts`, so a saved title is held to the rule the session will apply to it. */
export function cleanTitle(input: string | undefined): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  const title = input.trim().replace(/\s+/g, " ").slice(0, MAX_TITLE_LENGTH);
  return title.length > 0 ? title : undefined;
}

/**
 * Which title a session ends up with when a template was applied: what the
 * person typed, then the template's, then none — and a session with none is
 * known by its paper, which is the common case and not a gap.
 *
 * Typed beats saved because the typing happened second and in front of the
 * form that already showed what the template would do. A template that
 * overrode it would be the one field on the page that ignores you.
 *
 * Pure and exported for the same reason `canApprove` is: it is a rule, it has
 * three cases, and two of them are only reachable through a mutation.
 */
export function sessionTitleFrom(
  typed: string | undefined,
  templateTitle: string | undefined,
): string | undefined {
  return cleanTitle(typed) ?? cleanTitle(templateTitle);
}

/**
 * Notes keep their line breaks — they are an outline, not a headline.
 *
 * Too long is refused rather than trimmed. A silent `slice` hands back a
 * success to a presenter whose last two thousand words have just been thrown
 * away, and they find out at the meeting.
 */
function cleanNotes(input: string): string | undefined {
  const notes = input.trim();
  if (notes.length > MAX_NOTES_LENGTH) {
    throw new ConvexError(
      `Those notes are ${notes.length} characters. Presenter notes stop at ${MAX_NOTES_LENGTH} — they are prep for a meeting, and they get read into one synthesis call.`,
    );
  }
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
    boundary: "session-prep",
    // What the job was armed for. Cancellation races a job that has already
    // begun, so the digest re-reads the session and refuses to deliver prep
    // for a meeting that has since moved (see `convex/digests.ts`).
    expectedScheduledAt: scheduledAt,
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
 *
 * `templateId` is the lab's own saved meeting shape (see
 * `convex/sessionTemplates.ts`), and applying one is a copy, not a link: the
 * agenda lands in this session's `presenterNotes` and stops being the
 * template's business. The presenter edits it here afterwards like any other
 * notes, and editing the template later does not reach back into meetings that
 * have already been put on the calendar — which is the only behaviour that
 * survives someone tidying up their templates in week nine.
 *
 * The seeding happens on the server rather than the client sending the text
 * back, so a template is one id over the wire and the shape a session was
 * given is the shape the lab actually saved.
 */
export const createSession = mutation({
  args: {
    labId: v.id("labs"),
    paperId: v.id("papers"),
    scheduledAt: v.number(),
    presenterId: v.optional(v.id("users")),
    title: v.optional(v.string()),
    templateId: v.optional(v.id("sessionTemplates")),
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

    // One past the cap, so the check reads the same whether the lab has just
    // reached the ceiling or was already over it.
    const outstanding = await ctx.db
      .query("sessions")
      .withIndex("by_lab_and_status", (q) =>
        q.eq("labId", args.labId).eq("status", "scheduled"),
      )
      .take(MAX_SCHEDULED_SESSIONS + 1);
    if (outstanding.length >= MAX_SCHEDULED_SESSIONS) {
      throw new ConvexError(
        `This lab already has ${MAX_SCHEDULED_SESSIONS} sessions on the calendar. Hold or cancel one before scheduling another.`,
      );
    }

    const scheduledAt = cleanScheduledAt(args.scheduledAt);
    const presenterId = args.presenterId ?? membership.userId;
    if (presenterId !== membership.userId) {
      await requirePresenterMembership(ctx, args.labId, presenterId);
    }

    // A template id is a claim like the paper id above, and gets the same
    // treatment: belonging to this lab is checked here, not assumed from the
    // fact that the caller had the id.
    let template: Doc<"sessionTemplates"> | null = null;
    if (args.templateId !== undefined) {
      template = await ctx.db.get(args.templateId);
      if (template === null || template.labId !== args.labId) {
        // One message for both, the posture `NO_SUCH_SESSION` takes below: a
        // template deleted while this form was open and a template belonging
        // to somebody else's lab are the same answer, and the realistic case
        // is the first one.
        throw new ConvexError(
          "That agenda template is gone — deleted, or never this lab's.",
        );
      }
    }

    const title = sessionTitleFrom(args.title, template?.title);
    // Through the same gate the presenter's own notes go through, rather than
    // straight into the insert. It is a no-op today — a template is capped at
    // 4,000 characters and arrives already trimmed — and that is the point:
    // the 4,000 < 20,000 gap stops being a fact held in a comment. Raise the
    // template ceiling past this one some day and scheduling refuses here,
    // rather than writing a session whose notes `updateSession` will not
    // accept and whose presenter cannot edit their way out of.
    const templateNotes =
      template !== null ? cleanNotes(template.presenterNotes) : undefined;
    const sessionId = await ctx.db.insert("sessions", {
      labId: args.labId,
      paperId: args.paperId,
      ...(title !== undefined ? { title } : {}),
      scheduledAt,
      presenterId,
      status: "scheduled",
      ...(templateNotes !== undefined
        ? { presenterNotes: templateNotes }
        : {}),
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
 * Move, re-cast, or annotate a scheduled session. Presenter, scheduler, or PI.
 *
 * The three edits have different windows, because they mean different things.
 * A time can only move while the meeting is still ahead of the lab. A presenter
 * can be swapped right up to and during the meeting — people get sick. Notes
 * stay editable through `ended`, since they are what the synthesis reads
 * afterwards, and close once that synthesis exists. A cancelled session is
 * closed to all three.
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
      // Notes are an input to the synthesis, not a comment on it. Once the
      // write-up exists it was written from a particular set of notes, and
      // editing them afterwards leaves the pair quietly disagreeing with no
      // record of which came first. Editable right through `ended`, which is
      // the window where a presenter is still adding what came up in the room.
      if (session.status === "synthesized") {
        refuse(session, "given new presenter notes");
      }
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
        // the old time before deciding on a replacement, or the lab gets a prep
        // digest for a session that is no longer two hours away.
        await cancelPrepDigest(ctx, session);

        // Inside the two-hour window there is no boundary left to arm. The
        // session's original prep digest has very likely already gone out —
        // the lab is moving a meeting it was about to hold — and
        // `schedulePrepDigest` would answer a boundary in the past by running
        // the job a minute from now, which is a second prep digest for the
        // same session. Whoever is late gets the session-start refresh
        // instead, which is the boundary that still lies ahead.
        const boundaryPassed = Date.now() > scheduledAt - PREP_LEAD_MS;
        patch.prepDigestJobId = boundaryPassed
          ? undefined
          : await schedulePrepDigest(ctx, session._id, scheduledAt);
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
 * Start the meeting. Presenter, scheduler, or PI.
 *
 * Deliberately no check that `scheduledAt` has arrived. Labs run late, rooms
 * get double-booked, and a session that starts forty minutes after the calendar
 * said it would is a normal Tuesday — refusing that would only teach people to
 * reschedule before they can press the button. The clock is consulted in one
 * direction only: a session more than a day *ahead* of its time is a misclick,
 * and starting one is not undoable.
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

    // Late is fine and always was. A day early is not: starting a session is
    // irreversible — it burns the prep boundary, fires the start digest, and
    // there is no transition back to `scheduled` — so the one case worth
    // refusing is the one that is obviously a misclick in a list of meetings.
    const { canStart } = startWindow(session.scheduledAt, Date.now());
    if (!canStart) {
      throw new ConvexError(
        `That session is still ${awayProse(session.scheduledAt - Date.now())}. Start it closer to the time, or reschedule it if the meeting really has moved.`,
      );
    }

    // A meeting that has begun is past its prep boundary. If the job is still
    // queued — an early start, or a session put on the calendar minutes ago —
    // it has nothing left to prepare for.
    await cancelPrepDigest(ctx, session);

    await ctx.db.patch(session._id, {
      status: "live",
      startedAt: Date.now(),
      prepDigestJobId: undefined,
    });

    // The second of the architecture decision's two session boundaries: a
    // refresh at the moment the meeting starts, catching everything written in
    // the two hours the prep digest could not see. Queued rather than run
    // inline so the start button does not wait on it, and after the patch so
    // the job re-reads a session that is already `live` — which is exactly the
    // condition it checks before delivering. No handle is kept: this one runs
    // immediately and there is no later edit that could want it called off.
    await ctx.scheduler.runAfter(0, internal.digests.buildSessionPrep, {
      sessionId: session._id,
      boundary: "session-start",
      expectedScheduledAt: session.scheduledAt,
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
 * End the meeting. Presenter, scheduler, or PI.
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
 * Call off a meeting that hasn't happened. Presenter, scheduler, or PI.
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
 * The two moves back
 * ---------------------------------------------------------------------- */

/**
 * Whether a forward move is still close enough behind us to be taken back.
 *
 * A row with no timestamp at all is treated as lapsed rather than as fresh.
 * The field is written by the mutation that made the move, so its absence
 * means a session that reached this status some other way — a migration, a
 * row from before the field existed — and "I cannot tell when this happened"
 * is not a reason to allow an undo.
 */
function withinUndoWindow(at: number | undefined): boolean {
  return at !== undefined && Date.now() - at <= UNDO_WINDOW_MS;
}

/**
 * Take back an End pressed by mistake. Presenter, scheduler, or PI.
 *
 * The one backwards edge out of `ended`, and it exists because the End button
 * sits next to everything else on a live session and a meeting that is still
 * going does not become over because somebody's cursor slipped. Ten minutes,
 * and only ten: past that the lab has moved on, the digest boundaries have
 * fired, and what looks like an undo is really a request to hold the meeting
 * again — which is a new session.
 *
 * It deliberately does not touch synthesis or brief state. A draft written
 * against an ended session is somebody's work, and reopening is a correction
 * to the status, not a rollback of the afternoon. Ending again later writes a
 * fresh `session.ended`, which is the honest record: the second end is when
 * the room actually emptied.
 *
 * The one thing it waits for is a synthesis being written *right now*. That
 * work is somebody's too, and it is the only work in the product that is
 * already paid for by the time this mutation runs — the model call is in
 * flight, and `synthesis.store` will only write to a session that has ended.
 * A reopen inside the lease would therefore not cancel the run; it would let
 * it finish and then throw its output away, which is the one outcome an undo
 * has no business causing. So the undo waits the couple of minutes out.
 */
export const reopenSession = mutation({
  args: { sessionId: v.id("sessions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { session, membership } = await requireSessionAccess(
      ctx,
      args.sessionId,
    );
    requireManage(session, membership);
    if (session.status !== "ended") {
      refuse(session, "reopened");
    }
    if (!withinUndoWindow(session.endedAt)) {
      throw new ConvexError(
        "That session ended more than ten minutes ago. An End can be taken back for ten minutes — from the toast, or from the session's own page while the window is open. Past that, meeting about this paper again is a new session.",
      );
    }
    // Checked after the window, and the order is the message: a lapsed undo is
    // a permanent no, and "wait for it to land" would be a lie told to
    // somebody who has no way back anyway.
    if (
      session.synthesisGeneratingAt !== undefined &&
      Date.now() - session.synthesisGeneratingAt < GENERATION_LEASE_MS
    ) {
      throw new ConvexError(
        "A write-up for this session is being written right now. Wait for it to land before reopening the meeting.",
      );
    }

    // No digest to re-arm: `endSession` armed nothing, and the two boundaries
    // this session had were both spent on the way in.
    await ctx.db.patch(session._id, {
      status: "live",
      endedAt: undefined,
    });
    await recordEvent(ctx, {
      labId: session.labId,
      type: "session.reopened",
      actorId: membership.userId,
      paperId: session.paperId,
      sessionId: session._id,
    });
    return null;
  },
});

/**
 * Put back a meeting cancelled by mistake. Presenter, scheduler, or PI.
 *
 * Cancelling calls off the T−2h prep digest, so restoring has to arm it again
 * — otherwise the undo hands back a session on the calendar that has quietly
 * lost the boundary it was scheduled with, and nobody finds out until the
 * morning of the meeting when the digest doesn't arrive.
 *
 * A restored session whose hour has already passed gets no job, which is the
 * rule `createSession` enforces from the other side: `cleanScheduledAt` will
 * not put a meeting in the past on the calendar at all, so nothing here should
 * arm a "coming up in two hours" digest about yesterday. The same clock-skew
 * grace applies, so "this afternoon" does not become the past because a laptop
 * is three minutes fast.
 *
 * And it is held to the same calendar ceiling as scheduling one, because it
 * puts the same row back in the same list — see the check below for the way
 * around the cap that an unchecked undo would open.
 */
export const restoreSession = mutation({
  args: { sessionId: v.id("sessions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { session, membership } = await requireSessionAccess(
      ctx,
      args.sessionId,
    );
    requireManage(session, membership);
    if (session.status !== "cancelled") {
      refuse(session, "restored");
    }
    if (!withinUndoWindow(session.cancelledAt)) {
      throw new ConvexError(
        "That session was cancelled more than ten minutes ago. A cancellation can be taken back for ten minutes — from the toast, or from the session's own page while the window is open. Past that, holding the meeting after all means putting it back on the calendar as a new one.",
      );
    }

    // The ceiling `createSession` enforces, enforced again on the way back.
    // Restoring puts a meeting on the calendar exactly as scheduling one does,
    // and an undo that walked past the cap is a way through it: a lab at fifty
    // cancels one, schedules its replacement, restores the cancelled one, and
    // lands at fifty-one with an extra prep-digest job queued behind it. One
    // past the cap, so the check reads the same at the ceiling as over it.
    const outstanding = await ctx.db
      .query("sessions")
      .withIndex("by_lab_and_status", (q) =>
        q.eq("labId", session.labId).eq("status", "scheduled"),
      )
      .take(MAX_SCHEDULED_SESSIONS + 1);
    if (outstanding.length >= MAX_SCHEDULED_SESSIONS) {
      throw new ConvexError(
        `This lab already has ${MAX_SCHEDULED_SESSIONS} sessions on the calendar. Hold or cancel one before putting this one back.`,
      );
    }

    const stillAhead = session.scheduledAt >= Date.now() - CLOCK_SKEW_GRACE_MS;
    await ctx.db.patch(session._id, {
      status: "scheduled",
      cancelledAt: undefined,
      prepDigestJobId: stillAhead
        ? await schedulePrepDigest(ctx, session._id, session.scheduledAt)
        : undefined,
    });
    await recordEvent(ctx, {
      labId: session.labId,
      type: "session.restored",
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
 *
 * ## What `countsTruncated` actually means
 *
 * The bound is on the *window read*, not on the rows counted. The query takes
 * the first `MAX_COUNTED_ANNOTATIONS + 1` rows for the session and then drops
 * the deleted ones and other people's private ones, so a session whose window
 * is full of those returns counts lower than the visible total while
 * `countsTruncated` is true. Read the flag as "there is more here than this
 * query looked at", not as "the number below is exactly the cap". Nothing
 * over-reports; the failure is only ever an undercount, and only past a
 * thousand annotations in a single meeting. A session that big wants a real
 * aggregate — a counter maintained on write — rather than a bigger `take`.
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
      // The privacy constitution, in two lines: what the lab can see, plus
      // what the caller wrote. Nothing else is ever counted here, and nothing
      // here is ever broken down by member — a per-type tally sliced by author
      // is a reading dashboard, which is the thing the constitution forbids,
      // and it stays forbidden however innocuous the aggregate it hides in
      // looks. If a future view wants "who has annotated", it does not get it
      // from this query; it does not get it.
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
