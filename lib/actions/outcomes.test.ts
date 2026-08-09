import { describe, expect, it } from "vitest";
import {
  carryForward,
  groupOutcomes,
  isOpen,
  normalizeBody,
  settles,
  tally,
  MAX_CARRIED_FORWARD,
  OUTCOME_KINDS,
  type Outcome,
  type OutcomeKind,
} from "./outcomes";

let counter = 0;

/** A minimal outcome; every field has a boring default so a test says only what it means. */
function outcome(overrides: Partial<Outcome> & { kind: OutcomeKind }): Outcome & {
  id: string;
} {
  counter += 1;
  return {
    id: `o${counter}`,
    sessionId: "s1",
    recordedAt: 1_000 + counter,
    ...overrides,
  };
}

describe("settles", () => {
  it("gives questions and tasks an open state, and decisions none", () => {
    expect(settles("question")).toBe(true);
    expect(settles("task")).toBe(true);
    // Recording a decision is the settling. There is nothing left to close.
    expect(settles("decision")).toBe(false);
  });

  it("covers every kind the ontology admits", () => {
    // A fourth kind added without a rule here would silently default to
    // "cannot be settled", which is the wrong way for this to fail.
    expect(OUTCOME_KINDS).toEqual(["decision", "question", "task"]);
  });
});

describe("isOpen", () => {
  it("is true only for an unsettled question or task", () => {
    expect(isOpen(outcome({ kind: "question" }))).toBe(true);
    expect(isOpen(outcome({ kind: "task" }))).toBe(true);
    expect(isOpen(outcome({ kind: "question", settledAt: 9 }))).toBe(false);
    expect(isOpen(outcome({ kind: "task", settledAt: 9 }))).toBe(false);
  });

  it("is false for a decision, settled or not", () => {
    expect(isOpen(outcome({ kind: "decision" }))).toBe(false);
    expect(isOpen(outcome({ kind: "decision", settledAt: 9 }))).toBe(false);
  });
});

describe("groupOutcomes", () => {
  it("draws every kind, including the empty ones", () => {
    const groups = groupOutcomes([outcome({ kind: "decision" })]);
    expect(groups.map((group) => group.kind)).toEqual([
      "decision",
      "question",
      "task",
    ]);
    expect(groups[1]?.items).toEqual([]);
  });

  it("puts what is still outstanding above what is done", () => {
    // The settled one is the more recent, so ordering by time alone would put
    // it first — outstanding wins regardless.
    const done = outcome({ kind: "task", recordedAt: 500, settledAt: 900 });
    const open = outcome({ kind: "task", recordedAt: 100 });
    const groups = groupOutcomes([done, open]);
    const tasks = groups.find((group) => group.kind === "task");
    expect(tasks?.items.map((item) => item.id)).toEqual([open.id, done.id]);
    expect(tasks?.openCount).toBe(1);
  });

  it("orders equals newest first", () => {
    const older = outcome({ kind: "decision", recordedAt: 100 });
    const newer = outcome({ kind: "decision", recordedAt: 200 });
    const groups = groupOutcomes([older, newer]);
    expect(groups[0]?.items.map((item) => item.id)).toEqual([
      newer.id,
      older.id,
    ]);
  });

  it("counts no decision as open, however many there are", () => {
    const groups = groupOutcomes([
      outcome({ kind: "decision" }),
      outcome({ kind: "decision" }),
    ]);
    expect(groups[0]?.openCount).toBe(0);
  });

  it("keeps every outcome it was given, exactly once", () => {
    const all = [
      outcome({ kind: "decision" }),
      outcome({ kind: "question" }),
      outcome({ kind: "task" }),
      outcome({ kind: "task", settledAt: 5 }),
    ];
    const ids = groupOutcomes(all).flatMap((group) =>
      group.items.map((item) => item.id),
    );
    expect(ids.sort()).toEqual(all.map((one) => one.id).sort());
  });
});

