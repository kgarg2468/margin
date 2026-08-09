import { describe, expect, it } from "vitest";
import {
  AWAY_MS,
  papersToScan,
  planSinceAway,
  REBUILD_AFTER_MS,
  sinceAwayWindow,
  type LedgerBeat,
} from "./since-away";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000;
const LOOKBACK = 14 * DAY;

/** A plan input where every field is boring, so a test says only what it means. */
function plan(overrides: Partial<Parameters<typeof planSinceAway>[0]> = {}) {
  return planSinceAway({
    now: NOW,
    joinedAt: NOW - 90 * DAY,
    cursorAt: NOW - 3 * DAY,
    waiting: null,
    lookbackMs: LOOKBACK,
    ...overrides,
  });
}

describe("sinceAwayWindow", () => {
  it("floors at the member's own cursor when they have one", () => {
    expect(
      sinceAwayWindow({
        cursorAt: NOW - 2 * DAY,
        joinedAt: NOW - 90 * DAY,
        now: NOW,
        lookbackMs: LOOKBACK,
      }),
    ).toBe(NOW - 2 * DAY);
  });

  it("uses a cursor even when it is older than the lookback cap", () => {
    // The cap exists for members who have *no* cursor. Someone who explicitly
    // caught up a month ago is owed the month.
    expect(
      sinceAwayWindow({
        cursorAt: NOW - 30 * DAY,
        joinedAt: NOW - 90 * DAY,
        now: NOW,
        lookbackMs: LOOKBACK,
      }),
    ).toBe(NOW - 30 * DAY);
  });

  it("falls back to when they joined, for a member with no cursor", () => {
    expect(
      sinceAwayWindow({
        cursorAt: null,
        joinedAt: NOW - 3 * DAY,
        now: NOW,
        lookbackMs: LOOKBACK,
      }),
    ).toBe(NOW - 3 * DAY);
  });

  it("caps a long-standing member's first window at the lookback", () => {
    expect(
      sinceAwayWindow({
        cursorAt: null,
        joinedAt: NOW - 365 * DAY,
        now: NOW,
        lookbackMs: LOOKBACK,
      }),
    ).toBe(NOW - LOOKBACK);
  });
});

describe("planSinceAway", () => {
  it("builds for a member who has been gone longer than the threshold", () => {
    expect(plan({ cursorAt: NOW - 3 * DAY })).toEqual({
      kind: "build",
      since: NOW - 3 * DAY,
      rebuild: false,
    });
  });

  it("does nothing for a member who caught up an hour ago", () => {
    expect(plan({ cursorAt: NOW - HOUR })).toEqual({
      kind: "skip",
      reason: "still-here",
    });
  });

  it("counts an overnight gap as away, and an afternoon revisit as not", () => {
    // The pair of cases the 20h threshold exists to separate.
    expect(plan({ cursorAt: NOW - 21 * HOUR }).kind).toBe("build");
    expect(plan({ cursorAt: NOW - 7 * HOUR }).kind).toBe("skip");
  });

  it("is exclusive at the threshold", () => {
    expect(plan({ cursorAt: NOW - AWAY_MS }).kind).toBe("build");
    expect(plan({ cursorAt: NOW - AWAY_MS + 1 }).kind).toBe("skip");
  });

  it("treats a cursor stamped ahead of the clock as no absence", () => {
    expect(plan({ cursorAt: NOW + DAY }).kind).toBe("skip");
  });

  it("builds a first digest for a new member with no cursor", () => {
    expect(plan({ cursorAt: null, joinedAt: NOW - 5 * DAY })).toEqual({
      kind: "build",
      since: NOW - 5 * DAY,
      rebuild: false,
    });
  });

  it("does not build for someone who joined an hour ago", () => {
    expect(plan({ cursorAt: null, joinedAt: NOW - HOUR }).kind).toBe("skip");
  });

  it("reuses a digest that is already waiting rather than stacking one", () => {
    expect(
      plan({
        cursorAt: NOW - 5 * DAY,
        waiting: { generatedAt: NOW - 5 * 60 * 1000 },
      }),
    ).toEqual({ kind: "reuse", reason: "already-waiting" });
  });

  it("reuses on every revisit inside the rebuild window", () => {
    const waiting = { generatedAt: NOW - REBUILD_AFTER_MS + 1000 };
    expect(plan({ waiting }).kind).toBe("reuse");
    expect(plan({ waiting }).kind).toBe("reuse");
  });

  it("rebuilds a stale waiting digest in place instead of adding a second", () => {
    expect(
      plan({
        cursorAt: NOW - 5 * DAY,
        waiting: { generatedAt: NOW - 6 * HOUR },
      }),
    ).toEqual({ kind: "build", since: NOW - 5 * DAY, rebuild: true });
  });

  it("leaves a stale waiting digest alone once the member is back", () => {
    // They acknowledged something else since; the absence is over, and the
    // waiting card is not ours to rewrite.
    expect(
      plan({
        cursorAt: NOW - HOUR,
        waiting: { generatedAt: NOW - 6 * HOUR },
      }),
    ).toEqual({ kind: "skip", reason: "still-here" });
  });
});

describe("papersToScan", () => {
  const beat = (
    type: string,
    paperId: string | undefined,
    at: number,
  ): LedgerBeat => ({ type, paperId, at });

  it("returns papers most-recently-written-first", () => {
    expect(
      papersToScan(
        [
          beat("annotation.created", "p1", 100),
          beat("annotation.created", "p2", 300),
          beat("annotation.replied", "p3", 200),
        ],
        5,
      ),
    ).toEqual(["p2", "p3", "p1"]);
  });

  it("does not care what order the caller read the ledger in", () => {
    const rows = [
      beat("annotation.created", "p1", 100),
      beat("annotation.created", "p2", 300),
    ];
    expect(papersToScan(rows, 5)).toEqual(papersToScan([...rows].reverse(), 5));
  });

  it("counts a paper once, at its newest beat", () => {
    expect(
      papersToScan(
        [
          beat("annotation.created", "p1", 10),
          beat("annotation.created", "p1", 400),
          beat("annotation.created", "p2", 300),
        ],
        5,
      ),
    ).toEqual(["p1", "p2"]);
  });

  it("ignores events that cannot put a new annotation in a delta", () => {
    expect(
      papersToScan(
        [
          beat("annotation.edited", "p1", 500),
          beat("annotation.deleted", "p2", 500),
          beat("annotation.visibility_changed", "p3", 500),
          beat("paper.added", "p4", 500),
          beat("session.scheduled", "p5", 500),
          beat("annotation.created", "p6", 100),
        ],
        5,
      ),
    ).toEqual(["p6"]);
  });

  it("ignores events with no paper", () => {
    expect(
      papersToScan([beat("member.joined", undefined, 500)], 5),
    ).toEqual([]);
  });

  it("keeps the busiest end when the lab is over the limit", () => {
    const rows = [1, 2, 3, 4, 5, 6, 7].map((n) =>
      beat("annotation.created", `p${n}`, n * 100),
    );
    expect(papersToScan(rows, 3)).toEqual(["p7", "p6", "p5"]);
  });

  it("breaks ties by id so the same ledger always names the same papers", () => {
    const rows = [
      beat("annotation.created", "pb", 100),
      beat("annotation.created", "pa", 100),
    ];
    expect(papersToScan(rows, 1)).toEqual(["pa"]);
  });

  it("reads nothing at all out of an empty window", () => {
    expect(papersToScan([], 5)).toEqual([]);
  });
});
