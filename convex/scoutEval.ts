import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { ActionCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalQuery } from "./_generated/server";
import {
  MAX_CANDIDATES,
  buildScoutPrompt,
  candidateShape,
  gatherLabVisible,
  labelCandidates,
  parseScoutJson,
  sanitizeFindingItems,
  STUB_MODEL,
  type Candidate,
} from "./delegations";
import { MAX_SEARCH_LENGTH } from "./search";
import { isStillShared } from "../lib/citations/visibility";
import {
  EVAL_TOP_N,
  aggregate,
  formatScoutEvalReport,
  scoreQuestion,
  topN,
  verdictOf,
  type Label,
  type LabelSource,
  type QuestionScore,
  type ScoutEvalReport,
} from "../lib/eval/scout-eval";

/**
 * The launch gate: does the scout beat the drawer the lab already has?
 *
 * `docs/design/agent-delegation.md` §10.2 splits the scout's evaluation in
 * two. The CI half — no private note may reach a prompt or a finding, every
 * citation is real, a withdrawn note takes its item with it — ships in
 * `delegations.privacy.test.ts` and blocks every PR. This is the other half:
 * an offline quality run that blocks the *launch*, and answers one question
 * with a number, per settled question the lab has already closed.
 *
 * Nothing here writes. Not a table, not a ledger row, not a delegation. An
 * eval that logged its own runs would be an eval that changed the corpus it
 * measures, and the ledger is the lab's record of what *it* did — not a place
 * to keep our benchmarks. Every read below goes through the same lab-visible
 * gates the scout itself runs behind, so a report cannot name a note the lab
 * could not see.
 *
 * ## The ground truth, and the honest name for it
 *
 * The design asks for "the annotations humans cited in settlement". Walked
 * against the shipped schema, that field does not exist: `actions.setSettled`
 * writes `settledAt` and `settledBy`, and `action.settled` carries `kind` and
 * nothing else. `findingId` provenance on settlement arrives with C4, and will
 * be a *machine*-informed label when it does, which is not what a ground truth
 * is for. So the labels are assembled out of what humans did leave behind
 * while closing a question, and both rules are named as proxies in the report:
 *
 * 1. **co-recorded-citation** — an outcome recorded on the same paper while
 *    the question was open cites a note. That is a person, in the room where
 *    the question was being closed, pointing at a note as what an outcome came
 *    out of. It is the nearest thing in this schema to a settlement citation.
 * 2. **answer-in-thread** — a reply, written before settlement, to the note
 *    the question came from. Not a citation; an answer. The lab wrote it
 *    underneath the question, which is a human act of association even though
 *    nothing in the schema calls it one.
 *
 * Rejected on purpose: the synthesis write-up's citations for the settling
 * session. They are model-chosen (human-signed-off, but chosen by a model),
 * and grading one retriever against another retriever's output is how a
 * benchmark comes to measure agreement instead of truth.
 *
 * ## Why the subject is an `actions` row and not an annotation
 *
 * v1's scout subject is an `open-question` annotation (design §4). Ground
 * truth is not available there: an annotation is never *settled* — the nearest
 * act is an epistemic `resolved` status, which carries a verdict, a name, and
 * a time, but no citation of what resolved it. The retrieval path being scored
 * does not care which table the question came from — `gatherLabVisible` takes
 * a lab and a string — so scoring the subject kind that has ground truth
 * measures the same retriever. The report says which it used.
 */

/* -------------------------------------------------------------------------
 * Bounds
 * ---------------------------------------------------------------------- */

/**
 * How many questions one run will score.
 *
 * The whole report crosses a function boundary, and each question carries the
 * candidates its retrieval returned, so this is a payload bound as much as a
 * cost one. Newest-settled first: if a corpus overflows it, the rows dropped
 * are the ones a reader is least likely to recognize.
 */
export const DEFAULT_QUESTION_LIMIT = 20;
export const MAX_QUESTION_LIMIT = 50;

/** Labs per run, when no single lab was named. */
export const MAX_LABS_SCANNED = 25;

