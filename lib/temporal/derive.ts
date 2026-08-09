/**
 * The temporal index, as pure functions.
 *
 * Ctx-free in the same way `lib/digest/engine.ts` and `lib/brief/assemble.ts`
 * are, and for the same reason: `convex/temporal.ts` does the reading, the
 * authorization and the visibility checks, and this module decides what the
 * lab's memory actually says. The policy is unit-testable against the shapes it
 * was written for rather than against a deployment.
 *
 * ## Three questions with a shape a text search cannot have
 *
 * Everything else in this product answers "what did somebody write". These
 * three are about *time*, and two of them are about an absence — which is the
 * whole reason they need an index rather than a query box. No passage in any
 * paper contains the sentence "nobody has answered this in three meetings".
 *
 * 1. **Still unanswered** — open questions that have outlasted more than one
 *    meeting the lab actually held.
 * 2. **Where positions moved** — notes whose author changed what they were:
 *    retyped from one thing to another, or taken back and put out again.
 * 3. **What changed since** — one paper, one moment, what has arrived in front
 *    of the lab since then.
 *
 * ## How this is not the brief's carried-over section
 *
 * `assembleBrief` has a "still open from earlier sessions" lens and it asks a
 * different question: *which* meeting left this open, for the presenter of the
 * next one, and it decides by the session a question was written **under**. A
 * question typed on an ordinary Tuesday, under no session at all, is invisible
 * to it however many meetings have since come and gone.
 *
 * This asks how many meetings a question has *outlasted*, and decides by the
 * clock: any held meeting whose end is later than the question. That catches
 * the Tuesday question, it is a number rather than a link, and it grows on its
 * own while nobody touches the note. One is prep for Thursday; this is the
 * paper's own record of what the lab has failed to settle.
 *
 * ## What this module cannot do, structurally
 *
 * It never receives a private or withdrawn note. `convex/temporal.ts` filters
 * the pool through `isStillShared` before anything here sees it, so there is no
 * argument to any function below that would make one appear in a line — the
 * privacy rule is a property of the input rather than a check each function has
 * to remember. That is also why nothing here reports a *count* of what has gone
 * away: see `changedSince`.
 */

import type { AnnotationType } from "../digest/engine";

/* -------------------------------------------------------------------------
 * Shapes
 * ---------------------------------------------------------------------- */

/**
 * One annotation, flattened to what the index reads.
 *
 * Declared structurally rather than imported from `DigestAnnotation` because
 * the fields differ: no `start`/`end` (nothing here pairs anchors) and no
 * `paperId` (the whole index is one paper's). Same reasoning as `MarginRow` in
 * `lib/brief/prep.ts`, and it keeps `lib/` free of any dependency on `app/`.
 *
 * There is deliberately no `visibility` and no `deletedAt`. Every note handed
 * to this module is one the lab can currently read; a shape that could express
 * "private" would be a shape a future caller could pass one in.
 */
export type TemporalNote<
  AnnotationId extends string = string,
  UserId extends string = string,
  SessionId extends string = string,
> = {
  id: AnnotationId;
  memberId: UserId;
  /** Display name of the author, already resolved. */
  memberName: string;
  /** What it is *now*. What it started as comes from the ledger. */
  type: AnnotationType;
  /** What the member wrote. Empty is normal — typing a passage is one tap. */
  body: string;
  /** The passage it is anchored to, for notes that were marked without a comment. */
  quote: string;
  pageIndex: number;
  createdAt: number;
  /** When the prose was last rewritten, if it ever was. */
  editedAt?: number;
  /** Set when this is a reply. A reply is never an item; it is what answers one. */
  parentId?: AnnotationId;
  /** The session it was written under, if it was written under one. */
  sessionId?: SessionId;
};

/**
 * A meeting that actually happened, and when the room emptied.
 *
 * Cancelled and still-scheduled sessions are not meetings and never appear
 * here — a question written while a cancelled session sat on the calendar was
 * never taken to a floor, so it has outlasted nothing. The caller decides that
 * (`convex/temporal.ts` pins it to the query), because a filter applied after a
 * cap is a filter that spends the budget on rows that do not qualify.
 */
