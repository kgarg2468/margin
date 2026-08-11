import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { getMembership, requireUserId } from "./lib/authz";
import { annotationType } from "./schema";
import { isStillShared } from "../lib/citations/visibility";
import {
  changedSince,
  mostRecentMeetings,
  positionChanges,
  unresolvedAcrossMeetings,
  type AnnotationFact,
  type HeldMeeting,
  type TemporalNote,
} from "../lib/temporal/derive";

/**
 * The temporal index: one paper's memory of itself.
 *
 * Everything else in this backend answers a question about *now* — what the
 * margin says, who is presenting, what the write-up concluded. This answers
 * three questions about time, and it is the first surface in the product whose
 * subject is the shape of a paper's history rather than its contents:
 *
 * 1. **What has the lab failed to settle** — open questions that have outlasted
 *    more than one meeting.
 * 2. **Where has somebody moved** — notes retyped from one thing into another,
 *    and notes taken back and put out again.
 * 3. **What has changed since we last met on this** — one paper, anchored to a
 *    meeting on the lab's own calendar.
 *
 * This module is the plumbing: reads, authorization, and the visibility gate.
 * The policy is `lib/temporal/derive.ts`, which is pure and unit-tested.
 *
 * ## Derived, never stored
 *
 * There is no `temporalIndex` table and this file writes nothing — not a row,
 * not a ledger event. Everything it returns is computed on read from data that
 * already exists: the annotations, the sessions, and the append-only ledger.
 * That is not thrift. A stored index of "what is still unresolved" would be a
 * second copy of a claim about rows that move underneath it — a question
 * answered on Tuesday would sit in the index as unresolved until something
 * remembered to go and rebuild it, and a note withdrawn on Wednesday would keep
 * a line about it alive in a table nobody re-checks. Computing it means the
 * index cannot be stale and cannot outlive its sources, which is the same
 * property `convex/synthesis.ts` pays for with `applyWithdrawals` and the same
 * property the whole memory layer rests on.
 *
 * It also writes no ledger event, for the reason `convex/digests.ts` gives: the
 * ledger records collective facts, and "somebody opened the memory panel" is an
 * attention trail wearing a fact's clothes.
 *
 * ## Three things this file will not do
 *
 * 1. **It never reads a private annotation.** The pool is pinned to
 *    `by_paper_and_visibility` at `"lab"` and then run through `isStillShared`
 *    — the predicate `convex/synthesis.ts` exports and `convex/briefs.ts`
 *    imports rather than restates. The ledger *is* read here, and the ledger
 *    knows about private notes; nothing it says is ever reported except as a
 *    fact about an annotation that survived that gate. The events table is the
 *    memory of when things happened, not a way around who may see them.
 * 2. **It never counts what disappeared.** See `changedSince` in
 *    `lib/temporal/derive.ts`: a count of withdrawals cannot be assembled from
 *    anything a reader is allowed to see.
 * 3. **It reads no cursor and moves none.** "What changed since" here is
 *    anchored to a meeting the whole lab attended, not to when the reader last
 *    looked. Opening this surface records nothing, which is the only way it can
 *    exist under a constitution that forbids read tracking.
 */

/* -------------------------------------------------------------------------
 * Policy constants
 * ---------------------------------------------------------------------- */

/**
 * Ceiling on how much of a paper's margin the index reads.
 *
 * The same thousand `convex/briefs.ts` and `convex/digests.ts` use, read
 * newest-first for the same reason they do.
 *
 * There is one cost here that they do not pay, and it is worth naming. The
 * unresolved lens wants a paper's *oldest* questions — those are the ones that
 * have outlasted most meetings — and a newest-first cap is exactly the wrong end
 * to keep for them. That is the right trade anyway: a single paper with more
 * than a thousand annotations on it is far outside the shape of a journal club,
 * and reading oldest-first instead would break "what changed since", which is
 * the lens a reader opens most. When a paper does run past the cap the surface
 * says so (`truncated`) rather than quietly reporting on a slice.
 */
const POOL_LIMIT = 1000;

/**
 * How much of one paper's ledger the index walks.
 *
 * Newest-first, so a paper that has run away with itself contributes the live
 * end of its history. A note whose `annotation.created` fell outside this window
 * has no known starting type and simply contributes no retype line — see
 * `positionChanges`, which prefers a short answer to a confident wrong one.
 */
const LEDGER_LIMIT = 1000;

/**
 * How many meetings on one paper the index reaches back through.
 *
 * `convex/briefs.ts`'s number, and the same judgement: a lab that has read one
 * paper across fifty meetings has a different problem than this feature solves.
 */
