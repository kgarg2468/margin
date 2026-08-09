import { describe, expect, it } from "vitest";
import {
  changedSince,
  isEmpty,
  mostRecentMeetings,
  positionChanges,
  unresolvedAcrossMeetings,
  type AnnotationFact,
  type HeldMeeting,
  type MeetingRow,
  type TemporalNote,
} from "./derive";

/**
 * A calendar in round numbers.
 *
 * Every date in these tests is a multiple of `DAY` off a fixed origin, so a
 * failure reads as "day 3 came before day 5" rather than as two thirteen-digit
 * epochs the reader has to subtract in their head.
 */
const DAY = 24 * 60 * 60 * 1000;
const ORIGIN = 1_800_000_000_000;
const day = (n: number) => ORIGIN + n * DAY;

let counter = 0;

function note(
  overrides: Partial<TemporalNote> & { memberId: string },
): TemporalNote {
  counter += 1;
  return {
    id: `a${counter}`,
    memberName: overrides.memberId === "ana" ? "Ana Ruiz" : "Ben Okafor",
    type: "note",
    body: "",
    quote: "a passage",
    pageIndex: 0,
    createdAt: day(0),
    ...overrides,
  };
}

const meeting = (id: string, atDay: number): HeldMeeting => ({
  id,
  at: day(atDay),
});

const created = (
  annotationId: string,
  atDay: number,
  createdAs: TemporalNote["type"] = "note",
): AnnotationFact => ({
  annotationId,
  at: day(atDay),
  kind: "created",
  createdAs,
  visibility: "lab",
});

const edited = (annotationId: string, atDay: number): AnnotationFact => ({
  annotationId,
  at: day(atDay),
  kind: "edited",
});

const flipped = (
  annotationId: string,
  atDay: number,
  visibility: "lab" | "private",
): AnnotationFact => ({
  annotationId,
  at: day(atDay),
  kind: "visibility",
  visibility,
});

describe("mostRecentMeetings", () => {
  const session = (
    id: string,
    scheduledDay: number,
    endedDay?: number,
  ): MeetingRow => ({
    id,
    scheduledAt: day(scheduledDay),
    ...(endedDay === undefined ? {} : { endedAt: day(endedDay) }),
  });

  it("measures a meeting from when the room emptied", () => {
    // A note written in the last ten minutes of a meeting was written during
    // it, not after it, so the boundary is the end and not the booking.
    const [one] = mostRecentMeetings([session("s1", 3, 4)], 10);
    expect(one?.at).toBe(day(4));
  });

  it("falls back to the booked time for a row with no end", () => {
    const [one] = mostRecentMeetings([session("s1", 3)], 10);
    expect(one?.at).toBe(day(3));
  });

  it("keeps the most recent by the clock, not by the order rows arrived", () => {
    // The bug this function exists for. `by_paper` is creation order, so a
    // session backdated after the fact arrives at the newest end of the read
    // while sitting at the oldest end of the calendar. Capping first would keep
    // it and drop a meeting that actually happened later.
    const backdatedLast = session("backdated", 1, 2);
    const older = session("older", 5, 6);
    const newer = session("newer", 9, 10);

    const kept = mostRecentMeetings([backdatedLast, older, newer], 2);
    expect(kept.map((one) => one.id)).toEqual(["newer", "older"]);
  });

  it("orders most recent first whatever order it was handed", () => {
    const kept = mostRecentMeetings(
      [session("mid", 5, 6), session("new", 9, 10), session("old", 1, 2)],
      10,
    );
    expect(kept.map((one) => one.id)).toEqual(["new", "mid", "old"]);
  });

  it("breaks a tie on the clock deterministically", () => {
    const kept = mostRecentMeetings(
      [session("b", 3, 4), session("a", 3, 4)],
      10,
    );
    expect(kept.map((one) => one.id)).toEqual(["a", "b"]);
  });

  it("returns everything when the cap is not reached", () => {
    expect(mostRecentMeetings([session("s1", 1, 2)], 50)).toHaveLength(1);
  });

  it("survives a cap of zero and an empty calendar", () => {
    expect(mostRecentMeetings([session("s1", 1, 2)], 0)).toEqual([]);
    expect(mostRecentMeetings([], 50)).toEqual([]);
  });
});

