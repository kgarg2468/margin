/**
 * Scoring the scout against the drawer a member already has.
 *
 * `docs/design/agent-delegation.md` §10.2 makes one claim the rest of Track C
 * is not allowed to launch without: *the scout beats what ⌘K would have shown
 * you*. This module is the arithmetic behind that sentence, and it is written
 * here — pure, clock-free, id-blind — for the same reason the digest engine
 * and the epistemic rules are: a benchmark that can only be run against a
 * database is a benchmark nobody re-derives, and one nobody re-derives is a
 * number people start quoting.
 *
 * ## What is being measured
 *
 * For a question the lab settled some time ago, the notes a human pointed at
 * while settling it are what turned out to matter. Two ranked lists of six
 * notes are then produced for the same question text — the scout's, and the
 * search drawer's — and the question is how much of that evidence each list
 * put in front of the reader.
 *
 * The labels are *ledger-derived*, which is the only kind this product is
 * allowed to have: nobody wrote relevance judgements for this corpus, and a
 * benchmark whose ground truth was invented by the team that built the
 * retriever is a benchmark that says whatever the team hoped. What the ledger
 * actually holds is in `convex/scoutEval.ts`; this module takes the labels as
 * given and does not care where they came from.
 *
 * ## Why recall@6 leads, and MRR follows
 *
 * **recall@6** is the headline because six is the surface. The palette shows
 * six annotation rows (`convex/search.ts`, `RESULTS_PER_CATEGORY`) and a
 * finding carries at most six items (`MAX_FINDING_ITEMS`), so "what fraction
 * of the evidence would have been on the screen" is a question about the
 * product rather than about information retrieval in general. Precision@6 is
 * deliberately not the headline: the label sets here are small and certainly
 * incomplete — plenty of genuinely relevant notes were never cited by anyone —
 * so a low precision number would be measuring the ground truth's coverage and
 * reporting it as the retriever's fault.
 *
 * **MRR** follows because recall@6 cannot tell first place from sixth, and the
 * two lists are read differently: a member scans a drawer, and the brief shows
 * a finding's items in order. A system that puts the note that mattered at
 * rank 5 has technically shown it and practically buried it.
 *
 * Aggregates are **macro** — one question, one vote. A lab with five labels on
 * one question and one on the next would otherwise let the first question
 * decide the launch gate.
 */

/**
 * How many results each side is scored on.
 *
 * Not a knob. It is `RESULTS_PER_CATEGORY` in `convex/search.ts` and
 * `MAX_FINDING_ITEMS` in `convex/delegations.ts` — the same six, arrived at
 * separately, which is what makes the comparison a comparison.
 */
export const EVAL_TOP_N = 6;

/**
 * Below this, the report refuses to render a verdict.
 *
 * Ten settled, labelled questions is not a benchmark either; it is the point
 * at which a per-question table stops being an anecdote you could have read
 * one row at a time. The number is stated here rather than in a reviewer's
 * head so that a run over three questions cannot be quoted as a launch gate,
 * which is the only failure mode of this whole exercise that would actually
 * cost something.
 */
export const MIN_QUESTIONS_FOR_VERDICT = 10;

/**
 * Where a relevance label came from.
 *
 * Both are proxies and the report says so. There is no field in this schema
 * that records "the notes cited in settling this question" — `setSettled`
 * writes a timestamp and a name, and `action.settled` carries no citation — so
 * the ground truth is assembled out of what humans did leave behind.
 */
export type LabelSource =
  /** An outcome recorded on this paper while the question was open cites it. */
  | "co-recorded-citation"
  /** It is a reply, written before settlement, to the note the question came from. */
  | "answer-in-thread";

/**
 * Generic in the id only so the Convex side can hand over its branded
 * `Id<"annotations">` without a cast. This module still treats every id as an
 * opaque string and has no way to read a row — the discipline
 * `lib/epistemic/status.ts` states in full.
 */
export type Label<TId extends string = string> = {
  annotationId: TId;
  source: LabelSource;
};