const MEETING_LIMIT = 50;

/**
 * How many qualifying sessions are read before the clock picks the fifty.
 *
 * Wider than `MEETING_LIMIT` on purpose — see `heldMeetings`. The cap has to
 * fall on meeting order, meeting order is not the order this index offers, and
 * the only way to sort by a clock the index does not hold is to have the rows
 * in hand first. Five times the cap, because it costs a bounded read of one
 * paper's own sessions and it puts the ceiling somewhere a real paper cannot
 * reach: a lab would have to have held two hundred and fifty journal clubs on a
 * single paper before the reordering this protects against could hide behind it.
 */
const MEETING_SCAN_LIMIT = 250;

/** How many meetings the reader may anchor the "since" window to. */
const ANCHOR_CHOICES = 8;

/* -------------------------------------------------------------------------
 * Validators
 * ---------------------------------------------------------------------- */

const meeting = v.object({
  sessionId: v.id("sessions"),
  at: v.number(),
});

const unresolvedItem = v.object({
  annotationId: v.id("annotations"),
  memberId: v.id("users"),
  memberName: v.string(),
  body: v.string(),
  quote: v.string(),
  pageIndex: v.number(),
  askedAt: v.number(),
  meetings: v.number(),
  lastMeetingId: v.id("sessions"),
  lastMeetingAt: v.number(),
  raisedInSessionId: v.optional(v.id("sessions")),
});

const positionItem = v.object({
  annotationId: v.id("annotations"),
  memberId: v.id("users"),
  memberName: v.string(),
  body: v.string(),
  quote: v.string(),
  pageIndex: v.number(),
  type: annotationType,
  retyped: v.optional(
    v.object({ from: annotationType, to: annotationType }),
  ),
  restated: v.optional(
    v.object({ takenBackAt: v.number(), restatedAt: v.number() }),
  ),
  revisions: v.number(),
  movedAt: v.number(),
});

const arrivedItem = v.object({
  annotationId: v.id("annotations"),
  memberId: v.id("users"),
  memberName: v.string(),
  type: annotationType,
  body: v.string(),
  quote: v.string(),
  pageIndex: v.number(),
  writtenAt: v.number(),
  arrivedAt: v.number(),
});

const changedWindow = v.object({
  /** Where the window starts, and the meeting it was taken from if it was. */
  anchor: v.object({
    at: v.number(),
    sessionId: v.optional(v.id("sessions")),
  }),
  arrived: v.object({
    items: v.array(arrivedItem),
    droppedCount: v.number(),
  }),
  counts: v.object({
    written: v.number(),
    shared: v.number(),
    replies: v.number(),
    revised: v.number(),
  }),
  meetings: v.array(meeting),
});

const temporalIndex = v.object({
  paperId: v.id("papers"),
  labId: v.id("labs"),
  unresolved: v.object({
    items: v.array(unresolvedItem),
    droppedCount: v.number(),
  }),
  positions: v.object({
    items: v.array(positionItem),
    droppedCount: v.number(),
  }),
  /** `null` until the lab has held a meeting on this paper — there is no "since" before that. */
  changed: v.union(v.null(), changedWindow),
  /** Meetings the reader may re-anchor the window to, most recent first. */
  anchors: v.array(meeting),
  /** True when a read hit its cap, so the surface can say it is reading the recent end. */
  truncated: v.boolean(),
});

/* -------------------------------------------------------------------------
 * Reads
 * ---------------------------------------------------------------------- */

/**
 * Meetings on this paper that actually happened, most recent first.
 *
 * `ended` and `synthesized` only, and the filter is a condition on the query
 * rather than a pass over its results — the same care `convex/briefs.ts` takes
 * with the same read, and for the same reason: a cap that falls on rows which
 * do not qualify silently shortens the window it was meant to bound.
 *
 * A cancelled meeting is not a meeting. A question written while one sat on the
 * calendar was never taken to a floor, so it has outlasted nothing.
 *
 * ## Why the read is wider than the cap
 *
 * `by_paper` is creation order, and creation order is not meeting order. A
 * session backdated after the fact — or deleted and re-created to fix a typo —
 * sits at the newest end of that index and the oldest end of the calendar, so
 * taking `MEETING_LIMIT` rows here and sorting the survivors by the clock would
 * choose the most recently *typed* meetings and then present them as the most
 * recent meetings. The wrong one drops out, a question's count of meetings
 * outlasted quietly falls by one, and the "since" picker offers dates that are
 * not the paper's last few.
 *
 * So this reads every qualifying session up to a much larger ceiling and lets
 * `mostRecentMeetings` apply the cap on the clock. The ceiling is the honest
 * remainder of the problem: `sessions` has no index on (paper, time) — only
 * `by_lab_and_scheduled`, which would mean scanning the whole lab's calendar to
 * answer a question about one paper — so there is a number past which this read
 * stops, and it is set where a paper could never reach it rather than where a
 * busy one might. When the cap does bite, the caller says so.
 */
