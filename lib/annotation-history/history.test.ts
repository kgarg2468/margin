import { describe, expect, it } from "vitest";
import {
  buildHistory,
  changeSummary,
  MAX_VERSIONS_KEPT,
  versionSummary,
  type CurrentState,
  type StoredVersion,
} from "./history";

/**
 * The properties worth holding here are all about honesty at the edges.
 *
 * A history that renders is easy; a history that admits what it has lost is
 * the whole feature. Three things must never happen: an interval whose left
 * edge was dropped must not be drawn as though it began at the note's
 * creation, a `changed` verdict must not be computed against a row that is not
 * actually the predecessor, and the total must never under-report the states a
 * note has been through.
 */

const CREATED = 1_000;

function current(overrides: Partial<CurrentState> = {}): CurrentState {
  return {
    body: "as it stands",
    type: "note",
    createdAt: CREATED,
    ...overrides,
  };
}

function version(
  n: number,
  overrides: Partial<StoredVersion> = {},
): StoredVersion {
  return {
    version: n,
    body: `state ${n}`,
    type: "note",
    replacedAt: CREATED + n * 100,
    ...overrides,
  };
}

describe("a note nobody has edited", () => {
  it("is one entry, and it is the current one", () => {
    const history = buildHistory(current(), []);

    expect(history.total).toBe(1);
    expect(history.truncated).toBe(false);
    expect(history.droppedCount).toBe(0);
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]).toMatchObject({
      version: 1,
      body: "as it stands",
      current: true,
      from: CREATED,
      until: null,
    });
  });

  it("has nothing to say about what changed, because nothing did", () => {
    expect(buildHistory(current(), []).entries[0]?.changed).toBeNull();
    expect(changeSummary(null)).toBeNull();
  });
});

describe("a note with a history", () => {
  const versions = [
    version(1, { body: "first draft", replacedAt: 2_000 }),
    version(2, { body: "second draft", replacedAt: 3_000 }),
  ];

  it("reads newest first, with the live state at the head", () => {
    const history = buildHistory(current({ versionCount: 3 }), versions);

    expect(history.entries.map((entry) => entry.version)).toEqual([3, 2, 1]);
    expect(history.entries[0]?.current).toBe(true);
    expect(history.entries.slice(1).every((entry) => !entry.current)).toBe(true);
  });

  it("chains each state's start to the previous state's replacement", () => {
    const history = buildHistory(current({ versionCount: 3 }), versions);
    const [live, second, first] = history.entries;

    // The original begins where the note begins — the one timestamp that is
    // not some other state's ending.
    expect(first).toMatchObject({ from: CREATED, until: 2_000 });
    expect(second).toMatchObject({ from: 2_000, until: 3_000 });
    expect(live).toMatchObject({ from: 3_000, until: null });
  });

  it("does not care what order the rows arrive in", () => {
    const shuffled = buildHistory(current({ versionCount: 3 }), [
      versions[1] as StoredVersion,
      versions[0] as StoredVersion,
    ]);

    expect(shuffled).toEqual(buildHistory(current({ versionCount: 3 }), versions));
  });
});

describe("what each edit changed", () => {
  it("separates a rewrite from a retype", () => {
    const history = buildHistory(
      current({ body: "same words", type: "critique", versionCount: 3 }),
      [
        version(1, { body: "original", type: "note", replacedAt: 2_000 }),
        version(2, { body: "same words", type: "note", replacedAt: 3_000 }),
      ],
    );
    const [live, second] = history.entries;

    expect(changeSummary(second?.changed ?? null)).toBe("Rewritten");
    expect(changeSummary(live?.changed ?? null)).toBe("Retyped");
  });

  it("names an edit that did both", () => {
    const history = buildHistory(
      current({ body: "rewritten", type: "hypothesis", versionCount: 2 }),
      [version(1, { body: "original", type: "note", replacedAt: 2_000 })],
    );

    expect(changeSummary(history.entries[0]?.changed ?? null)).toBe(
      "Rewritten and retyped",
    );
  });

  it("reports a save that changed nothing rather than hiding it", () => {
    const history = buildHistory(current({ body: "unmoved", versionCount: 2 }), [
      version(1, { body: "unmoved", replacedAt: 2_000 }),
    ]);

    expect(history.entries[0]?.changed).toEqual({ body: false, type: false });
    expect(changeSummary(history.entries[0]?.changed ?? null)).toBe(
      "Saved unchanged",
    );
  });

  it("says nothing about the original, which had nothing to differ from", () => {
    const history = buildHistory(current({ versionCount: 2 }), [version(1)]);

    expect(history.entries.at(-1)).toMatchObject({ version: 1, changed: null });
  });
});