export type HeldMeeting<SessionId extends string = string> = {
  id: SessionId;
  /**
   * When it ended, falling back to when it was booked for if the row has no
   * end. The boundary matters more than the calendar entry: a note written in
   * the last ten minutes of a meeting was written *during* it, not after it.
   */
  at: number;
};

/**
 * The three ledger facts this index reads, already narrowed.
 *
 * Mapped by `convex/temporal.ts` out of the `events` union rather than passed
 * through raw, so this module cannot accidentally grow a dependency on a fourth
 * event type — and so the list of what the memory layer reads out of the
 * append-only ledger is one type declaration long.
 *
 * Note what is absent: `annotation.deleted`. It carries no visibility, so a
 * count of deletions would be a count that includes notes the reader was never
 * allowed to know existed.
 */
export type AnnotationFact<AnnotationId extends string = string> = {
  annotationId: AnnotationId;
  at: number;
  kind: "created" | "edited" | "visibility";
  /** On `created`: the type the author first reached for. */
  createdAs?: AnnotationType;
  /** On `created` and `visibility`: the audience it moved to. */
  visibility?: "lab" | "private";
};

/* -------------------------------------------------------------------------
 * Policy constants
 * ---------------------------------------------------------------------- */

/**
 * How many meetings a question has to have outlasted before it is *carried*
 * rather than merely open.
 *
 * Two, because one is ordinary. Every question written before a meeting
 * survives that meeting unless somebody types an answer under it, and most of
 * them are answered out loud — the lab discussed it, nobody wrote it down, and
 * the note stays open because writing replies is not what people do in a room
 * together. A question that has sat through a *second* meeting is a different
 * animal: the lab has now had two chances at it and the paper's record still
 * has nothing under it.
 */
export const MIN_MEETINGS_OUTLASTED = 2;

/**
 * How many lines a lens will carry.
 *
 * The brief's six, and for the brief's reason: this is a page somebody opened
 * on purpose, so the constraint is legibility rather than attention. Not the
 * digest's five — that cap is a budget for an interruption.
 */
export const MAX_LENS_ITEMS = 6;

/** A lens, and how much of it the cap held back. */
export type Lens<Item> = {
  items: Item[];
  /** Candidates the cap kept out, so the surface can say so instead of pretending. */
  droppedCount: number;
};

function lens<Item>(candidates: readonly Item[], cap: number): Lens<Item> {
  return {
    items: candidates.slice(0, cap),
    droppedCount: Math.max(0, candidates.length - cap),
  };
}

/** How many replies each note is carrying, from the pool itself. */
function replyCounts<A extends string>(
  notes: readonly { id: A; parentId?: A }[],
): Map<A, number> {
  const counts = new Map<A, number>();
  for (const note of notes) {
    const parentId = note.parentId;
    if (parentId === undefined) continue;
    counts.set(parentId, (counts.get(parentId) ?? 0) + 1);
  }
  return counts;
}

/** The paper's facts, per annotation, oldest first. */
function factsByAnnotation<A extends string>(
  facts: readonly AnnotationFact<A>[],
): Map<A, AnnotationFact<A>[]> {
  const byId = new Map<A, AnnotationFact<A>[]>();
  for (const fact of facts) {
    const bucket = byId.get(fact.annotationId);
    if (bucket === undefined) {
      byId.set(fact.annotationId, [fact]);
    } else {
      bucket.push(fact);
    }
  }
  // The ledger is read newest-first so that a paper with more history than the
  // cap contributes the live end of it. Every reading below walks a note's life
  // forwards, so the order is put back here once rather than reasoned about
  // three times.
  for (const bucket of byId.values()) {
    bucket.sort((x, y) => x.at - y.at);
  }
  return byId;
}

/* -------------------------------------------------------------------------
 * 1. Still unanswered
 * ---------------------------------------------------------------------- */

export type Unresolved<
  AnnotationId extends string = string,
  UserId extends string = string,
  SessionId extends string = string,