async function heldMeetings(
  ctx: QueryCtx,
  paperId: Id<"papers">,
): Promise<{ meetings: HeldMeeting<Id<"sessions">>[]; truncated: boolean }> {
  const rows = await ctx.db
    .query("sessions")
    .withIndex("by_paper", (q) => q.eq("paperId", paperId))
    .order("desc")
    .filter((q) =>
      q.or(
        q.eq(q.field("status"), "ended"),
        q.eq(q.field("status"), "synthesized"),
      ),
    )
    .take(MEETING_SCAN_LIMIT);

  // `endedAt` rather than `scheduledAt`: the boundary a note falls on either
  // side of is when the room emptied, and a note written in the last ten
  // minutes of a meeting was written during it, not after it. The booked time
  // is the fallback for a row that somehow has no end. Both the choice and the
  // keep-the-most-recent selection live in `mostRecentMeetings`, where they are
  // unit-tested.
  return {
    meetings: mostRecentMeetings(
      rows.map((session) => ({
        id: session._id,
        scheduledAt: session.scheduledAt,
        endedAt: session.endedAt,
      })),
      MEETING_LIMIT,
    ),
    truncated: rows.length > MEETING_LIMIT,
  };
}

/**
 * The ledger facts the index reads, narrowed to three kinds and to annotations
 * the caller can already see.
 *
 * The second half of that sentence is the load-bearing one. `events` holds rows
 * about private notes — an `annotation.created` row carries the visibility it
 * was created with, and a `visibility_changed` row exists for every flip in
 * either direction. Filtering to `visible` here means nothing downstream can
 * report on a note that is not currently in front of the lab, however it is
 * asked. Privacy is the filter on the way *in*, not a check each lens has to
 * remember on the way out.
 */
function readFacts(
  events: readonly Doc<"events">[],
  visible: ReadonlySet<Id<"annotations">>,
): AnnotationFact<Id<"annotations">>[] {
  const facts: AnnotationFact<Id<"annotations">>[] = [];
  for (const event of events) {
    if (event.type === "annotation.created") {
      if (!visible.has(event.annotationId)) continue;
      facts.push({
        annotationId: event.annotationId,
        at: event.at,
        kind: "created",
        createdAs: event.annotationType,
        visibility: event.visibility,
      });
    } else if (event.type === "annotation.edited") {
      if (!visible.has(event.annotationId)) continue;
      facts.push({
        annotationId: event.annotationId,
        at: event.at,
        kind: "edited",
      });
    } else if (event.type === "annotation.visibility_changed") {
      if (!visible.has(event.annotationId)) continue;
      facts.push({
        annotationId: event.annotationId,
        at: event.at,
        kind: "visibility",
        visibility: event.visibility,
      });
    }
  }
  return facts;
}

/**
 * Where the "what changed since" window starts.
 *
 * The default is the last meeting the lab held on this paper, because that is
 * the question somebody standing in front of the paper's record is actually
 * asking. A reader can move it to an earlier meeting, or hand over a date of
 * their own — a member back from three weeks of fieldwork is asking about a
 * span the calendar has no name for.
 *
 * A session id that is not a held meeting on *this* paper falls back to the
 * default rather than refusing. It is a display anchor, not a permission, and
 * there is nothing behind it to leak: the window it opens is over rows this
 * caller may already read, every one of which they could reach by scrolling.
 */
function resolveAnchor(
  meetings: readonly HeldMeeting<Id<"sessions">>[],
  sinceSessionId: Id<"sessions"> | undefined,
  sinceAt: number | undefined,
): { at: number; sessionId?: Id<"sessions"> } | null {
  if (sinceSessionId !== undefined) {
    const chosen = meetings.find((one) => one.id === sinceSessionId);
    if (chosen !== undefined) {
      return { at: chosen.at, sessionId: chosen.id };
    }
  }
  if (sinceAt !== undefined && Number.isFinite(sinceAt)) {
    return { at: sinceAt };
  }
  const latest = meetings[0];
  return latest === undefined ? null : { at: latest.at, sessionId: latest.id };
}