describe("a history the retention cap has eaten into", () => {
  // Sixty edits on a long-argued note: states 1–10 are gone, 11–60 are kept,
  // and the note is living in state 61.
  const kept = Array.from({ length: MAX_VERSIONS_KEPT }, (_, index) =>
    version(index + 11, { replacedAt: 10_000 + index }),
  );
  const history = buildHistory(current({ versionCount: 61 }), kept);

  it("counts every state there has ever been, not the ones it still holds", () => {
    expect(history.total).toBe(61);
    expect(history.entries).toHaveLength(MAX_VERSIONS_KEPT + 1);
  });

  it("says how much is missing, and says that something is", () => {
    expect(history.droppedCount).toBe(10);
    expect(history.truncated).toBe(true);
  });

  it("leaves the earliest surviving state's start unknown rather than guessing", () => {
    const earliest = history.entries.at(-1);

    expect(earliest?.version).toBe(11);
    // The state before it took the timestamp with it when it was dropped.
    // Claiming the note's creation time here would date state 11 to a moment
    // ten edits before it existed.
    expect(earliest?.from).toBeNull();
    expect(earliest?.changed).toBeNull();
  });
});

describe("the total, when the count and the rows disagree", () => {
  it("believes whichever says there is more history", () => {
    // A count that somehow lags the rows it is supposed to move with. Trusting
    // it would report a complete history that is missing its most recent
    // states — the one direction the panel must never be wrong in.
    const history = buildHistory(current({ versionCount: 1 }), [
      version(1),
      version(2),
    ]);

    expect(history.total).toBe(3);
    expect(history.droppedCount).toBe(0);
    expect(history.truncated).toBe(false);
  });

  it("survives a count that is absent, which is what an unedited note sends", () => {
    expect(buildHistory(current(), []).total).toBe(1);
    expect(buildHistory(current(), [version(1)]).total).toBe(2);
  });

  it("never reports a negative shortfall", () => {
    const history = buildHistory(current({ versionCount: 2 }), [
      version(1),
      version(2),
      version(3),
    ]);

    expect(history.droppedCount).toBe(0);
    expect(history.total).toBe(4);
  });
});

describe("a hole in the middle", () => {
  it("refuses to compare across it", () => {
    // Not a shape the cap can produce — it drops from the front, one row per
    // insert — but a `changed` verdict computed against a row that is not the
    // predecessor would be an edit the panel invented, so the adjacency is
    // checked rather than assumed.
    const history = buildHistory(current({ versionCount: 4 }), [
      version(1, { body: "first", replacedAt: 2_000 }),
      version(3, { body: "third", replacedAt: 4_000 }),
    ]);

    const third = history.entries.find((entry) => entry.version === 3);
    expect(third?.changed).toBeNull();
    expect(third?.from).toBeNull();

    // And the state that *does* have its predecessor still reads normally.
    const first = history.entries.find((entry) => entry.version === 1);
    expect(first?.from).toBe(CREATED);
  });
});

describe("versionSummary", () => {
  it("names the object the reader is about to open", () => {
    expect(versionSummary(3)).toBe("3 versions");
    expect(versionSummary(2)).toBe("2 versions");
    expect(versionSummary(1)).toBe("1 version");
  });
});