/** One side's answer to one question: ids, best first. */
export type RankedList = {
  /** Which system produced it, in the report's own words. */
  system: string;
  /** At most `EVAL_TOP_N`, best first, no repeats. */
  ranked: string[];
  /**
   * How many candidates the system chose those from.
   *
   * The asymmetry the design insisted be disclosed rather than footnoted: the
   * scout ranks a gathered set of up to forty, the drawer returns the index's
   * own six. Carried per question because it varies per question.
   */
  candidatesConsidered: number;
};

export type SideScore = {
  system: string;
  recallAtN: number;
  reciprocalRank: number;
  hits: string[];
  candidatesConsidered: number;
};

export type QuestionScore = {
  /** Which table the question came from, and which row. */
  subject: { kind: "action"; id: string };
  labId: string;
  /** What was asked, as the lab wrote it. */
  question: string;
  settledAt: number;
  labels: Label[];
  scout: SideScore;
  baseline: SideScore;
  /** `scout` / `baseline` / `tie`, on recall@6 with MRR as the tie-break. */
  winner: "scout" | "baseline" | "tie";
};

export type SideAggregate = {
  system: string;
  /** Macro-averaged over questions. */
  meanRecallAtN: number;
  meanReciprocalRank: number;
  /** Questions where the system surfaced at least one labelled note. */
  questionsWithAnyHit: number;
  meanCandidatesConsidered: number;
};

export type Aggregate = {
  questionsScored: number;
  scout: SideAggregate;
  baseline: SideAggregate;
  scoutWins: number;
  baselineWins: number;
  ties: number;
};

/**
 * Everything the run counted on its way to the questions it could score.
 *
 * An eval that reports only its scored rows is an eval that cannot be told
 * apart from one that quietly dropped the hard half of its corpus.
 */
export type Population = {
  labsScanned: number;
  /** Settled questions found, before asking whether anyone cited anything. */
  questionsSettled: number;
  /** Of those, the ones with at least one surviving label. */
  questionsScored: number;
  questionsWithoutLabels: number;
  /**
   * Questions that moved between the selection read and the retrieval read —
   * reopened, withdrawn, or left with no surviving label. Their own field
   * rather than folded into `questionsWithoutLabels`, because "nobody cited
   * anything while settling this" and "this stopped being a settled question
   * while we were looking at it" are different facts about a corpus.
   */
  questionsUnreadable: number;
  /**
   * Scoreable questions this run did not get to, because `limit` cut the list.
   *
   * Disclosed but *not* treated as truncation: every question that was scored
   * was scored correctly, so a verdict off a capped list is still a verdict —
   * unlike a capped scan, which can hide labels and make the scores wrong.
   */
  questionsBeyondLimit: number;
  /** Labels discarded because the note is no longer lab-visible. */
  labelsDroppedNotLabVisible: number;
  /**
   * Scored questions whose gather came back empty, so no model was ever asked.
   *
   * They are scored — they have labels, and recall 0 against those labels is a
   * true statement about what the scout returned. But they are not a
   * measurement of a model's judgement, and they drag the means down without
   * appearing anywhere in the ranker set. Reported so a reader can tell a
   * model that ranked badly from a retrieval that returned nothing to rank.
   *
   * Required, not optional. An optional counter makes "none of them did" and
   * "nobody counted" the same value, which is the shape this field exists to
   * stop being possible somewhere else.
   */
  questionsWithNoRanker: number;
  /**
   * Bounded reads that came back full, in the reader's words.
   *
   * A `.take(n)` that returns exactly `n` has almost certainly left rows
   * behind, and the rows it left behind may be the labels. Silence here would
   * be the worst kind of wrong number: one that looks like a measurement.
   * Any entry forces the verdict to abstain.
   */
  truncated: string[];
};