> = {
  annotationId: AnnotationId;
  memberId: UserId;
  memberName: string;
  body: string;
  quote: string;
  pageIndex: number;
  askedAt: number;
  /** Meetings the lab held on this paper after it was asked, all of them without an answer. */
  meetings: number;
  /** The most recent of those, so the line can say where it last went unanswered. */
  lastMeetingId: SessionId;
  lastMeetingAt: number;
  /** The meeting it was written under, when it was written under one. */
  raisedInSessionId?: SessionId;
};

/**
 * Open questions that have outlasted more than one meeting.
 *
 * "Unanswered" is *no replies at all*, which is the same threshold
 * `assembleBrief` uses and has to be: a question with a thread under it is
 * being handled, and two definitions of "answered" in one product means one of
 * them is out of date. A reply by the asker counts — talking yourself out of a
 * question is an answer, and the alternative is a rule that reads somebody's
 * mind about whether their own follow-up settled anything.
 *
 * No duration is returned. How long ago something was is a sentence with a
 * timezone and a reader in it, and neither of them is here; `askedAt` is an
 * epoch and the client already formats those. What *is* returned is the count
 * of meetings, because that number is not a matter of the reader's clock — it
 * is a fact about the lab's calendar, and it is the whole point of the lens.
 *
 * Ranked by meetings outlasted, then oldest first. A question that has survived
 * four meetings is a harder fact about the lab than one that survived two,
 * whatever order they were written in.
 */
export function unresolvedAcrossMeetings<
  A extends string,
  U extends string,
  S extends string,
>(input: {
  notes: readonly TemporalNote<A, U, S>[];
  meetings: readonly HeldMeeting<S>[];
  cap?: number;
  /** Override for tests; the shipped threshold is `MIN_MEETINGS_OUTLASTED`. */
  minMeetings?: number;
}): Lens<Unresolved<A, U, S>> {
  const minMeetings = input.minMeetings ?? MIN_MEETINGS_OUTLASTED;
  const replies = replyCounts(input.notes);

  // Newest meeting first, so the walk can stop at the first one that predates
  // the question instead of scanning the lab's whole history per note.
  const meetings = input.meetings
    .slice()
    .sort((x, y) => y.at - x.at || (x.id < y.id ? -1 : 1));

  const candidates: Unresolved<A, U, S>[] = [];

  for (const note of input.notes) {
    if (note.type !== "open-question") continue;
    if (note.parentId !== undefined) continue;
    if ((replies.get(note.id) ?? 0) > 0) continue;

    let outlasted = 0;
    let last: HeldMeeting<S> | undefined;
    for (const meeting of meetings) {
      if (meeting.at <= note.createdAt) break;
      if (last === undefined) last = meeting;
      outlasted += 1;
    }
    if (outlasted < minMeetings || last === undefined) continue;

    candidates.push({
      annotationId: note.id,
      memberId: note.memberId,
      memberName: note.memberName,
      body: note.body,
      quote: note.quote,
      pageIndex: note.pageIndex,
      askedAt: note.createdAt,
      meetings: outlasted,
      lastMeetingId: last.id,
      lastMeetingAt: last.at,
      ...(note.sessionId === undefined
        ? {}
        : { raisedInSessionId: note.sessionId }),
    });
  }

  candidates.sort(
    (x, y) =>
      y.meetings - x.meetings ||
      x.askedAt - y.askedAt ||
      (x.annotationId < y.annotationId ? -1 : 1),
  );

  return lens(candidates, input.cap ?? MAX_LENS_ITEMS);
}

/* -------------------------------------------------------------------------
 * 2. Where positions moved
 * ---------------------------------------------------------------------- */

export type PositionChange<
  AnnotationId extends string = string,
  UserId extends string = string,