describe("unresolvedAcrossMeetings", () => {
  it("carries a question that has outlasted two meetings", () => {
    const question = note({
      memberId: "ana",
      type: "open-question",
      body: "Why the 24h timepoint?",
      createdAt: day(1),
    });
    const { items } = unresolvedAcrossMeetings({
      notes: [question],
      meetings: [meeting("s1", 3), meeting("s2", 10)],
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.meetings).toBe(2);
    expect(items[0]?.lastMeetingId).toBe("s2");
    expect(items[0]?.askedAt).toBe(day(1));
  });

  it("leaves a question that has only survived one meeting alone", () => {
    // One is ordinary: most questions are answered out loud and nobody types
    // the answer. Two is the lab having had a second chance at it.
    const question = note({
      memberId: "ana",
      type: "open-question",
      createdAt: day(1),
    });
    const { items } = unresolvedAcrossMeetings({
      notes: [question],
      meetings: [meeting("s1", 3)],
    });
    expect(items).toEqual([]);
  });

  it("does not count meetings held before the question was asked", () => {
    const question = note({
      memberId: "ana",
      type: "open-question",
      createdAt: day(9),
    });
    const { items } = unresolvedAcrossMeetings({
      notes: [question],
      meetings: [meeting("s1", 3), meeting("s2", 5), meeting("s3", 12)],
    });
    expect(items).toEqual([]);
  });

  it("counts a question written under no session at all", () => {
    // The whole difference from the brief's carried-over lens: a question typed
    // on an ordinary Tuesday has still outlasted every meeting since.
    const question = note({
      memberId: "ana",
      type: "open-question",
      createdAt: day(1),
    });
    expect(question.sessionId).toBeUndefined();
    const { items } = unresolvedAcrossMeetings({
      notes: [question],
      meetings: [meeting("s1", 4), meeting("s2", 8)],
    });
    expect(items[0]?.meetings).toBe(2);
    expect(items[0]?.raisedInSessionId).toBeUndefined();
  });

  it("drops a question the moment anybody replies to it", () => {
    const question = note({
      memberId: "ana",
      type: "open-question",
      createdAt: day(1),
    });
    const { items } = unresolvedAcrossMeetings({
      notes: [
        question,
        note({ memberId: "ben", parentId: question.id, createdAt: day(2) }),
      ],
      meetings: [meeting("s1", 4), meeting("s2", 8)],
    });
    expect(items).toEqual([]);
  });

  it("counts the asker's own reply as an answer", () => {
    // Talking yourself out of a question is an answer, and the alternative is a
    // rule that reads somebody's mind about their own follow-up.
    const question = note({
      memberId: "ana",
      type: "open-question",
      createdAt: day(1),
    });
    const { items } = unresolvedAcrossMeetings({
      notes: [
        question,
        note({ memberId: "ana", parentId: question.id, createdAt: day(2) }),
      ],
      meetings: [meeting("s1", 4), meeting("s2", 8)],
    });
    expect(items).toEqual([]);
  });

  it("only looks at open questions", () => {
    const notes = (["critique", "hypothesis", "note"] as const).map((type) =>
      note({ memberId: "ana", type, createdAt: day(1) }),
    );
    const { items } = unresolvedAcrossMeetings({
      notes,
      meetings: [meeting("s1", 4), meeting("s2", 8)],
    });
    expect(items).toEqual([]);
  });

  it("puts the question that has outlasted most meetings first", () => {
    const stubborn = note({
      memberId: "ana",
      type: "open-question",
      body: "stubborn",
      createdAt: day(1),
    });
    const recent = note({
      memberId: "ben",
      type: "open-question",
      body: "recent",
      createdAt: day(6),
    });
    const { items } = unresolvedAcrossMeetings({
      notes: [recent, stubborn],
      meetings: [meeting("s1", 3), meeting("s2", 8), meeting("s3", 12)],
    });
    expect(items.map((one) => one.body)).toEqual(["stubborn", "recent"]);
    expect(items[0]?.meetings).toBe(3);
    expect(items[1]?.meetings).toBe(2);
  });

  it("caps the lens and says how much it held back", () => {
    const notes = Array.from({ length: 9 }, (_, index) =>
      note({
        memberId: "ana",
        type: "open-question",
        createdAt: day(1) + index,
      }),
    );
    const { items, droppedCount } = unresolvedAcrossMeetings({
      notes,
      meetings: [meeting("s1", 4), meeting("s2", 8)],
      cap: 6,
    });
    expect(items).toHaveLength(6);
    expect(droppedCount).toBe(3);
  });

  it("says nothing about a paper the lab has never met on", () => {
    const question = note({
      memberId: "ana",
      type: "open-question",
      createdAt: day(1),
    });
    expect(
      unresolvedAcrossMeetings({ notes: [question], meetings: [] }).items,
    ).toEqual([]);
  });
});

describe("positionChanges", () => {
  it("reports a note retyped from hypothesis to critique", () => {
    const flipped = note({
      memberId: "ana",
      type: "critique",
      createdAt: day(1),
    });
    const { items } = positionChanges({
      notes: [flipped],
      facts: [created(flipped.id, 1, "hypothesis"), edited(flipped.id, 6)],
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.retyped).toEqual({ from: "hypothesis", to: "critique" });
    expect(items[0]?.movedAt).toBe(day(6));
    expect(items[0]?.revisions).toBe(1);
  });

  it("leaves a note that only ever had its prose fixed alone", () => {
    // Fixing a sentence is not changing a position, and a lens full of typo
    // corrections buries the two movements that mean something.
    const tidied = note({ memberId: "ana", type: "note", createdAt: day(1) });
    const { items } = positionChanges({
      notes: [tidied],
      facts: [created(tidied.id, 1, "note"), edited(tidied.id, 2), edited(tidied.id, 3)],
    });
    expect(items).toEqual([]);
  });

  it("reports a note taken back from the lab and put out again", () => {
    const restated = note({ memberId: "ben", createdAt: day(1) });
    const { items } = positionChanges({
      notes: [restated],
      facts: [
        created(restated.id, 1),
        flipped(restated.id, 4, "private"),
        flipped(restated.id, 11, "lab"),
      ],
    });
    expect(items[0]?.restated).toEqual({
      takenBackAt: day(4),
      restatedAt: day(11),
    });
    expect(items[0]?.movedAt).toBe(day(11));
  });

  it("reports the most recent round trip when there have been several", () => {
    const restated = note({ memberId: "ben", createdAt: day(1) });
    const { items } = positionChanges({
      notes: [restated],
      facts: [
        created(restated.id, 1),
        flipped(restated.id, 2, "private"),
        flipped(restated.id, 3, "lab"),
        flipped(restated.id, 9, "private"),
        flipped(restated.id, 14, "lab"),
      ],
    });
    expect(items[0]?.restated).toEqual({
      takenBackAt: day(9),
      restatedAt: day(14),
    });
  });

  it("does not call a note restated while it is still taken back", () => {
    // It could not be in the pool in that state anyway — this proves the
    // function agrees rather than relying on the caller to have filtered.
    const gone = note({ memberId: "ben", createdAt: day(1) });
    const { items } = positionChanges({
      notes: [gone],
      facts: [created(gone.id, 1), flipped(gone.id, 4, "private")],
    });
    expect(items).toEqual([]);
  });

  it("carries both movements on a note that did both", () => {
    const both = note({ memberId: "ana", type: "critique", createdAt: day(1) });
    const { items } = positionChanges({
      notes: [both],
      facts: [
        created(both.id, 1, "hypothesis"),
        edited(both.id, 3),
        flipped(both.id, 5, "private"),
        flipped(both.id, 8, "lab"),
      ],
    });
    expect(items[0]?.retyped).toEqual({ from: "hypothesis", to: "critique" });
    expect(items[0]?.restated?.restatedAt).toBe(day(8));
    expect(items[0]?.movedAt).toBe(day(8));
  });

  it("stays silent about a note whose creation fell outside the window", () => {
    // A short answer beats one that claims nobody moved because it could not
    // see far enough back.
    const old = note({ memberId: "ana", type: "critique", createdAt: day(1) });
    const { items } = positionChanges({
      notes: [old],
      facts: [edited(old.id, 40)],
    });
    expect(items).toEqual([]);
  });

  it("reads a note's facts forwards however the ledger handed them over", () => {
    // The ledger is read newest-first so a busy paper contributes its live end;
    // a round trip must not read backwards because of it.
    const restated = note({ memberId: "ben", createdAt: day(1) });
    const { items } = positionChanges({
      notes: [restated],
      facts: [
        flipped(restated.id, 11, "lab"),
        flipped(restated.id, 4, "private"),
        created(restated.id, 1),
      ],
    });
    expect(items[0]?.restated).toEqual({
      takenBackAt: day(4),
      restatedAt: day(11),
    });
  });

  it("puts the most recent movement first", () => {
    const early = note({ memberId: "ana", type: "critique", createdAt: day(1) });
    const late = note({ memberId: "ben", type: "critique", createdAt: day(1) });
    const { items } = positionChanges({
      notes: [early, late],
      facts: [
        created(early.id, 1, "note"),
        edited(early.id, 3),
        created(late.id, 1, "note"),
        edited(late.id, 20),
      ],
    });
    expect(items.map((one) => one.annotationId)).toEqual([late.id, early.id]);
  });

  it("ignores facts about notes that are not in the pool", () => {
    // The pool is the visibility gate. A fact about a note that is private now
    // has nothing to attach to and produces no line.
    const { items } = positionChanges({
      notes: [],
      facts: [created("ghost", 1, "hypothesis"), edited("ghost", 4)],
    });
    expect(items).toEqual([]);
  });
});

describe("changedSince", () => {
  it("lists notes written since the anchor", () => {
    const before = note({ memberId: "ana", body: "old", createdAt: day(1) });
    const after = note({ memberId: "ben", body: "new", createdAt: day(9) });
    const result = changedSince({
      notes: [before, after],
      facts: [],
      meetings: [],
      since: day(5),
    });
    expect(result.arrived.items.map((one) => one.body)).toEqual(["new"]);
    expect(result.counts.written).toBe(1);
  });

  it("counts a note written earlier and shared since as newly arrived", () => {
    const drafted = note({ memberId: "ana", body: "held back", createdAt: day(1) });
    const result = changedSince({
      notes: [drafted],
      facts: [flipped(drafted.id, 9, "lab")],
      meetings: [],
      since: day(5),
    });
    expect(result.counts.shared).toBe(1);
    expect(result.counts.written).toBe(0);
    expect(result.arrived.items[0]?.writtenAt).toBe(day(1));
    expect(result.arrived.items[0]?.arrivedAt).toBe(day(9));
  });

  it("dates arrival from the last share, not the first", () => {
    const restated = note({ memberId: "ben", createdAt: day(1) });
    const result = changedSince({
      notes: [restated],
      facts: [
        flipped(restated.id, 2, "lab"),
        flipped(restated.id, 4, "private"),
        flipped(restated.id, 12, "lab"),
      ],
      meetings: [],
      since: day(6),
    });
    expect(result.arrived.items[0]?.arrivedAt).toBe(day(12));
  });

  it("counts replies without listing them", () => {
    const parent = note({ memberId: "ana", createdAt: day(1) });
    const reply = note({
      memberId: "ben",
      parentId: parent.id,
      createdAt: day(9),
    });
    const result = changedSince({
      notes: [parent, reply],
      facts: [],
      meetings: [],
      since: day(5),
    });
    expect(result.counts.replies).toBe(1);
    expect(result.arrived.items).toEqual([]);
  });

  it("counts a rewrite of a note that was already here", () => {
    const revised = note({
      memberId: "ana",
      createdAt: day(1),
      editedAt: day(9),
    });
    const result = changedSince({
      notes: [revised],
      facts: [],
      meetings: [],
      since: day(5),
    });
    expect(result.counts.revised).toBe(1);
    expect(result.counts.written).toBe(0);
  });

  it("does not call a note written since the anchor a revision as well", () => {
    const fresh = note({
      memberId: "ana",
      createdAt: day(7),
      editedAt: day(8),
    });
    const result = changedSince({
      notes: [fresh],
      facts: [],
      meetings: [],
      since: day(5),
    });
    expect(result.counts.written).toBe(1);
    expect(result.counts.revised).toBe(0);
  });

  it("names the meetings held inside the window, oldest first", () => {
    const result = changedSince({
      notes: [],
      facts: [],
      meetings: [meeting("s1", 2), meeting("s3", 12), meeting("s2", 8)],
      since: day(5),
    });
    expect(result.meetings.map((one) => one.id)).toEqual(["s2", "s3"]);
  });

  it("puts the newest arrival first and caps the list", () => {
    const notes = Array.from({ length: 8 }, (_, index) =>
      note({ memberId: "ana", body: `n${index}`, createdAt: day(10 + index) }),
    );
    const result = changedSince({
      notes,
      facts: [],
      meetings: [],
      since: day(5),
      cap: 6,
    });
    expect(result.arrived.items[0]?.body).toBe("n7");
    expect(result.arrived.items).toHaveLength(6);
    expect(result.arrived.droppedCount).toBe(2);
    expect(result.counts.written).toBe(8);
  });

  it("reports nothing at all for a quiet window", () => {
    const old = note({ memberId: "ana", createdAt: day(1) });
    const result = changedSince({
      notes: [old],
      facts: [],
      meetings: [],
      since: day(5),
    });
    expect(result.arrived.items).toEqual([]);
    expect(result.counts).toEqual({
      written: 0,
      shared: 0,
      replies: 0,
      revised: 0,
    });
  });
});

describe("isEmpty", () => {
  const nothing = { items: [], droppedCount: 0 };
  const quiet = {
    arrived: nothing,
    counts: { written: 0, shared: 0, replies: 0, revised: 0 },
    meetings: [],
  };

  it("is true for a paper the lab added yesterday", () => {
    expect(
      isEmpty({ unresolved: nothing, positions: nothing, changed: quiet }),
    ).toBe(true);
  });

  it("is true when there is no anchor to measure a window from", () => {
    expect(
      isEmpty({ unresolved: nothing, positions: nothing, changed: null }),
    ).toBe(true);
  });

  it("is false as soon as any one lens has something", () => {
    const asked = { items: ["a question"], droppedCount: 0 };
    const moved = { items: ["a movement"], droppedCount: 0 };
    const answered = { ...quiet, counts: { ...quiet.counts, replies: 2 } };

    expect(
      isEmpty({ unresolved: asked, positions: nothing, changed: quiet }),
    ).toBe(false);
    expect(
      isEmpty({ unresolved: nothing, positions: moved, changed: quiet }),
    ).toBe(false);
    expect(
      isEmpty({ unresolved: nothing, positions: nothing, changed: answered }),
    ).toBe(false);
  });

  it("is still true when the only thing in the window is a meeting", () => {
    // A meeting the lab held is on the calendar already. It is context for the
    // other lenses, not something this surface exists to announce.
    const met = { ...quiet, meetings: [meeting("s1", 8)] };
    expect(
      isEmpty({ unresolved: nothing, positions: nothing, changed: met }),
    ).toBe(true);
  });
});
