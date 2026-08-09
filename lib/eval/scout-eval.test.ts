import { describe, expect, it } from "vitest";
import {
  EVAL_TOP_N,
  MIN_QUESTIONS_FOR_VERDICT,
  aggregate,
  formatScoutEvalReport,
  recallAtN,
  reciprocalRank,
  scoreQuestion,
  topN,
  verdictOf,
  type Label,
  type QuestionScore,
  type ScoutEvalReport,
} from "./scout-eval";

/**
 * The arithmetic behind the launch gate.
 *
 * Worth testing on its own because the gate is a decision somebody makes
 * once, off a number, and the two ways this could quietly lie — a mean that
 * lets one question with five labels outvote five questions with one, and a
 * verdict rendered off a corpus too small to have one — are both invisible in
 * the output they produce.
 */

const labels = (...ids: string[]): Label[] =>
  ids.map((annotationId) => ({
    annotationId,
    source: "co-recorded-citation" as const,
  }));

function question(
  id: string,
  cited: string[],
  scoutRanked: string[],
  baselineRanked: string[],
): QuestionScore {
  return scoreQuestion({
    subject: { kind: "action", id },
    labId: "lab1",
    question: "Does the 4°C step explain the gap?",
    settledAt: 1_000,
    labels: labels(...cited),
    scout: { system: "scout", ranked: scoutRanked, candidatesConsidered: 40 },
    baseline: {
      system: "search.everything",
      ranked: baselineRanked,
      candidatesConsidered: 6,
    },
  });
}

describe("topN", () => {
  it("keeps order, drops repeats, and stops at the cap", () => {
    expect(topN(["a", "b", "a", "c", "d", "e", "f", "g"])).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
    expect(EVAL_TOP_N).toBe(6);
  });
});

describe("recallAtN", () => {
  it("is the fraction of distinct labels the list showed", () => {
    expect(recallAtN(["a", "b", "c", "d"], ["x", "a", "c"])).toBeCloseTo(0.5);
  });

  it("counts a repeated label once", () => {
    expect(recallAtN(["a", "a", "b"], ["a"])).toBeCloseTo(0.5);
  });

  it("refuses a question with no labels rather than scoring it zero", () => {
    // A zero here would be indistinguishable from a genuine miss and would
    // drag the macro mean down with rows that were never measurable.
    expect(() => recallAtN([], ["a"])).toThrow(/not scoreable/);
  });
});

describe("reciprocalRank", () => {
  it("is one over the position of the first labelled note", () => {
    expect(reciprocalRank(["b"], ["a", "b", "c"])).toBeCloseTo(1 / 2);
    expect(reciprocalRank(["a"], ["a"])).toBe(1);
    expect(reciprocalRank(["z"], ["a", "b"])).toBe(0);
  });
});

describe("scoreQuestion", () => {
  it("gives the question to whoever surfaced more of the evidence", () => {
    const row = question("q1", ["a", "b"], ["a", "b"], ["a"]);
    expect(row.scout.recallAtN).toBe(1);
    expect(row.baseline.recallAtN).toBeCloseTo(0.5);
    expect(row.winner).toBe("scout");
  });

  it("breaks a recall tie on where the evidence landed", () => {
    const row = question("q2", ["a"], ["a", "x"], ["x", "a"]);
    expect(row.scout.recallAtN).toBe(row.baseline.recallAtN);
    expect(row.winner).toBe("scout");
  });

  it("calls it a tie only when both lists rank the evidence the same", () => {
    expect(question("q3", ["a"], ["a", "x"], ["a", "y"]).winner).toBe("tie");
  });

  it("carries each side's candidate pool through, unequal as it is", () => {
    const row = question("q4", ["a"], ["a"], ["a"]);
    expect(row.scout.candidatesConsidered).toBe(40);
    expect(row.baseline.candidatesConsidered).toBe(6);
  });

  it("scores only the first six of a longer list", () => {
    const row = question(
      "q5",
      ["g"],
      ["a", "b", "c", "d", "e", "f", "g"],
      ["g"],
    );
    expect(row.scout.recallAtN).toBe(0);
    expect(row.winner).toBe("baseline");
  });
});

describe("aggregate", () => {
  it("gives every question one vote, whatever its label count", () => {
    // One question with four labels, all missed by the scout; one with a
    // single label it found. A micro-average would call that 1/5; the macro
    // average this gate uses calls it 1/2, which is the honest reading of
    // "the scout answered one of these two questions".
    const totals = aggregate([
      question("many", ["a", "b", "c", "d"], ["x"], ["a", "b", "c", "d"]),
      question("one", ["z"], ["z"], ["x"]),
    ]);
    expect(totals.scout.meanRecallAtN).toBeCloseTo(0.5);
    expect(totals.baseline.meanRecallAtN).toBeCloseTo(0.5);
    expect(totals.scoutWins).toBe(1);
    expect(totals.baselineWins).toBe(1);
    expect(totals.questionsScored).toBe(2);
  });

  it("counts the questions where a side showed anything at all", () => {
    const totals = aggregate([
      question("a", ["a"], ["a"], ["x"]),
      question("b", ["b"], ["y"], ["b"]),
    ]);
    expect(totals.scout.questionsWithAnyHit).toBe(1);
    expect(totals.baseline.questionsWithAnyHit).toBe(1);
  });

  it("survives an empty corpus without inventing a mean", () => {
    const totals = aggregate([]);
    expect(totals.questionsScored).toBe(0);
    expect(totals.scout.meanRecallAtN).toBe(0);
  });
});