> = {
  annotationId: AnnotationId;
  memberId: UserId;
  memberName: string;
  body: string;
  quote: string;
  pageIndex: number;
  /** What it is now — `retyped.to` when it was retyped, and the same value either way. */
  type: AnnotationType;
  /** Set when the author changed what kind of thing this is. */
  retyped?: { from: AnnotationType; to: AnnotationType };
  /** Set when the author took it back from the lab and later put it out again. */
  restated?: { takenBackAt: number; restatedAt: number };
  /**
   * How many edits the ledger recorded on this note. Texture, never a reason to
   * appear here.
   *
   * Edits, not rewrites: `setType` records an `annotation.edited` row alongside
   * `updateBody`, so a note retyped twice and never rewritten still counts two.
   * The ledger does not say which field moved, and a number labelled "rewritten"
   * would be a claim it cannot support. `changedSince` needs the narrower fact
   * and reads `editedAt` off the row instead, which only the prose moves.
   */
  revisions: number;
  /**
   * The most recent moment this note is known to have moved.
   *
   * Known, not exact. Today's ledger records that an annotation was edited and
   * not *which field* moved, so a retype's own moment cannot be separated from a
   * typo fixed the same week: this takes the latest edit, which is the earliest
   * claim the ledger honestly supports. When prior body and type land in the
   * `annotation.edited` event (Phase 2's first item), this becomes exact and
   * nothing above it has to change.
   */
  movedAt: number;
};

/**
 * Notes whose author changed their mind about them.
 *
 * Two movements, and they are the two the substrate can prove from what it
 * already stores:
 *
 * - **Retyped.** The ledger's `annotation.created` says what type the author
 *   first reached for; the row says what it is now. Hypothesis to critique is a
 *   member reading on and deciding the thing they proposed is the thing they
 *   doubt, and it is the cheapest correction in the product — which is exactly
 *   why it is worth surfacing. Nobody writes "I was wrong" in a lab's margin;
 *   they tap a different chip.
 * - **Restated.** Taken back from the lab and later put out again. A member who
 *   un-shares a critique and re-shares it a week later has had a week's second
 *   thoughts about it, and the note reads differently once you know that.
 *
 * A note that was merely rewritten is not here. Fixing a sentence is not
 * changing a position, and a lens that filled up with typo corrections would
 * bury the two movements that mean something. The revision count rides along on
 * the notes that qualify for another reason.
 *
 * ## The two things this cannot see, and what happens instead
 *
 * A note whose `annotation.created` fell outside the caller's ledger window has
 * no known starting type, so it contributes no retype line. It is silently
 * absent rather than reported as unchanged — an index that claimed "nobody has
 * moved" because it could not see far enough would be worse than a short one.
 *
 * A note that is private *now* is absent for a much harder reason: it is not in
 * the pool at all. "Somebody took a note back and left it back" is a fact about
 * a note nobody may read, and there is no phrasing of it that is not a
 * disclosure. Only the round trip that ended in the lab is reportable, and that
 * is the one this returns.
 */
export function positionChanges<
  A extends string,
  U extends string,
  S extends string,