export type ScoutEvalReport = {
  generatedAt: number;
  /** What ranked the scout's side — today the stub, tomorrow C3's model. */
  ranker: string;
  topN: number;
  groundTruth: { rules: string[]; caveats: string[] };
  asymmetry: string[];
  population: Population;
  questions: QuestionScore[];
  aggregate: Aggregate;
  /** The launch-gate sentence, including the refusal to give one. */
  verdict: string;
};

/** Unique ids, order preserved, capped — what either side is scored on. */
export function topN<T extends string>(
  ids: readonly T[],
  n: number = EVAL_TOP_N,
): T[] {
  const seen = new Set<T>();
  const kept: T[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    kept.push(id);
    if (kept.length === n) break;
  }
  return kept;
}

/**
 * The fraction of the labelled notes that made the cut.
 *
 * Zero labels is not zero recall — it is not a measurable question, and the
 * caller is expected to have dropped it before getting here. Returning 0 would
 * quietly pull the mean down with rows that were never scoreable.
 */
export function recallAtN(
  labels: readonly string[],
  ranked: readonly string[],
): number {
  if (labels.length === 0) {
    throw new Error(
      "recallAtN was asked to score a question with no labels; such a question is not scoreable and must be counted in `questionsWithoutLabels` instead.",
    );
  }
  const shown = new Set(ranked);
  const found = new Set(labels.filter((id) => shown.has(id)));
  return found.size / new Set(labels).size;
}

/** 1/rank of the first labelled note in the list; 0 if none of them is. */
export function reciprocalRank(
  labels: readonly string[],
  ranked: readonly string[],
): number {
  const wanted = new Set(labels);
  const at = ranked.findIndex((id) => wanted.has(id));
  return at === -1 ? 0 : 1 / (at + 1);
}

/** Which labelled notes a list actually showed, in the list's own order. */
function hitsOf(labels: readonly string[], ranked: readonly string[]): string[] {
  const wanted = new Set(labels);
  return ranked.filter((id) => wanted.has(id));
}

function scoreSide(labels: readonly string[], list: RankedList): SideScore {
  const ranked = topN(list.ranked);
  return {
    system: list.system,
    recallAtN: recallAtN(labels, ranked),
    reciprocalRank: reciprocalRank(labels, ranked),
    hits: hitsOf(labels, ranked),
    candidatesConsidered: list.candidatesConsidered,
  };
}

/**
 * One question, both sides.
 *
 * Recall decides; MRR breaks the tie. Two systems that showed the same
 * evidence but in a different order have not drawn, and calling it a draw
 * would hide the only thing separating them.
 */
export function scoreQuestion(input: {
  subject: { kind: "action"; id: string };
  labId: string;
  question: string;
  settledAt: number;
  labels: readonly Label[];
  scout: RankedList;
  baseline: RankedList;
}): QuestionScore {
  const ids = input.labels.map((label) => label.annotationId);
  const scout = scoreSide(ids, input.scout);
  const baseline = scoreSide(ids, input.baseline);

  const byRecall = scout.recallAtN - baseline.recallAtN;
  const byRank = scout.reciprocalRank - baseline.reciprocalRank;
  const margin = byRecall !== 0 ? byRecall : byRank;

  return {
    subject: input.subject,
    labId: input.labId,
    question: input.question,
    settledAt: input.settledAt,
    labels: [...input.labels],
    scout,
    baseline,
    winner: margin > 0 ? "scout" : margin < 0 ? "baseline" : "tie",
  };
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, one) => total + one, 0) / values.length;
}

function aggregateSide(
  system: string,
  scores: readonly SideScore[],
): SideAggregate {
  return {
    system,
    meanRecallAtN: mean(scores.map((one) => one.recallAtN)),
    meanReciprocalRank: mean(scores.map((one) => one.reciprocalRank)),
    questionsWithAnyHit: scores.filter((one) => one.hits.length > 0).length,
    meanCandidatesConsidered: mean(
      scores.map((one) => one.candidatesConsidered),
    ),
  };
}