/** Rows an index read may return before the scan stops being bounded. */
export const MAX_ROWS_SCANNED = 500;

/**
 * The search drawer's own numbers, restated.
 *
 * `RESULTS_PER_CATEGORY` and `OVERFETCH` are module-private in
 * `convex/search.ts` and should stay that way — they are that palette's
 * decisions, not shared configuration. Restating them here would be a drift
 * risk if nothing checked it, so something does: `scoutEval.test.ts` runs
 * `search.everything` and this baseline against the same fixture and fails if
 * the two ever disagree about which six notes a question returns.
 */
const BASELINE_RESULTS = 6;
const BASELINE_OVERFETCH = 4;

/* -------------------------------------------------------------------------
 * The baseline: what ⌘K would have shown you
 * ---------------------------------------------------------------------- */

/**
 * `search.everything`'s annotation half, minus the private interleave.
 *
 * Two differences from the shipped query, both forced and both disclosed in
 * the report:
 *
 * 1. **No caller.** `search.everything` is a public query behind
 *    `requireMembership`; an offline run has no signed-in member, so it cannot
 *    call it and does not pretend to. The read below is the same read, made
 *    the same way, against the same index.
 * 2. **No private half.** The drawer runs a second search over the *caller's
 *    own* private notes and interleaves them. Whose private notebook would an
 *    eval use? Every answer to that question is a privacy violation, and the
 *    scout has no private half either — so both sides here are lab-visible
 *    only, and the baseline this reports is therefore the drawer's shared
 *    half. For a question about the lab's shared record that is the fair
 *    comparison; it is also, strictly, a slightly *weaker* drawer than a
 *    member with matching private notes would see, and the report says so
 *    rather than quietly banking the difference.
 */
export async function baselineTopSix(
  ctx: QueryCtx,
  labId: Id<"labs">,
  text: string,
  /**
   * The note the question came out of, dropped exactly as the scout's own
   * gather drops its subject. Without this the seed eats a slot on one side
   * and not the other, and the report's "neither side is penalised for
   * returning it" would be a sentence about a thing that was not happening.
   */
  exclude?: Id<"annotations">,
): Promise<{ ranked: Id<"annotations">[]; candidatesConsidered: number }> {
  // The drawer's own cap, imported rather than restated: a question longer
  // than this is truncated for both sides by the same number.
  const query = text.trim().slice(0, MAX_SEARCH_LENGTH);
  if (query.length === 0) {
    return { ranked: [], candidatesConsidered: 0 };
  }
  const shared = await ctx.db
    .query("annotations")
    .withSearchIndex("search_body", (q) =>
      q.search("body", query).eq("labId", labId).eq("visibility", "lab"),
    )
    .take(BASELINE_RESULTS * BASELINE_OVERFETCH);

  // `deletedAt` and an empty body are the drawer's own filter. `isStillShared`
  // is this module's addition and is belt to the index's braces, exactly as
  // `gatherLabVisible` adds it: the drawer can afford to trust the filter
  // field because a member is entitled to their own private notes anyway, and
  // a report that is going to be read by whoever runs it is not.
  const live = shared.filter(
    (row) =>
      row.deletedAt === undefined &&
      row.body.length > 0 &&
      row._id !== exclude &&
      isStillShared(row, labId),
  );
  return {
    ranked: live.slice(0, BASELINE_RESULTS).map((row) => row._id),
    candidatesConsidered: live.length,
  };
}

/* -------------------------------------------------------------------------
 * The ground truth
 * ---------------------------------------------------------------------- */

const labelShape = v.object({
  annotationId: v.id("annotations"),
  source: v.union(
    v.literal("co-recorded-citation"),
    v.literal("answer-in-thread"),
  ),
});

/** A settled question is a question row somebody closed. Decisions never qualify. */
function isSettledQuestion(row: Doc<"actions">): boolean {
  return row.kind === "question" && row.settledAt !== undefined;
}

/**
 * Every note a human tied to this question between asking it and closing it.
 *
 * Returned with the count of labels that had to be dropped because the note
 * has since been withdrawn or taken private — a number the report prints,
 * because a ground truth that shrank is a ground truth whose recall figures
 * moved for a reason that has nothing to do with retrieval.
 */