>(input: {
  notes: readonly TemporalNote<A, U, S>[];
  facts: readonly AnnotationFact<A>[];
  cap?: number;
}): Lens<PositionChange<A, U>> {
  const byId = factsByAnnotation(input.facts);
  const candidates: PositionChange<A, U>[] = [];

  for (const note of input.notes) {
    const facts = byId.get(note.id);
    if (facts === undefined) continue;

    let createdAs: AnnotationType | undefined;
    let revisions = 0;
    let lastEditAt: number | undefined;
    let takenBackAt: number | undefined;
    let restated: { takenBackAt: number; restatedAt: number } | undefined;

    for (const fact of facts) {
      if (fact.kind === "created") {
        createdAs = fact.createdAs;
        continue;
      }
      if (fact.kind === "edited") {
        revisions += 1;
        lastEditAt = fact.at;
        continue;
      }
      // A visibility flip. Only a completed round trip is a restatement: going
      // private is where a note leaves the lab's view, and coming back is where
      // it re-enters it. The latest completed trip wins, because a member who
      // has done it twice has most recently done it once.
      if (fact.visibility === "private") {
        takenBackAt = fact.at;
      } else if (fact.visibility === "lab" && takenBackAt !== undefined) {
        restated = { takenBackAt, restatedAt: fact.at };
        takenBackAt = undefined;
      }
    }

    const retyped =
      createdAs !== undefined && createdAs !== note.type
        ? { from: createdAs, to: note.type }
        : undefined;

    if (retyped === undefined && restated === undefined) continue;

    // The latest moment either movement is known to have happened. A retype
    // leaves an edit row behind it, so `lastEditAt` is its bound; a note with a
    // retype and no edit row at all is one whose creation and current type
    // disagree for a reason the ledger cannot show, and falling back to the
    // creation moment says "at some point since" rather than inventing a date.
    const movedAt = Math.max(
      restated?.restatedAt ?? 0,
      retyped === undefined ? 0 : (lastEditAt ?? note.editedAt ?? note.createdAt),
    );

    candidates.push({
      annotationId: note.id,
      memberId: note.memberId,
      memberName: note.memberName,
      body: note.body,
      quote: note.quote,
      pageIndex: note.pageIndex,
      type: note.type,
      ...(retyped === undefined ? {} : { retyped }),
      ...(restated === undefined ? {} : { restated }),
      revisions,
      movedAt,
    });
  }

  candidates.sort(
    (x, y) =>
      y.movedAt - x.movedAt || (x.annotationId < y.annotationId ? -1 : 1),
  );

  return lens(candidates, input.cap ?? MAX_LENS_ITEMS);
}

/* -------------------------------------------------------------------------
 * 3. What changed since
 * ---------------------------------------------------------------------- */

export type ArrivedNote<
  AnnotationId extends string = string,
  UserId extends string = string,
> = {
  annotationId: AnnotationId;
  memberId: UserId;
  memberName: string;
  type: AnnotationType;
  body: string;
  quote: string;
  pageIndex: number;
  /** When the author wrote it. */
  writtenAt: number;
  /**
   * When the lab could first read it. Later than `writtenAt` for a note written
   * privately and shared afterwards — which is a common and deliberate way to
   * use this product, and the one case where "new" and "newly written" are
   * different sentences.
   */
  arrivedAt: number;
};

export type ChangedSince<
  AnnotationId extends string = string,
  UserId extends string = string,
  SessionId extends string = string,
> = {
  /** Top-level notes the lab could not read before this moment and can now. */
  arrived: Lens<ArrivedNote<AnnotationId, UserId>>;
  counts: {
    /** Written since, and shared as they were written. */
    written: number;
    /** Written earlier and put in front of the lab since. */
    shared: number;
    /** Replies added since, on threads of any age. */
    replies: number;
    /** Notes that were already here and have been rewritten since. */
    revised: number;
  };
  /** Meetings the lab held in the window, oldest first. */
  meetings: HeldMeeting<SessionId>[];
};

/**
 * When each note entered the lab's view.
 *
 * `_creationTime` answers when it was *written*, which is a different question
 * whenever somebody drafts privately and shares later — and the schema exists to
 * make that a comfortable thing to do. So arrival is the later of the two: when
 * it was written, or the last time its author handed it to the lab.
 *
 * The last share rather than the first, because a note taken back and put out
 * again arrived again. Somebody who missed both is not owed the older date.
 */
function arrivals<A extends string>(
  facts: readonly AnnotationFact<A>[],
): Map<A, number> {
  const shared = new Map<A, number>();
  for (const fact of facts) {
    if (fact.kind !== "visibility" || fact.visibility !== "lab") continue;
    const seen = shared.get(fact.annotationId);
    if (seen === undefined || fact.at > seen) {
      shared.set(fact.annotationId, fact.at);
    }
  }
  return shared;
}