export function aggregate(
  questions: readonly QuestionScore[],
  /**
   * What to call the scout side over the whole run.
   *
   * This used to be sampled from the first row, and a row-0 sample is only a
   * label while every row carries the same one. A row's `system` names what
   * ranked *that* question, so once the rows can disagree the sample is a claim
   * about eleven other rows made by looking at one of them: a run whose first
   * question happened to gather nothing printed that fact as the heading over
   * means the other eleven produced.
   *
   * So the sample is gone rather than demoted to a fallback. A fallback would
   * be the same bug, kept exported and waiting for the next caller who does not
   * know to pass this — which is the caller most likely to be wrong about it.
   * Absent, the aggregate is labelled `scout`, which is true of every run.
   *
   * The baseline side needs no such argument. `search.everything` is a literal
   * at its one call site and is the same string on every row by construction,
   * so there is nothing there for a sample to be wrong about.
   */
  scoutSystem?: string,
): Aggregate {
  return {
    questionsScored: questions.length,
    scout: aggregateSide(
      scoutSystem ?? "scout",
      questions.map((one) => one.scout),
    ),
    baseline: aggregateSide(
      questions[0]?.baseline.system ?? "search.everything",
      questions.map((one) => one.baseline),
    ),
    scoutWins: questions.filter((one) => one.winner === "scout").length,
    baselineWins: questions.filter((one) => one.winner === "baseline").length,
    ties: questions.filter((one) => one.winner === "tie").length,
  };
}

/**
 * The one sentence the gate turns on — or the refusal to write one.
 *
 * Under `MIN_QUESTIONS_FOR_VERDICT` there is no verdict, whatever the means
 * say. This is the line that stops a run over three questions being pasted
 * into a launch decision, and it is code rather than a convention because a
 * convention is exactly what gets skipped on the afternoon of the launch.
 */