async function labelsFor(
  ctx: QueryCtx,
  question: Doc<"actions">,
): Promise<{
  labels: Label<Id<"annotations">>[];
  dropped: number;
  truncated: string[];
}> {
  const settledAt = question.settledAt ?? 0;
  const askedAt = question._creationTime;
  const seed = question.citedAnnotationId;

  const claimed: { id: Id<"annotations">; source: LabelSource }[] = [];
  const truncated: string[] = [];

  // Rule 1. Outcomes on this paper, recorded while the question stood, that
  // point at a note. `by_paper` is the carry-forward index and is already the
  // read this table is shaped for.
  const onPaper = await ctx.db
    .query("actions")
    .withIndex("by_paper", (q) => q.eq("paperId", question.paperId))
    .take(MAX_ROWS_SCANNED);
  if (onPaper.length === MAX_ROWS_SCANNED) {
    truncated.push(
      `outcomes on paper ${question.paperId} hit the ${MAX_ROWS_SCANNED}-row read cap, so a citation made while question ${question._id} was open may be missing`,
    );
  }
  for (const row of onPaper) {
    if (row._id === question._id) continue;
    // Another *question* citing a note is the room asking something, not the
    // room answering anything. The rule is about outcomes that closed
    // something — a decision, or a task somebody took on — and a question row
    // is neither. Counting them would label the corpus with what the lab was
    // still confused about.
    if (row.kind === "question") continue;
    if (row.citedAnnotationId === undefined) continue;
    if (row._creationTime < askedAt || row._creationTime > settledAt) continue;
    claimed.push({ id: row.citedAnnotationId, source: "co-recorded-citation" });
  }

  // Rule 2. What the lab wrote underneath the question, before it was closed.
  if (seed !== undefined) {
    const replies = await ctx.db
      .query("annotations")
      .withIndex("by_parent", (q) => q.eq("parentId", seed))
      .take(MAX_ROWS_SCANNED);
    if (replies.length === MAX_ROWS_SCANNED) {
      truncated.push(
        `replies under note ${seed} hit the ${MAX_ROWS_SCANNED}-row read cap, so an answer to question ${question._id} may be missing`,
      );
    }
    for (const reply of replies) {
      if (reply._creationTime > settledAt) continue;
      claimed.push({ id: reply._id, source: "answer-in-thread" });
    }
  }

  const labels: Label<Id<"annotations">>[] = [];
  const seen = new Set<Id<"annotations">>();
  let dropped = 0;
  for (const one of claimed) {
    // The note the question itself came out of is not evidence about the
    // question — it is the question's own source, and a retriever that finds
    // it has found where it started. Both sides may still return it; neither
    // is scored for doing so.
    if (one.id === seed || seen.has(one.id)) continue;
    seen.add(one.id);
    if (!isStillShared(await ctx.db.get(one.id), question.labId)) {
      dropped += 1;
      continue;
    }
    labels.push({ annotationId: one.id, source: one.source });
  }
  return { labels, dropped, truncated };
}

/* -------------------------------------------------------------------------
 * The two reads the harness makes
 * ---------------------------------------------------------------------- */

/**
 * Every settled question that carries a label, newest settlement first.
 *
 * Deliberately light: ids, the question text, and its labels. The candidates
 * are fetched one question at a time by `retrieve` below, which is both how
 * the real run path is shaped (one gather per delegation) and what keeps any
 * single payload bounded by one question's retrieval rather than by twenty.
 */