/**
 * One paper, one moment: what has moved since.
 *
 * The lab-level version of this question is already answered — `digests.catchUp`
 * builds a "since you were away" digest against the member's own cursor, five
 * lines, across every paper that moved. This is the other axis and the one that
 * was missing: **one paper, anchored to a meeting**, which is what somebody
 * standing in front of a paper's record actually wants to know. "What has the
 * lab written about this since we last discussed it" is not a question a digest
 * can be asked, because a digest is addressed to a person and this is addressed
 * to a paper.
 *
 * It is also not a cursor, and must not become one. The window comes from the
 * lab's calendar or from a date the reader picked; nothing here reads or moves
 * anybody's `seenCursors` row, and nothing about opening this surface is
 * recorded anywhere.
 *
 * ## Why nothing here counts what disappeared
 *
 * The obvious fifth number is "and 3 notes were withdrawn". It is not here, and
 * the reason is that it cannot be counted honestly from anything a reader is
 * allowed to see. A withdrawn note with no replies is deleted outright, so the
 * only trace is a ledger row that says nothing about who could ever read it —
 * counting those would report the deletion of notes that were private their
 * whole lives. Counting only the tombstones instead gives a number whose real
 * meaning is "withdrawn notes that happened to have replies", which is a worse
 * kind of wrong than silence. Where a specific withdrawn note is load-bearing,
 * the surfaces that cited it already say so on their own (`applyWithdrawals`).
 */
export function changedSince<
  A extends string,
  U extends string,
  S extends string,
>(input: {
  notes: readonly TemporalNote<A, U, S>[];
  facts: readonly AnnotationFact<A>[];
  meetings: readonly HeldMeeting<S>[];
  since: number;
  cap?: number;
}): ChangedSince<A, U, S> {
  const shared = arrivals(input.facts);
  const counts = { written: 0, shared: 0, replies: 0, revised: 0 };
  const candidates: ArrivedNote<A, U>[] = [];

  for (const note of input.notes) {
    const arrivedAt = Math.max(note.createdAt, shared.get(note.id) ?? 0);

    if (arrivedAt <= input.since) {
      // Already here when the window opened. The only thing it can contribute
      // is a rewrite — and a note rewritten before the window is unchanged as
      // far as this reader is concerned.
      if (note.editedAt !== undefined && note.editedAt > input.since) {
        counts.revised += 1;
      }
      continue;
    }

    if (note.parentId !== undefined) {
      // Replies are counted, never listed. A reply out of its thread is half a
      // conversation, and the thread is one click away on the page this sits on.
      counts.replies += 1;
      continue;
    }

    if (arrivedAt > note.createdAt) {
      counts.shared += 1;
    } else {
      counts.written += 1;
    }

    candidates.push({
      annotationId: note.id,
      memberId: note.memberId,
      memberName: note.memberName,
      type: note.type,
      body: note.body,
      quote: note.quote,
      pageIndex: note.pageIndex,
      writtenAt: note.createdAt,
      arrivedAt,
    });
  }

  // Newest arrival first: this is the half of the window the reader has least
  // chance of having seen.
  candidates.sort(
    (x, y) =>
      y.arrivedAt - x.arrivedAt || (x.annotationId < y.annotationId ? -1 : 1),
  );

  const meetings = input.meetings
    .filter((meeting) => meeting.at > input.since)
    .sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1));

  return {
    arrived: lens(candidates, input.cap ?? MAX_LENS_ITEMS),
    counts,
    meetings,
  };
}

/**
 * Whether the index has anything to say at all.
 *
 * A paper the lab added yesterday has no memory and should not be drawn a panel
 * announcing that. Week one it is empty and by week six it is the reason the
 * page gets opened — the same shape as the brief's carried-over section, and the
 * same answer: render nothing rather than an empty heading.
 */
export function isEmpty(index: {
  unresolved: { items: readonly unknown[] };
  positions: { items: readonly unknown[] };
  changed: {
    arrived: { items: readonly unknown[] };
    counts: { replies: number; revised: number };
  } | null;
}): boolean {
  if (index.unresolved.items.length > 0) return false;
  if (index.positions.items.length > 0) return false;
  const changed = index.changed;
  if (changed === null) return true;
  return (
    changed.arrived.items.length === 0 &&
    changed.counts.replies === 0 &&
    changed.counts.revised === 0
  );
}