export function verdictOf(
  totals: Aggregate,
  options: {
    /** Bounded reads that came back full. Any of them and there is no verdict. */
    truncated?: readonly string[];
    minimum?: number;
  } = {},
): string {
  const truncated = options.truncated ?? [];
  const minimum = options.minimum ?? MIN_QUESTIONS_FOR_VERDICT;
  if (truncated.length > 0) {
    // A partial scan can lose labels, and a lost label is a miss neither side
    // committed. Whatever the means say, they are not measurements of this
    // corpus — they are measurements of the part of it that fit.
    return `No verdict: this run did not see the whole corpus (${truncated.join("; ")}). Scores computed off a partial scan can be wrong in both directions, so no comparison is offered.`;
  }
  if (totals.questionsScored === 0) {
    return "No verdict: no settled question in this corpus carries a citation a human made while settling it, so there is nothing to score. This is a statement about the data, not about the scout.";
  }
  if (totals.questionsScored < minimum) {
    return `No verdict: ${totals.questionsScored} scoreable question${
      totals.questionsScored === 1 ? "" : "s"
    }, and this gate does not read a verdict off fewer than ${minimum}. The per-question rows below are real and may be read as such; the aggregate is not a launch-gate result.`;
  }
  const delta = totals.scout.meanRecallAtN - totals.baseline.meanRecallAtN;
  if (delta > 0) {
    return `Scout ahead on recall@${EVAL_TOP_N} by ${delta.toFixed(3)} across ${totals.questionsScored} questions (${totals.scoutWins} won, ${totals.baselineWins} lost, ${totals.ties} tied).`;
  }
  if (delta < 0) {
    return `Scout behind the search drawer on recall@${EVAL_TOP_N} by ${(-delta).toFixed(3)} across ${totals.questionsScored} questions (${totals.scoutWins} won, ${totals.baselineWins} lost, ${totals.ties} tied). The design's gate says this does not ship.`;
  }
  return `Scout level with the search drawer on recall@${EVAL_TOP_N} across ${totals.questionsScored} questions (${totals.scoutWins} won, ${totals.baselineWins} lost, ${totals.ties} tied). Level is not ahead, and the gate asks for ahead.`;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * The report as something a person reads.
 *
 * The structured object is what a future run diffs against; this is what goes
 * in front of whoever has to decide. The asymmetry and the ground-truth
 * caveats are printed **above** the numbers on purpose — the design asked for
 * them "in the output itself, not a footnote", and a caveat under the table is
 * a caveat that has already lost.
 */
export function formatScoutEvalReport(report: ScoutEvalReport): string {
  const lines: string[] = [];
  const at = new Date(report.generatedAt).toISOString();

  lines.push(`# Scout eval — ledger ground truth`);
  lines.push(`generated ${at} · ranker ${report.ranker} · top-${report.topN}`);
  lines.push("");
  lines.push(`## Verdict`);
  lines.push(report.verdict);
  lines.push("");
  lines.push(`## What the labels are`);
  for (const rule of report.groundTruth.rules) lines.push(`- ${rule}`);
  for (const caveat of report.groundTruth.caveats) lines.push(`! ${caveat}`);
  lines.push("");
  lines.push(`## What is not being compared like for like`);
  for (const note of report.asymmetry) lines.push(`! ${note}`);
  lines.push("");
  lines.push(`## Corpus`);
  lines.push(
    `labs ${report.population.labsScanned} · settled questions ${report.population.questionsSettled} · scoreable ${report.population.questionsScored} · unlabelled ${report.population.questionsWithoutLabels} · moved under the run ${report.population.questionsUnreadable} · beyond this run's limit ${report.population.questionsBeyondLimit} · labels dropped (no longer lab-visible) ${report.population.labelsDroppedNotLabVisible}`,
  );
  if (report.population.truncated.length === 0) {
    lines.push("every bounded read came back short of its cap: nothing was hidden by truncation");
  } else {
    for (const cap of report.population.truncated) {
      lines.push(`! truncated: ${cap}`);
    }
  }
  lines.push("");
  lines.push(`## Per question`);
  if (report.questions.length === 0) {
    lines.push("(none)");
  }
  for (const row of report.questions) {
    lines.push(`- "${row.question}"`);
    lines.push(
      `  labels ${row.labels.length} (${row.labels
        .map((label) => label.source)
        .join(", ")}) · winner ${row.winner}`,
    );
    lines.push(
      `  scout    recall@${report.topN} ${pct(row.scout.recallAtN)} · MRR ${row.scout.reciprocalRank.toFixed(3)} · from ${row.scout.candidatesConsidered} candidates`,
    );
    lines.push(
      `  baseline recall@${report.topN} ${pct(row.baseline.recallAtN)} · MRR ${row.baseline.reciprocalRank.toFixed(3)} · from ${row.baseline.candidatesConsidered} candidates`,
    );
  }
  lines.push("");
  // Below the minimum the means are not withheld out of modesty. A line
  // reading "recall@6 0.0%" is quotable, and it will be quoted without the
  // sentence above it that says how many questions produced it.
  if (report.aggregate.questionsScored < MIN_QUESTIONS_FOR_VERDICT) {
    lines.push(`## Aggregate — withheld`);
    lines.push(
      `${report.aggregate.questionsScored} scoreable question${
        report.aggregate.questionsScored === 1 ? "" : "s"
      }, fewer than the ${MIN_QUESTIONS_FOR_VERDICT} this gate needs. No aggregate is printed, because a mean over this many questions is a number somebody would quote. The per-question rows above are real.`,
    );
    return lines.join("\n");
  }

  lines.push(`## Aggregate (macro, one question one vote)`);
  for (const side of [report.aggregate.scout, report.aggregate.baseline]) {
    lines.push(
      `${side.system}: recall@${report.topN} ${pct(side.meanRecallAtN)} · MRR ${side.meanReciprocalRank.toFixed(3)} · questions with any hit ${side.questionsWithAnyHit}/${report.aggregate.questionsScored} · mean candidate pool ${side.meanCandidatesConsidered.toFixed(1)}`,
    );
  }
  return lines.join("\n");
}