export const questions = internalQuery({
  args: {
    labId: v.optional(v.id("labs")),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    population: v.object({
      labsScanned: v.number(),
      questionsSettled: v.number(),
      questionsScored: v.number(),
      questionsWithoutLabels: v.number(),
      questionsUnreadable: v.number(),
      questionsBeyondLimit: v.number(),
      labelsDroppedNotLabVisible: v.number(),
      truncated: v.array(v.string()),
    }),
    questions: v.array(
      v.object({
        actionId: v.id("actions"),
        labId: v.id("labs"),
        question: v.string(),
        settledAt: v.number(),
        labels: v.array(labelShape),
        /** Drops already counted in `population`, so `run` adds only what retrieval finds new. */
        labelsDropped: v.number(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const limit = Math.min(
      Math.max(args.limit ?? DEFAULT_QUESTION_LIMIT, 1),
      MAX_QUESTION_LIMIT,
    );

    const labs =
      args.labId === undefined
        ? await ctx.db.query("labs").take(MAX_LABS_SCANNED)
        : ((row) => (row === null ? [] : [row]))(await ctx.db.get(args.labId));

    const truncated: string[] = [];
    if (args.labId === undefined && labs.length === MAX_LABS_SCANNED) {
      truncated.push(
        `the lab scan hit its ${MAX_LABS_SCANNED}-row cap, so this deployment may hold labs this run never opened`,
      );
    }

    let questionsSettled = 0;
    let questionsWithoutLabels = 0;
    let labelsDroppedNotLabVisible = 0;
    const scoreable: {
      actionId: Id<"actions">;
      labId: Id<"labs">;
      question: string;
      settledAt: number;
      labels: Label<Id<"annotations">>[];
      labelsDropped: number;
    }[] = [];

    for (const lab of labs) {
      // Newest first, so a lab whose outcomes overflow the cap loses its
      // oldest rows rather than its most recent — and says so either way.
      const rows = await ctx.db
        .query("actions")
        .withIndex("by_lab", (q) => q.eq("labId", lab._id))
        .order("desc")
        .take(MAX_ROWS_SCANNED);
      if (rows.length === MAX_ROWS_SCANNED) {
        truncated.push(
          `outcomes in lab ${lab._id} hit the ${MAX_ROWS_SCANNED}-row read cap, so older settled questions were never seen`,
        );
      }
      for (const row of rows) {
        if (!isSettledQuestion(row)) continue;
        questionsSettled += 1;
        const {
          labels,
          dropped,
          truncated: capped,
        } = await labelsFor(ctx, row);
        labelsDroppedNotLabVisible += dropped;
        truncated.push(...capped);
        if (labels.length === 0) {
          questionsWithoutLabels += 1;
          continue;
        }
        scoreable.push({
          actionId: row._id,
          labId: row.labId,
          question: row.body,
          settledAt: row.settledAt ?? 0,
          labels,
          labelsDropped: dropped,
        });
      }
    }

    scoreable.sort((a, b) => b.settledAt - a.settledAt);
    const kept = scoreable.slice(0, limit);

    return {
      population: {
        labsScanned: labs.length,
        questionsSettled,
        questionsScored: kept.length,
        questionsWithoutLabels,
        questionsUnreadable: 0,
        questionsBeyondLimit: scoreable.length - kept.length,
        labelsDroppedNotLabVisible,
        truncated,
      },
      questions: kept,
    };
  },
});

/**
 * Both sides' retrieval for one question, read the way each side reads.
 *
 * `labId` and the question text come off the stored row, never off an
 * argument — the scheduled-reader discipline `delegations.gather` states in
 * full, applied here for the same reason: a lab id in a payload is a claim.
 * The subject is re-read rather than trusted, so a question reopened between
 * the two queries drops out instead of being scored against a settlement that
 * no longer exists. The **labels are re-derived here too**, in the same
 * transaction as the retrieval they will be scored against: a note withdrawn
 * between the two queries would otherwise stay in the label set as a miss
 * neither side could have avoided, which is a wrong number rather than a
 * harsh one.
 */
export const retrieve = internalQuery({
  args: { actionId: v.id("actions") },
  returns: v.union(
    v.object({
      question: v.string(),
      labId: v.id("labs"),
      candidates: v.array(candidateShape),
      baselineRanked: v.array(v.id("annotations")),
      baselineCandidatesConsidered: v.number(),
      labels: v.array(labelShape),
      labelsDropped: v.number(),
      truncated: v.array(v.string()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    if (action === null || !isSettledQuestion(action)) {
      return null;
    }

    const fresh = await labelsFor(ctx, action);
    if (fresh.labels.length === 0) {
      // Not scoreable — but *not* nothing. This re-derivation may have hit a
      // read cap, and it certainly dropped whatever labels have gone private
      // since the selection pass. Returning `null` here would throw both
      // facts away, and a truncation that never reaches the report is a
      // verdict that fails to abstain on a corpus nobody fully read: exactly
      // the hole `population.truncated` exists to close. So the caps and the
      // drop count come back with an empty label set, and `run` is what
      // decides the question cannot be scored.
      return {
        question: action.body,
        labId: action.labId,
        candidates: [],
        baselineRanked: [],
        baselineCandidatesConsidered: 0,
        labels: [],
        labelsDropped: fresh.dropped,
        truncated: fresh.truncated,
      };
    }

    // Both sides drop the note the question came out of, and drop it the same
    // way. `gatherLabVisible`'s fourth argument is what `delegations.gather`
    // passes for an annotation subject — "a note never cites itself" — and the
    // baseline gets the same exclusion so that the seed cannot occupy a
    // scored slot on one side while the report claims neither is penalised.
    const seed = action.citedAnnotationId;
    const gathered = await gatherLabVisible(
      ctx,
      action.labId,
      action.body,
      seed,
    );
    const baseline = await baselineTopSix(
      ctx,
      action.labId,
      action.body,
      seed,
    );

    return {
      question: action.body,
      labId: action.labId,
      candidates: gathered.candidates,
      baselineRanked: baseline.ranked,
      baselineCandidatesConsidered: baseline.candidatesConsidered,
      labels: fresh.labels,
      labelsDropped: fresh.dropped,
      truncated: fresh.truncated,
    };
  },
});

/* -------------------------------------------------------------------------
 * The run
 * ---------------------------------------------------------------------- */

/**
 * The scout's ranked answer, produced by the shipped path and nothing else.
 *
 * Prompt, model seam, citation gate — `buildScoutPrompt` (which is also the
 * second privacy gate, and throws rather than filters), the
 * `internal.delegations.callScoutModel` action, and `sanitizeFindingItems`, in
 * the order `runOne` calls them. What comes back is the finding's citations in
 * item order, which *is* the scout's ranking as a reader receives it.
 *
 * The seam is now a call the harness makes through `ctx`, which is why this
 * function takes one. That means the report measures whatever answered: a
 * deployment with a key measures a model's judgement, and a suite that
 * registers the offline fixture measures the query reduction and the candidate
 * gate. Neither is assumed — the model each question was ranked by is
 * collected on the way past and printed on the report.
 *
 * `model` is `null` when the gather came back empty, because then nothing was
 * called and there is no honest name to write down. Naming one anyway is not a
 * harmless default: a question can carry labels and still gather no candidates
 * — the labels come from the ledger (`labelsFor`: outcomes and replies) and the
 * candidates come from the search index, and two independent sources disagree
 * on a real corpus. A report that filled the gap with the fixture's name would
 * be telling an operator with a live key that a stub had ranked their run.
 */
async function scoutRanking(
  ctx: ActionCtx,
  labId: Id<"labs">,
  question: string,
  candidates: readonly Candidate[],
): Promise<{ ranked: Id<"annotations">[]; model: string | null }> {
  if (candidates.length === 0) return { ranked: [], model: null };
  const prompt = buildScoutPrompt(labId, question, candidates);
  const { byLabel } = labelCandidates(candidates);
  const result = await ctx.runAction(internal.delegations.callScoutModel, {
    prompt,
  });
  if (!result.ok) {
    // A report whose scout side is empty because the call failed would print
    // recall 0 and read as a measurement. Refusing is the honest answer, and
    // an operator running this by hand is exactly who can act on it.
    throw new ConvexError(
      "The scout's model could not be reached, so there is nothing to score it on. Nothing has been measured — check OPENAI_API_KEY on this deployment and run it again.",
    );
  }
  const parsed = parseScoutJson(result.text);
  const { items } = sanitizeFindingItems(parsed ?? {}, byLabel);
  return {
    ranked: topN(items.flatMap((item) => item.citedAnnotationIds)),
    model: result.model,
  };
}

const sideShape = v.object({
  system: v.string(),
  recallAtN: v.number(),
  reciprocalRank: v.number(),
  hits: v.array(v.string()),
  candidatesConsidered: v.number(),
});

const aggregateSideShape = v.object({
  system: v.string(),
  meanRecallAtN: v.number(),
  meanReciprocalRank: v.number(),
  questionsWithAnyHit: v.number(),
  meanCandidatesConsidered: v.number(),
});

const reportShape = v.object({
  generatedAt: v.number(),
  ranker: v.string(),
  topN: v.number(),
  groundTruth: v.object({
    rules: v.array(v.string()),
    caveats: v.array(v.string()),
  }),
  asymmetry: v.array(v.string()),
  population: v.object({
    labsScanned: v.number(),
    questionsSettled: v.number(),
    questionsScored: v.number(),
    questionsWithoutLabels: v.number(),
    questionsUnreadable: v.number(),
    questionsBeyondLimit: v.number(),
    labelsDroppedNotLabVisible: v.number(),
    questionsWithNoRanker: v.number(),
    truncated: v.array(v.string()),
  }),
  questions: v.array(
    v.object({
      subject: v.object({ kind: v.literal("action"), id: v.string() }),
      labId: v.string(),
      question: v.string(),
      settledAt: v.number(),
      labels: v.array(
        v.object({
          annotationId: v.string(),
          source: v.union(
            v.literal("co-recorded-citation"),
            v.literal("answer-in-thread"),
          ),
        }),
      ),
      scout: sideShape,
      baseline: sideShape,
      winner: v.union(
        v.literal("scout"),
        v.literal("baseline"),
        v.literal("tie"),
      ),
    }),
  ),
  aggregate: v.object({
    questionsScored: v.number(),
    scout: aggregateSideShape,
    baseline: aggregateSideShape,
    scoutWins: v.number(),
    baselineWins: v.number(),
    ties: v.number(),
  }),
  verdict: v.string(),
});

/**
 * What the ground-truth rules say, in the report, above the numbers.
 *
 * The design asked for the asymmetry "in the output itself, not a footnote",
 * and the same argument applies to the labels: a reader who sees recall@6
 * without seeing what counted as relevant has been handed a number and denied
 * the only thing that makes it mean anything.
 */
const GROUND_TRUTH_RULES = [
  "co-recorded-citation: an outcome recorded on the same paper, between this question being asked and being settled, cites this note.",
  "answer-in-thread: this note is a reply, written before settlement, to the note the question came out of.",
  "Excluded everywhere: the note the question itself came out of. It is not a label, and it is dropped from both sides' results before either is scored — the same exclusion the scout's own gather applies to its subject. It is the question's source, not evidence about it, so neither side spends a slot on it.",
];

const GROUND_TRUTH_CAVEATS = [
  "Nothing in this schema records 'the notes cited in settling this question' — settlement stores a time and a name. Both rules above are proxies, and label sets are certainly incomplete: a note nobody happened to cite may have been just as relevant.",
  "Because the labels are incomplete, recall is reported and precision is not. A precision figure here would be measuring the ground truth's coverage and calling it the retriever's error.",
  "Labels whose note has since been withdrawn or taken private are dropped, and the count of dropped labels is reported above.",
];

/**
 * What the `ranker` field says when no question reached the model.
 *
 * A sentinel rather than an empty string, because this field is printed: a
 * report has to be able to say "nothing ranked this" in the same slot it
 * otherwise says "gpt-5.6-sol", and the prose below branches on it rather than
 * describing a run that never happened.
 */
const NO_RANKER = "none — no question reached the model";

/**
 * The run's disclosures, in the output rather than in a footnote.
 *
 * Takes the models that answered as a *set* rather than the joined string the
 * report prints, because the two questions this prose has to answer are "was
 * any of this the fixture" and "was any of it a model", and both are membership
 * questions. Asking them of the joined string means exact equality, and exact
 * equality drops the §10.2 warning from precisely the run that most needs it:
 * the mixed one, where half the rows were ranked by a stub.
 */
function asymmetryNotes(
  answered: readonly string[],
  questionsWithNoRanker: number,
): string[] {
  const others = answered.filter((one) => one !== STUB_MODEL);
  return [
    `Candidate counts are not equal, by construction. The scout ranks the notes its gather returned (up to ${MAX_CANDIDATES}); the search drawer reads the index's top ${BASELINE_RESULTS * BASELINE_OVERFETCH} and returns the first ${BASELINE_RESULTS} that survive its live filter, ranking nothing further. Both sides are scored on ${EVAL_TOP_N} results, and each per-question row prints the pool its side actually chose from.`,
    `The two sides also send different queries: the scout reduces the question to keywords (stopwords and repeats removed) to fit the ${MAX_SEARCH_LENGTH}-character search cap, while the drawer sends the question as a member typed it, truncated at the same cap. That difference is part of what is being measured, not a defect in the comparison.`,
    "The baseline is the drawer's shared half, and that makes it the drawer's *upper* bound rather than a handicap. `search.everything` interleaves the caller's own private notes into the same six slots — a member's private notes evict lab-visible rows rather than extending the list — and every label here is lab-visible by construction. So a real member, sitting in front of the real drawer with private notes of their own that match, would see at most as many labelled notes as this baseline reports and usually fewer. An eval has no caller whose notebook it could legitimately read, and the scout has no private half either.",
    "Retrieval runs against the corpus as it stands today, not as it stood on the day each question was settled: notes written since are candidates now and were not then. Both sides read the same corpus, so the comparison holds — but absolute recall drifts downward as a lab keeps writing, and two runs made on different dates are not comparable to each other.",
    answered.length === 0
      ? "No question in this run reached the model — every one of them was dropped, or gathered nothing to rank. The scout side is not a measurement of anything, and the numbers beside it are the arithmetic of an empty list."
      : !answered.includes(STUB_MODEL)
        ? `The scout side was ranked by ${answered.join(", ")}, through the same prompt, seam, and citation gate the product uses.`
        : others.length === 0
          ? `The scout side was ranked by the offline fixture (${STUB_MODEL}), which cites its candidates in gather order. This run measured retrieval and query reduction, not a model's judgement, and it is not the gate the design's §10.2 is asking for.`
          : `Part of this run was ranked by the offline fixture (${STUB_MODEL}), which cites its candidates in gather order, and part by ${others.join(", ")}. Mixed, the aggregate is not a measurement of a model's judgement either, and this run is not the gate the design's §10.2 is asking for.`,
    ...(questionsWithNoRanker === 0
      ? []
      : [
          // Scored, and scored correctly — but a question whose gather came
          // back empty contributes recall 0 to the means without any model
          // having seen it. Left undisclosed, the reader reads those zeros as
          // a model's failure to rank rather than as retrieval's failure to
          // return, and those are different repairs.
          `${questionsWithNoRanker} scored question${questionsWithNoRanker === 1 ? "" : "s"} gathered no candidates at all, so no model was asked about ${questionsWithNoRanker === 1 ? "it" : "them"} and ${questionsWithNoRanker === 1 ? "its" : "their"} recall 0 is retrieval's, not a ranker's. The per-question rows above print ${questionsWithNoRanker === 1 ? "it" : "them"} with a candidate pool of 0, and ${questionsWithNoRanker === 1 ? "it counts" : "they count"} toward the aggregate on any run where one is shown — under this gate's minimum, no aggregate is printed at all.`,
        ]),
  ];
}

/**
 * One report, over a lab or over everything the deployment holds.
 *
 * ```
 * npx convex run --push scoutEval:run '{}'
 * npx convex run --push scoutEval:run '{"labId": "kd7…"}'
 * ```
 *
 * Returns the structured report and logs the readable rendering, because the
 * two audiences are different: a person deciding whether Track C launches
 * reads the log, and the next run's diff reads the object.
 */
export const run = internalAction({
  args: {
    labId: v.optional(v.id("labs")),
    limit: v.optional(v.number()),
  },
  returns: reportShape,
  handler: async (ctx: ActionCtx, args): Promise<ScoutEvalReport> => {
    const found = await ctx.runQuery(internal.scoutEval.questions, {
      ...(args.labId === undefined ? {} : { labId: args.labId }),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    });

    const scored: QuestionScore[] = [];
    const truncated = [...found.population.truncated];
    const rankers = new Set<string>();
    let unreadable = 0;
    let droppedAtRetrieval = 0;
    let withNoRanker = 0;

    for (const one of found.questions) {
      const retrieved = await ctx.runQuery(internal.scoutEval.retrieve, {
        actionId: one.actionId,
      });
      if (retrieved === null) {
        // The question moved between the two reads — reopened, withdrawn, or
        // left with no surviving label. Not scoreable, and counted as its own
        // fact rather than folded in with "nobody cited anything".
        unreadable += 1;
        continue;
      }

      // Labels re-derived inside the retrieval transaction win. Only the
      // *additional* drops are added, since the selection pass already
      // reported its own.
      droppedAtRetrieval += Math.max(
        0,
        retrieved.labelsDropped - one.labelsDropped,
      );
      truncated.push(...retrieved.truncated);

      // Its labels went while we were looking at it. Counted as moved rather
      // than as unlabelled, and only *after* its caps and its drops have been
      // taken off it above.
      if (retrieved.labels.length === 0) {
        unreadable += 1;
        continue;
      }

      const { ranked, model } = await scoutRanking(
        ctx,
        retrieved.labId,
        retrieved.question,
        retrieved.candidates,
      );
      if (model === null) withNoRanker += 1;
      else rankers.add(model);

      scored.push(
        scoreQuestion({
          subject: { kind: "action", id: one.actionId },
          labId: one.labId,
          question: one.question,
          settledAt: one.settledAt,
          labels: retrieved.labels,
          scout: {
            system:
              model === null
                ? "scout (nothing gathered; no model called)"
                : `scout (${model})`,
            ranked,
            candidatesConsidered: retrieved.candidates.length,
          },
          baseline: {
            system: "search.everything",
            ranked: retrieved.baselineRanked,
            candidatesConsidered: retrieved.baselineCandidatesConsidered,
          },
        }),
      );
    }

    /**
     * What ranked this report — collected rather than declared.
     *
     * A `ranker` field the code writes down in advance is a field that stays
     * true only until the seam behind it changes, which is exactly what
     * happened to this file. A set, because a report is one run against one
     * deployment and the honest answer to "which models" is however many
     * answered — and a sorted join, because one name joined is that name, so
     * the common case needs no branch of its own and no fallback that would
     * only ever fire by naming something that had not run.
     *
     * Computed before the aggregate because the aggregate is labelled from it.
     * Left to its own devices `aggregate` takes the first row's `system` as the
     * heading for every row's numbers, and the first row is not a spokesman.
     */
    const answered = [...rankers].sort();
    const ranker = answered.length === 0 ? NO_RANKER : answered.join(", ");
    const totals = aggregate(scored, `scout (${ranker})`);
    const report: ScoutEvalReport = {
      generatedAt: Date.now(),
      ranker,
      topN: EVAL_TOP_N,
      groundTruth: {
        rules: GROUND_TRUTH_RULES,
        caveats: GROUND_TRUTH_CAVEATS,
      },
      asymmetry: asymmetryNotes(answered, withNoRanker),
      population: {
        ...found.population,
        questionsScored: scored.length,
        questionsUnreadable: unreadable,
        labelsDroppedNotLabVisible:
          found.population.labelsDroppedNotLabVisible + droppedAtRetrieval,
        questionsWithNoRanker: withNoRanker,
        truncated: [...new Set(truncated)],
      },
      questions: scored,
      aggregate: totals,
      verdict: verdictOf(totals, { truncated: [...new Set(truncated)] }),
    };

    console.log(formatScoutEvalReport(report));
    return report;
  },
});