describe("carryForward", () => {
  const priors = new Map([
    ["march", 300],
    ["april", 400],
  ]);

  it("carries an open question from an earlier meeting", () => {
    const open = outcome({ kind: "question", sessionId: "march" });
    const carried = carryForward({ outcomes: [open], priorSessions: priors });
    expect(carried.items).toEqual([{ outcome: open, fromSessionAt: 300 }]);
  });

  it("leaves settled outcomes behind", () => {
    const answered = outcome({
      kind: "question",
      sessionId: "march",
      settledAt: 350,
    });
    expect(
      carryForward({ outcomes: [answered], priorSessions: priors }).items,
    ).toEqual([]);
  });

  it("never carries a decision", () => {
    // A decision holds rather than travels: re-raising it next week would be
    // asking the lab to settle the same thing twice.
    const decided = outcome({ kind: "decision", sessionId: "march" });
    expect(
      carryForward({ outcomes: [decided], priorSessions: priors }).items,
    ).toEqual([]);
  });

  it("ignores outcomes from a session that does not qualify as prior", () => {
    // Cancelled meetings, meetings still ahead, and this session itself are all
    // absent from the map the caller built — so they cannot leak in here.
    const elsewhere = outcome({ kind: "task", sessionId: "cancelled" });
    expect(
      carryForward({ outcomes: [elsewhere], priorSessions: priors }).items,
    ).toEqual([]);
  });

  it("puts the most recent meeting's leftovers first", () => {
    const fromMarch = outcome({ kind: "question", sessionId: "march" });
    const fromApril = outcome({ kind: "task", sessionId: "april" });
    const carried = carryForward({
      outcomes: [fromMarch, fromApril],
      priorSessions: priors,
    });
    expect(carried.items.map((item) => item.outcome.id)).toEqual([
      fromApril.id,
      fromMarch.id,
    ]);
  });

  it("breaks a tie within one meeting on the newer outcome", () => {
    const early = outcome({
      kind: "task",
      sessionId: "march",
      recordedAt: 310,
    });
    const late = outcome({
      kind: "task",
      sessionId: "march",
      recordedAt: 320,
    });
    const carried = carryForward({
      outcomes: [early, late],
      priorSessions: priors,
    });
    expect(carried.items.map((item) => item.outcome.id)).toEqual([
      late.id,
      early.id,
    ]);
  });

  it("caps the list and says how much it held back", () => {
    const many = Array.from({ length: 5 }, () =>
      outcome({ kind: "question", sessionId: "march" }),
    );
    const carried = carryForward({
      outcomes: many,
      priorSessions: priors,
      cap: 2,
    });
    expect(carried.items).toHaveLength(2);
    expect(carried.droppedCount).toBe(3);
  });

  it("drops nothing when it fits, and defaults to a real ceiling", () => {
    const two = [
      outcome({ kind: "question", sessionId: "march" }),
      outcome({ kind: "task", sessionId: "april" }),
    ];
    const carried = carryForward({ outcomes: two, priorSessions: priors });
    expect(carried.droppedCount).toBe(0);
    expect(MAX_CARRIED_FORWARD).toBeGreaterThan(two.length);
  });

  it("returns the caller's own rows, untouched", () => {
    // The generic passthrough is load-bearing: `convex/actions.ts` hands whole
    // view rows in and renders them out, prose and citation and all.
    const row = { ...outcome({ kind: "task", sessionId: "april" }), body: "hi" };
    const carried = carryForward({ outcomes: [row], priorSessions: priors });
    expect(carried.items[0]?.outcome.body).toBe("hi");
  });
});

describe("tally", () => {
  it("counts by kind, and counts what is still outstanding across both", () => {
    expect(
      tally([
        outcome({ kind: "decision" }),
        outcome({ kind: "question" }),
        outcome({ kind: "question", settledAt: 5 }),
        outcome({ kind: "task" }),
      ]),
    ).toEqual({ decisions: 1, questions: 2, tasks: 1, open: 2 });
  });

  it("is all zeroes for a meeting that left nothing", () => {
    expect(tally([])).toEqual({
      decisions: 0,
      questions: 0,
      tasks: 0,
      open: 0,
    });
  });
});

describe("normalizeBody", () => {
  it("takes off the trailing newline a hurried note arrives with", () => {
    expect(normalizeBody("Re-run the assay at 4°C\n\n  ")).toBe(
      "Re-run the assay at 4°C",
    );
  });

  it("keeps leading indentation, which can be deliberate", () => {
    expect(normalizeBody("  if n > 30, use the t-test")).toBe(
      "  if n > 30, use the t-test",
    );
  });

  it("never shortens the body itself — length is the caller's refusal", () => {
    const long = "x".repeat(2_000);
    expect(normalizeBody(long)).toHaveLength(2_000);
  });
});