/* -------------------------------------------------------------------------
 * The query
 * ---------------------------------------------------------------------- */

/**
 * One paper's temporal index.
 *
 * `null` for a paper the caller cannot see, with no distinction between "no
 * such paper" and "not your lab" — the posture `papers.getPaper` takes, and the
 * reason this returns rather than throws: the panel this feeds is one section of
 * a page, and a section that cannot be drawn should be absent, not an error
 * across the whole record.
 *
 * One query rather than three, and one subscription rather than three. The
 * lenses share their reads almost entirely — the same margin, the same ledger
 * slice, the same calendar — so three functions would mean three scans of the
 * same rows to draw one panel, and three chances for two of them to disagree
 * about what the lab currently looks like.
 */
export const forPaper = query({
  args: {
    paperId: v.id("papers"),
    /** Anchor the "since" window to this meeting instead of the most recent one. */
    sinceSessionId: v.optional(v.id("sessions")),
    /** Or to a moment of the reader's own choosing, for an absence the calendar has no name for. */
    sinceAt: v.optional(v.number()),
  },
  returns: v.union(v.null(), temporalIndex),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const paper = await ctx.db.get(args.paperId);
    if (paper === null) {
      return null;
    }
    if ((await getMembership(ctx, paper.labId, userId)) === null) {
      return null;
    }

    // Privacy is the index, not a filter: `by_paper_and_visibility` at "lab"
    // cannot return a private annotation, and `isStillShared` — the predicate
    // the synthesis and the brief both apply, imported rather than restated —
    // takes out the withdrawn ones and re-checks the lab on the way past.
    const pool = await ctx.db
      .query("annotations")
      .withIndex("by_paper_and_visibility", (q) =>
        q.eq("paperId", args.paperId).eq("visibility", "lab"),
      )
      .order("desc")
      .take(POOL_LIMIT);
    const live = pool.filter((row) => isStillShared(row, paper.labId));

    // Author display names, resolved once for the whole index.
    const names = new Map<Id<"users">, string>();
    for (const authorId of new Set(live.map((row) => row.memberId))) {
      const user = await ctx.db.get(authorId);
      names.set(authorId, user?.name ?? user?.email ?? "A lab member");
    }

    const notes: TemporalNote<
      Id<"annotations">,
      Id<"users">,
      Id<"sessions">
    >[] = live.map((row) => ({
      id: row._id,
      memberId: row.memberId,
      memberName: names.get(row.memberId) ?? "A lab member",
      type: row.type,
      body: row.body,
      quote: row.anchor.quote,
      pageIndex: row.anchor.pageIndex,
      createdAt: row._creationTime,
      ...(row.editedAt === undefined ? {} : { editedAt: row.editedAt }),
      ...(row.parentId === undefined ? {} : { parentId: row.parentId }),
      ...(row.sessionId === undefined ? {} : { sessionId: row.sessionId }),
    }));

    const events = await ctx.db
      .query("events")
      .withIndex("by_paper_and_at", (q) => q.eq("paperId", args.paperId))
      .order("desc")
      .take(LEDGER_LIMIT);
    const facts = readFacts(events, new Set(live.map((row) => row._id)));

    const { meetings, truncated: moreMeetings } = await heldMeetings(
      ctx,
      args.paperId,
    );
    const anchor = resolveAnchor(meetings, args.sinceSessionId, args.sinceAt);

    const changed =
      anchor === null
        ? null
        : (() => {
            const window = changedSince({
              notes,
              facts,
              meetings,
              since: anchor.at,
            });
            return {
              anchor,
              arrived: window.arrived,
              counts: window.counts,
              meetings: window.meetings.map((one) => ({
                sessionId: one.id,
                at: one.at,
              })),
            };
          })();

    return {
      paperId: paper._id,
      labId: paper.labId,
      unresolved: unresolvedAcrossMeetings({ notes, meetings }),
      positions: positionChanges({ notes, facts }),
      changed,
      anchors: meetings
        .slice(0, ANCHOR_CHOICES)
        .map((one) => ({ sessionId: one.id, at: one.at })),
      // Any of the three reads hitting its cap means the lenses are reading
      // this paper's recent end rather than the whole of it. The meetings one
      // matters most to say out loud: past it, "outlasted three meetings" is a
      // floor rather than a count.
      truncated:
        pool.length === POOL_LIMIT ||
        events.length === LEDGER_LIMIT ||
        moreMeetings,
    };
  },
});