describe("verdictOf", () => {
  const totalsFor = (rows: QuestionScore[]) => aggregate(rows);

  it("says nothing at all when nothing was scoreable", () => {
    expect(verdictOf(totalsFor([]))).toMatch(/statement about the data/);
  });

  it("refuses a verdict under the minimum, however good the numbers look", () => {
    const rows = Array.from({ length: MIN_QUESTIONS_FOR_VERDICT - 1 }, (_, i) =>
      question(`q${i}`, ["a"], ["a"], ["x"]),
    );
    const verdict = verdictOf(totalsFor(rows));
    expect(verdict).toMatch(/^No verdict/);
    expect(verdict).toContain(String(MIN_QUESTIONS_FOR_VERDICT));
    expect(verdict).toMatch(/not a launch-gate result/);
  });

  it("abstains outright when a bounded read came back full", () => {
    // A partial scan can lose labels, and a lost label is a miss neither side
    // committed. Ten clean-looking wins do not survive it.
    const rows = Array.from({ length: MIN_QUESTIONS_FOR_VERDICT }, (_, i) =>
      question(`q${i}`, ["a"], ["a"], ["x"]),
    );
    const verdict = verdictOf(totalsFor(rows), {
      truncated: ["outcomes in lab L hit the 500-row read cap"],
    });
    expect(verdict).toMatch(/^No verdict/);
    expect(verdict).toContain("500-row read cap");
  });

  it("says ahead, behind, and level in words a gate can act on", () => {
    const ahead = Array.from({ length: MIN_QUESTIONS_FOR_VERDICT }, (_, i) =>
      question(`q${i}`, ["a"], ["a"], ["x"]),
    );
    expect(verdictOf(totalsFor(ahead))).toMatch(/^Scout ahead/);

    const behind = ahead.map((_, i) => question(`q${i}`, ["a"], ["x"], ["a"]));
    expect(verdictOf(totalsFor(behind))).toMatch(/does not ship/);

    const level = ahead.map((_, i) => question(`q${i}`, ["a"], ["a"], ["a"]));
    expect(verdictOf(totalsFor(level))).toMatch(/Level is not ahead/);
  });
});

describe("formatScoutEvalReport", () => {
  const report: ScoutEvalReport = {
    generatedAt: 0,
    ranker: "stub.scout.v0",
    topN: EVAL_TOP_N,
    groundTruth: {
      rules: ["co-recorded-citation: …"],
      caveats: ["the labels are proxies"],
    },
    asymmetry: ["the scout ranks 40, the drawer returns 6"],
    population: {
      labsScanned: 1,
      questionsSettled: 2,
      questionsScored: 1,
      questionsWithoutLabels: 1,
      questionsUnreadable: 1,
      questionsBeyondLimit: 4,
      labelsDroppedNotLabVisible: 3,
      truncated: [],
    },
    questions: [question("q1", ["a"], ["a"], ["x"])],
    aggregate: aggregate([question("q1", ["a"], ["a"], ["x"])]),
    verdict: "No verdict: 1 scoreable question",
  };

  it("prints the asymmetry and the caveats above the numbers, not under them", () => {
    const text = formatScoutEvalReport(report);
    // The design asked for the disclosure "in the output itself, not a
    // footnote". A caveat below the table is a caveat that has already lost.
    expect(text.indexOf("the labels are proxies")).toBeLessThan(
      text.indexOf("## Per question"),
    );
    expect(text.indexOf("the scout ranks 40")).toBeLessThan(
      text.indexOf("## Per question"),
    );
    expect(text.indexOf("## Verdict")).toBeLessThan(
      text.indexOf("## Aggregate"),
    );
  });

  it("prints the corpus it could not score as well as the corpus it could", () => {
    const text = formatScoutEvalReport(report);
    expect(text).toContain("settled questions 2");
    expect(text).toContain("unlabelled 1");
    expect(text).toContain("moved under the run 1");
    expect(text).toContain("beyond this run's limit 4");
    expect(text).toContain("labels dropped (no longer lab-visible) 3");
    expect(text).toContain("nothing was hidden by truncation");
  });

  it("prints every cap it hit, where the corpus counts are", () => {
    const text = formatScoutEvalReport({
      ...report,
      population: { ...report.population, truncated: ["lab scan hit 25"] },
    });
    expect(text).toContain("! truncated: lab scan hit 25");
    expect(text.indexOf("! truncated")).toBeLessThan(
      text.indexOf("## Per question"),
    );
  });

  it("withholds the aggregate under the minimum rather than printing a quotable zero", () => {
    const text = formatScoutEvalReport(report);
    // One scoreable question. "recall@6 0.0%" is a sentence somebody would
    // paste into a decision; the count that produced it is not.
    expect(text).toContain("## Aggregate — withheld");
    expect(text).not.toMatch(/questions with any hit/);
  });

  it("prints the aggregate once there are enough questions to mean something", () => {
    const rows = Array.from({ length: MIN_QUESTIONS_FOR_VERDICT }, (_, i) =>
      question(`q${i}`, ["a"], ["a"], ["x"]),
    );
    const text = formatScoutEvalReport({
      ...report,
      questions: rows,
      aggregate: aggregate(rows),
    });
    expect(text).toContain("## Aggregate (macro, one question one vote)");
    expect(text).toContain("questions with any hit");
  });

  it("says so when there is nothing to print", () => {
    expect(
      formatScoutEvalReport({ ...report, questions: [] }),
    ).toContain("(none)");
  });
});
