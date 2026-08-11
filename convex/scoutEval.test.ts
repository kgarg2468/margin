import { describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  FakeCtx,
  fakeScoutModel,
  handlerOf,
  registerFakeScoutModel,
  seedAnnotation,
  seedLab,
} from "./delegations.fixtures";
import type { ScoutEvalReport } from "../lib/eval/scout-eval";
import { MAX_SEARCH_LENGTH } from "./search";
import {
  MAX_LABS_SCANNED,
  MAX_ROWS_SCANNED,
  baselineTopSix,
  questions,
  retrieve,
  run,
} from "./scoutEval";
import * as search from "./search";

vi.mock("@convex-dev/auth/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@convex-dev/auth/server")>()),
  getAuthUserId: async (ctx: unknown) =>
    (ctx as { auth?: { userId?: string } }).auth?.userId ?? null,
}));

/**
 * The eval harness, against a corpus it can be made to lie about.
 *
 * The arithmetic is tested in `lib/eval/scout-eval.test.ts`. What is tested
 * here is everything the arithmetic depends on and cannot see: which notes
 * become labels, which notes are refused as labels because the lab can no
 * longer see them, that the baseline is the drawer's own read rather than a
 * second implementation of it that has drifted, and — the one that would
 * matter most if it broke — that no private note reaches the report even when
 * the search index has stopped honouring the filter that keeps it out.
 *
 * The in-memory harness is `delegations.fixtures.ts`, and its search index
 * matches every row in the table: relevance is not simulated and must not be
 * asserted on here. What *is* faithful is which rows each side may read, in
 * what order it takes them, and how many.
 */

/** Late enough that every fixture row was created before the question closed. */
const SETTLED_AT = 1_000_000;

async function seedSettledQuestion(ctx: FakeCtx) {
  const seed = await seedLab(ctx);
  await ctx.db.patch(seed.actionId, {
    // The question came out of the open-question note, which is what the
    // outcomes panel records when a member settles from a thread.
    citedAnnotationId: seed.questionId,
    settledAt: SETTLED_AT,
    settledBy: seed.pi,
  });
  return seed;
}

/** A note somebody wrote in answer, under the question. */
async function seedReply(
  ctx: FakeCtx,
  seed: Awaited<ReturnType<typeof seedLab>>,
  overrides: Partial<{ visibility: "private" | "lab"; body: string }> = {},
): Promise<Id<"annotations">> {
  const id = await seedAnnotation(ctx, { ...seed, memberId: seed.member }, {
    type: "critique",
    body: overrides.body ?? "The 4°C step is the difference; we re-ran it.",
    ...(overrides.visibility === undefined
      ? {}
      : { visibility: overrides.visibility }),
  });
  await ctx.db.patch(id, { parentId: seed.questionId });
  return id;
}

/** A second settled, labelled question in the same lab, with its own source note. */
async function seedExtraQuestion(
  ctx: FakeCtx,
  seed: Awaited<ReturnType<typeof seedLab>>,
  settledAt: number,
  body: string,
): Promise<Id<"actions">> {
  const source = await seedAnnotation(ctx, { ...seed, memberId: seed.pi }, {
    body,
  });
  const actionId = await ctx.db.insert("actions", {
    labId: seed.labId,
    sessionId: seed.sessionId,
    paperId: seed.paperId,
    kind: "question",
    body,
    recordedBy: seed.pi,
    citedAnnotationId: source,
    settledAt,
    settledBy: seed.pi,
  });
  const reply = await seedAnnotation(ctx, { ...seed, memberId: seed.member }, {
    type: "critique",
    body: "The plates were logged in the second notebook.",
  });
  await ctx.db.patch(reply, { parentId: source });
  return actionId;
}

/**
 * A settled question, labelled, whose text the search read cannot use.
 *
 * All stopwords, so `reduceToSearchQuery` reduces it to nothing and
 * `gatherLabVisible` returns before it reads the index — a labelled question
 * with zero candidates, which is the shape the eval's ranker accounting keeps
 * getting wrong. It is reachable because labels and candidates come from
 * different places: the labels are ledger-derived (a reply in the thread), and
 * no reply has to share a keyword with the question it answers.
 */
const seedUnsearchableQuestion = (
  ctx: FakeCtx,
  seed: Awaited<ReturnType<typeof seedLab>>,
  settledAt: number,
): Promise<Id<"actions">> =>
  seedExtraQuestion(ctx, seed, settledAt, "Is it? And so on.");

/** An outcome the room recorded on the same paper, pointing at a note. */
async function seedCoRecorded(
  ctx: FakeCtx,
  seed: Awaited<ReturnType<typeof seedLab>>,
  citedAnnotationId: Id<"annotations">,
): Promise<Id<"actions">> {
  return await ctx.db.insert("actions", {
    labId: seed.labId,
    sessionId: seed.sessionId,
    paperId: seed.paperId,
    kind: "decision",
    body: "We standardise on the 4°C overnight incubation.",
    recordedBy: seed.pi,
    citedAnnotationId,
  });
}

/** What `questions` returns, as this suite reads it. */
type Found = {
  population: {
    labsScanned: number;
    questionsSettled: number;
    questionsScored: number;
    questionsWithoutLabels: number;
    labelsDroppedNotLabVisible: number;
  };
  questions: {
    actionId: Id<"actions">;
    labId: Id<"labs">;
    question: string;
    settledAt: number;
    labels: { annotationId: Id<"annotations">; source: string }[];
  }[];
};

const askQuestions = async (ctx: FakeCtx): Promise<Found> =>
  (await handlerOf(questions)(ctx, {} as never)) as Found;

const runReport = async (ctx: FakeCtx): Promise<ScoutEvalReport> =>
  (await handlerOf(run)(ctx, {} as never)) as ScoutEvalReport;

describe("ground truth", () => {
  it("labels the notes a human tied to the question while it was open", async () => {
    const ctx = new FakeCtx();
    const seed = await seedSettledQuestion(ctx);
    const reply = await seedReply(ctx, seed);
    const cited = await seedAnnotation(ctx, { ...seed, memberId: seed.pi }, {
      body: "Cohort B was incubated at room temperature by mistake.",
    });
    await seedCoRecorded(ctx, seed, cited);

    const found = await askQuestions(ctx);

    expect(found.population.questionsSettled).toBe(1);
    expect(found.questions).toHaveLength(1);
    const row = found.questions[0]!;
    expect(row.question).toContain("4°C");
    expect(new Set(row.labels.map((label) => label.annotationId))).toEqual(
      new Set([reply, cited]),
    );
    expect(
      row.labels.find((label) => label.annotationId === reply)?.source,
    ).toBe("answer-in-thread");
    expect(
      row.labels.find((label) => label.annotationId === cited)?.source,
    ).toBe("co-recorded-citation");
  });

  it("never labels the note the question itself came out of", async () => {
    const ctx = new FakeCtx();
    const seed = await seedSettledQuestion(ctx);
    await seedReply(ctx, seed);
    // The question cites `questionId`, and an outcome citing it back would
    // otherwise make the question's own source count as evidence about it.
    await seedCoRecorded(ctx, seed, seed.questionId);

    const found = await askQuestions(ctx);
    const ids = found.questions[0]!.labels.map((label) => label.annotationId);
    expect(ids).not.toContain(seed.questionId);
  });

  it("does not label a note that another open question cited", async () => {
    const ctx = new FakeCtx();
    const seed = await seedSettledQuestion(ctx);
    const askedAbout = await seedAnnotation(ctx, { ...seed, memberId: seed.pi }, {
      body: "Cohort B's incubation log is missing a timestamp.",
    });
    // A second question citing a note is the room asking something, not the
    // room answering this question.
    await ctx.db.insert("actions", {
      labId: seed.labId,
      sessionId: seed.sessionId,
      paperId: seed.paperId,
      kind: "question",
      body: "Where did the cohort B timestamps go?",
      recordedBy: seed.member,
      citedAnnotationId: askedAbout,
    });
    const answered = await seedReply(ctx, seed);

    const found = await askQuestions(ctx);
    const ids = found.questions[0]!.labels.map((label) => label.annotationId);
    expect(ids).toEqual([answered]);
  });

  it("drops a label whose note stopped being lab-visible, and counts it", async () => {
    const ctx = new FakeCtx();
    const seed = await seedSettledQuestion(ctx);
    await seedReply(ctx, seed, { visibility: "private" });
    const withdrawn = await seedAnnotation(
      ctx,
      { ...seed, memberId: seed.pi },
      { body: "", deletedAt: 5 },
    );
    await seedCoRecorded(ctx, seed, withdrawn);

    const found = await askQuestions(ctx);
    expect(found.population.labelsDroppedNotLabVisible).toBe(2);
    expect(found.population.questionsWithoutLabels).toBe(1);
    expect(found.questions).toHaveLength(0);
  });

  it("ignores an open question, a reopened one, and a settled task", async () => {
    const ctx = new FakeCtx();
    const seed = await seedLab(ctx);
    await seedReply(ctx, seed);
    await ctx.db.insert("actions", {
      labId: seed.labId,
      sessionId: seed.sessionId,
      paperId: seed.paperId,
      kind: "task",
      body: "Re-run cohort B.",
      recordedBy: seed.pi,
      settledAt: SETTLED_AT,
      settledBy: seed.pi,
      citedAnnotationId: seed.questionId,
    });

    const found = await askQuestions(ctx);
    expect(found.population.questionsSettled).toBe(0);
    expect(found.questions).toHaveLength(0);
  });

  it("does not count a note cited after the question was already closed", async () => {
    const ctx = new FakeCtx();
    const seed = await seedSettledQuestion(ctx);
    const late = await seedAnnotation(ctx, { ...seed, memberId: seed.pi });
    const actionId = await seedCoRecorded(ctx, seed, late);
    // `_creationTime` in the fixture is a counter; push this outcome past the
    // settlement the way a real one recorded weeks later would be.
    await ctx.db.patch(actionId, { citedAnnotationId: late });
    const rows = ctx.db.all("actions");
    const recorded = rows.find((row) => row._id === actionId)!;
    (recorded as unknown as { _creationTime: number })._creationTime =
      SETTLED_AT + 1;

    const found = await askQuestions(ctx);
    expect(found.questions).toHaveLength(0);
    expect(found.population.questionsWithoutLabels).toBe(1);
  });
});

describe("the baseline", () => {
  it("returns what the search drawer's annotation half returns", async () => {
    const ctx = new FakeCtx();
    const seed = await seedSettledQuestion(ctx);
    for (let i = 0; i < 9; i++) {
      await seedAnnotation(ctx, { ...seed, memberId: seed.member }, {
        body: `Note ${i} about the 4°C incubation step.`,
      });
    }
    ctx.auth = { userId: seed.member };

    const drawer = (await handlerOf(search.everything)(ctx, {
      labId: seed.labId,
      text: "Does the 4°C incubation step explain the reproducibility gap?",
    } as never)) as { annotations: { _id: Id<"annotations"> }[] };
    const mine = await baselineTopSix(
      ctx as never,
      seed.labId,
      "Does the 4°C incubation step explain the reproducibility gap?",
    );

    // The parity that matters: same rows, same order, same six. If the
    // drawer's cap or its live-row filter ever changes, this fails rather
    // than the report quietly scoring against a baseline nobody ships.
    expect(mine.ranked).toEqual(drawer.annotations.map((row) => row._id));
    expect(mine.ranked).toHaveLength(6);
  });

  it("agrees with the drawer when withdrawn notes push the overfetch to work", async () => {
    const ctx = new FakeCtx();
    const seed = await seedSettledQuestion(ctx);
    // The overfetch has to be load-bearing, or a drift from 4 to 3 would
    // pass. The seeded open question is live and first; then eighteen
    // withdrawn rows; then the live ones. The sixth survivor therefore sits
    // at row 24 — the last row the drawer reads — so any shrink of either
    // side's overfetch returns a shorter list and fails this test.
    for (let i = 0; i < 18; i++) {
      await seedAnnotation(ctx, { ...seed, memberId: seed.member }, {
        body: "",
        deletedAt: 99,
      });
    }
    const live: Id<"annotations">[] = [];
    for (let i = 0; i < 8; i++) {
      live.push(
        await seedAnnotation(ctx, { ...seed, memberId: seed.member }, {
          body: `Note ${i} about the 4°C incubation step.`,
        }),
      );
    }
    ctx.auth = { userId: seed.member };
    const text = "Does the 4°C incubation step explain the gap?";

    const drawer = (await handlerOf(search.everything)(ctx, {
      labId: seed.labId,
      text,
    } as never)) as { annotations: { _id: Id<"annotations"> }[] };
    const mine = await baselineTopSix(ctx as never, seed.labId, text);

    expect(mine.ranked).toEqual(drawer.annotations.map((row) => row._id));
    expect(mine.ranked).toHaveLength(6);
    // The last survivor inside the 24-row window is in; the rows past the
    // window are not. Both halves matter: the first fails if the overfetch
    // shrinks, the second if it grows.
    expect(mine.ranked).toContain(live[4]);
    expect(mine.ranked).not.toContain(live[5]);
    expect(mine.candidatesConsidered).toBe(6);
  });

  it("is the drawer's upper bound: a member's own private notes evict lab rows", async () => {
    const ctx = new FakeCtx();
    const seed = await seedSettledQuestion(ctx);
    for (let i = 0; i < 10; i++) {
      await seedAnnotation(ctx, { ...seed, memberId: seed.pi }, {
        body: `Shared note ${i} about the incubation step.`,
      });
    }
    const ownPrivate = await seedAnnotation(
      ctx,
      { ...seed, memberId: seed.member },
      { visibility: "private", body: "Privately: I think it is the 4°C step." },
    );
    ctx.auth = { userId: seed.member };
    const text = "Does the 4°C incubation step explain the gap?";

    const drawer = (await handlerOf(search.everything)(ctx, {
      labId: seed.labId,
      text,
    } as never)) as { annotations: { _id: Id<"annotations"> }[] };
    const mine = await baselineTopSix(ctx as never, seed.labId, text);
    const shown = drawer.annotations.map((row) => row._id);

    // The interleave branch, exercised: the member's own note takes one of
    // the six rather than making it seven. Every label in this harness is
    // lab-visible, so the real drawer shows *fewer* labelled notes than this
    // baseline — which is why the report calls the baseline an upper bound.
    expect(shown).toContain(ownPrivate);
    expect(shown).toHaveLength(6);
    expect(mine.ranked).not.toContain(ownPrivate);
    expect(mine.ranked.filter((id) => shown.includes(id)).length).toBeLessThan(
      mine.ranked.length,
    );
  });

  it("truncates a long question exactly where the drawer truncates it", async () => {
    const ctx = new FakeCtx();
    const seed = await seedSettledQuestion(ctx);
    await seedAnnotation(ctx, { ...seed, memberId: seed.member });
    ctx.auth = { userId: seed.member };
    const long = `${"incubation temperature reproducibility ".repeat(20)}?`;
    expect(long.length).toBeGreaterThan(MAX_SEARCH_LENGTH);

    const drawer = (await handlerOf(search.everything)(ctx, {
      labId: seed.labId,
      text: long,
    } as never)) as { annotations: { _id: Id<"annotations"> }[] };
    const mine = await baselineTopSix(ctx as never, seed.labId, long);
    expect(mine.ranked).toEqual(drawer.annotations.map((row) => row._id));
  });

  it("returns nothing for a question that reduces to nothing", async () => {
    const ctx = new FakeCtx();
    const seed = await seedLab(ctx);
    expect(await baselineTopSix(ctx as never, seed.labId, "   ")).toEqual({
      ranked: [],
      candidatesConsidered: 0,
    });
  });
});

describe("the report", () => {
  function registered(): FakeCtx {
    const ctx = new FakeCtx()
      .register(internal.scoutEval.questions, questions)
      .register(internal.scoutEval.retrieve, retrieve);
    // The harness ranks through the product's own model seam, so an offline
    // report needs the same stand-in the lifecycle suites use — and the report
    // says so, because the fixture is what ranked it.
    registerFakeScoutModel(ctx);
    return ctx;
  }

  it("scores both sides and refuses a verdict off one question", async () => {
    const ctx = registered();
    const seed = await seedSettledQuestion(ctx);
    await seedReply(ctx, seed);

    const report = await runReport(ctx);

    expect(report.population.questionsScored).toBe(1);
    expect(report.questions).toHaveLength(1);
    const row = report.questions[0]!;
    expect(row.subject.kind).toBe("action");
    expect(row.scout.recallAtN).toBe(1);
    expect(row.baseline.recallAtN).toBe(1);
    expect(report.verdict).toMatch(/^No verdict/);
    expect(report.ranker).toBe("stub.scout.v0");
  });

  it("discloses the candidate-count asymmetry per question and in words", async () => {
    const ctx = registered();
    const seed = await seedSettledQuestion(ctx);
    await seedReply(ctx, seed);
    // Enough notes that the two sides' pools genuinely differ: the drawer
    // stops at its overfetch (6 x 4), the scout gathers up to forty.
    for (let i = 0; i < 30; i++) {
      await seedAnnotation(ctx, { ...seed, memberId: seed.member }, {
        body: `Another note ${i} on the incubation step.`,
      });
    }

    const report = await runReport(ctx);
    const row = report.questions[0]!;
    // The scout ranks everything it gathered; the drawer hands back six and
    // ranks nothing. Both numbers travel with the row that used them.
    expect(row.scout.candidatesConsidered).toBeGreaterThan(
      row.baseline.candidatesConsidered,
    );
    expect(report.asymmetry.join(" ")).toMatch(/Candidate counts are not equal/);
    expect(report.asymmetry.join(" ")).toMatch(/offline fixture/);
    expect(report.groundTruth.caveats.join(" ")).toMatch(/proxies/);
  });

  it("says nothing rather than something when the corpus has no settled questions", async () => {
    const ctx = registered();
    await seedLab(ctx);
    const report = await runReport(ctx);
    expect(report.population.questionsSettled).toBe(0);
    expect(report.verdict).toMatch(/statement about the data/);
  });

  it("abstains when a bounded read came back full, and names the cap", async () => {
    const ctx = registered();
    const seed = await seedSettledQuestion(ctx);
    await seedReply(ctx, seed);
    // One more lab than the scan will open. The harness has not seen the
    // deployment, and a gate cannot be read off the part of it that fit.
    for (let i = 0; i < MAX_LABS_SCANNED; i++) {
      await ctx.db.insert("labs", {
        name: `Lab ${i}`,
        createdBy: seed.pi,
        memberCount: 1,
      });
    }

    const report = await runReport(ctx);
    expect(report.population.truncated.length).toBeGreaterThan(0);
    expect(report.population.truncated.join(" ")).toContain("lab scan");
    expect(report.verdict).toMatch(/did not see the whole corpus/);
  });

  it("counts a question that lost its labels mid-run as moved, not as unlabelled", async () => {
    const ctx = registered();
    const seed = await seedSettledQuestion(ctx);
    const reply = await seedReply(ctx, seed);
    // Take the label private *between* the selection read and the retrieval
    // read — the window the re-derivation inside `retrieve` exists to close.
    ctx.register(internal.scoutEval.retrieve, {
      _handler: async (inner: unknown, args: unknown) => {
        await ctx.db.patch(reply, { visibility: "private" });
        return await handlerOf(retrieve)(inner, args as never);
      },
    });

    const report = await runReport(ctx);
    expect(report.population.questionsScored).toBe(0);
    expect(report.population.questionsUnreadable).toBe(1);
    expect(report.population.questionsWithoutLabels).toBe(0);
    expect(JSON.stringify(report)).not.toContain(reply);
  });

  it("carries a cap hit out of the retrieval pass, and abstains on it", async () => {
    const ctx = registered();
    const seed = await seedSettledQuestion(ctx);
    const reply = await seedReply(ctx, seed);

    // The selection pass sees one clean label and no caps. Everything below
    // happens *between* the two reads, so a truncation entry in the final
    // report can only have come out of `retrieve`.
    ctx.register(internal.scoutEval.retrieve, {
      _handler: async (inner: unknown, args: unknown) => {
        await ctx.db.patch(reply, { visibility: "private" });
        for (let i = 0; i < MAX_ROWS_SCANNED + 1; i++) {
          const id = await ctx.db.insert("annotations", {
            labId: seed.labId,
            paperId: seed.paperId,
            memberId: seed.member,
            anchor: {
              quote: "incubation at 4°C",
              prefix: "",
              suffix: "",
              start: 0,
              end: 17,
              pageIndex: 2,
            },
            type: "critique",
            body: `Private answer ${i}.`,
            visibility: "private",
          });
          await ctx.db.patch(id, { parentId: seed.questionId });
        }
        return await handlerOf(retrieve)(inner, args as never);
      },
    });

    const report = await runReport(ctx);

    expect(report.population.truncated.join(" ")).toContain("read cap");
    expect(report.population.questionsUnreadable).toBe(1);
    expect(report.population.questionsScored).toBe(0);
    // Every one of the 500 rows the capped read did return was private.
    expect(report.population.labelsDroppedNotLabVisible).toBe(MAX_ROWS_SCANNED);
    expect(report.verdict).toMatch(/did not see the whole corpus/);
  });

  it("keeps a private note out of the report even when the index leaks it", async () => {
    const ctx = registered();
    const seed = await seedSettledQuestion(ctx);
    await seedReply(ctx, seed);
    const secret = await seedAnnotation(ctx, { ...seed, memberId: seed.pi }, {
      visibility: "private",
      body: "Privately: the 4°C incubation result never replicated for me.",
    });
    // The adversary from `delegations.privacy.test.ts`: an index that has
    // stopped honouring `visibility` and hands back every row in the table.
    ctx.db.hostileSearchIndex = true;

    const report = await runReport(ctx);

    expect(JSON.stringify(report)).not.toContain(secret);
    expect(report.questions[0]!.scout.hits).not.toContain(secret);
  });
});

/* -------------------------------------------------------------------------
 * Who ranked it
 * ---------------------------------------------------------------------- */

/**
 * The report may not name a ranker that did not rank.
 *
 * Every one of these is a regression test for the same class of bug: a name
 * written down where a fact belonged. A question can be scored and never reach
 * a model — its labels come from the ledger and its candidates come from the
 * search index, and those two disagree on a real corpus — so "what ranked this"
 * has to be collected from the runs that happened, per row, and then said once
 * at the top. Filling the gap with a plausible default is how a report ends up
 * telling an operator with a live key that a stub ranked their launch gate.
 */
describe("the ranker the report names", () => {
  function registeredEval(): FakeCtx {
    const ctx = new FakeCtx()
      .register(internal.scoutEval.questions, questions)
      .register(internal.scoutEval.retrieve, retrieve);
    registerFakeScoutModel(ctx);
    return ctx;
  }

  it("names nothing, and says so in prose, when no question reached the model", async () => {
    const ctx = registeredEval();
    await seedLab(ctx);

    const report = await runReport(ctx);

    expect(report.ranker).toBe("none — no question reached the model");
    // Not "ranked by none — no question reached the model, through the same
    // prompt, seam, and citation gate the product uses", which is what a
    // sentinel poured through the model branch reads like.
    expect(report.asymmetry.join(" ")).toMatch(
      /No question in this run reached the model/,
    );
    expect(report.asymmetry.join(" ")).not.toMatch(/ranked by none/);
  });

  it("leaves a scored question that gathered nothing out of the ranker set", async () => {
    const ctx = registeredEval();
    const seed = await seedLab(ctx);
    await seedUnsearchableQuestion(ctx, seed, SETTLED_AT);

    const report = await runReport(ctx);

    // Scored — it has a label — and ranked by nobody.
    expect(report.population.questionsScored).toBe(1);
    expect(report.questions[0]!.scout.candidatesConsidered).toBe(0);
    expect(report.questions[0]!.scout.system).toBe(
      "scout (nothing gathered; no model called)",
    );
    expect(report.population.questionsWithNoRanker).toBe(1);
    // The fixture was registered and never called. Naming it here is the
    // failure this test exists for.
    expect(report.ranker).not.toContain("stub.scout.v0");
    expect(report.ranker).toBe("none — no question reached the model");
  });

  it("keeps the sentinel out of the aggregate when the first row is the empty one", async () => {
    const ctx = registeredEval();
    const seed = await seedSettledQuestion(ctx);
    await seedReply(ctx, seed);
    // Settled *later*, so it sorts to the front of the report — which is the
    // whole bug: the aggregate used to take its heading from row 0, so one
    // question that gathered nothing would caption the means every other
    // question produced.
    await seedUnsearchableQuestion(ctx, seed, SETTLED_AT + 1);

    const report = await runReport(ctx);

    expect(report.population.questionsScored).toBe(2);
    expect(report.questions[0]!.scout.candidatesConsidered).toBe(0);
    expect(report.aggregate.scout.system).toBe("scout (stub.scout.v0)");
    expect(report.aggregate.scout.system).not.toContain("nothing gathered");
    expect(report.ranker).toBe("stub.scout.v0");

    const asymmetry = report.asymmetry.join(" ");
    // The mixed run still gets the fixture caveat, and it also gets told that
    // one of its two rows contributed a recall 0 no model was asked about.
    expect(asymmetry).toMatch(/offline fixture/);
    expect(report.population.questionsWithNoRanker).toBe(1);
    expect(asymmetry).toMatch(/1 scored question gathered no candidates/);
    expect(asymmetry).not.toContain("nothing gathered; no model called");
  });

  it("says the fixture ranked the whole run, without the mixed-run sentence", async () => {
    const ctx = registeredEval();
    const seed = await seedSettledQuestion(ctx);
    await seedReply(ctx, seed);

    const report = await runReport(ctx);
    const asymmetry = report.asymmetry.join(" ");

    expect(report.ranker).toBe("stub.scout.v0");
    // `/offline fixture/` alone cannot tell these two sentences apart — the
    // mixed one contains it too — so this pins the phrases only the whole-run
    // sentence has, and the phrase only the mixed one has.
    expect(asymmetry).toMatch(/The scout side was ranked by the offline fixture/);
    expect(asymmetry).toMatch(/This run measured retrieval and query reduction/);
    expect(asymmetry).not.toMatch(/part by/);
  });

  it("names the model and drops the fixture caveat when a model ranked every question", async () => {
    const ctx = registeredEval();
    const seed = await seedSettledQuestion(ctx);
    await seedReply(ctx, seed);
    // The sentence a deployment with a real key actually prints, and the one
    // branch no offline suite reaches by default — the fixture answers to its
    // own name, so a run of only real models never happens unless a test
    // arranges one.
    ctx.register(internal.delegations.callScoutModel, {
      _handler: (_inner: unknown, args: { prompt: string }) => ({
        ...fakeScoutModel(args.prompt),
        model: "gpt-5.6-sol",
      }),
    });

    const report = await runReport(ctx);
    const asymmetry = report.asymmetry.join(" ");

    expect(report.ranker).toBe("gpt-5.6-sol");
    expect(report.aggregate.scout.system).toBe("scout (gpt-5.6-sol)");
    expect(asymmetry).toMatch(
      /The scout side was ranked by gpt-5\.6-sol, through the same prompt, seam, and citation gate the product uses/,
    );
    expect(asymmetry).not.toMatch(/offline fixture/);
    expect(asymmetry).not.toMatch(/part by/);
  });

  it("keeps the §10.2 warning on a run only half of which was the fixture", async () => {
    const ctx = registeredEval();
    const seed = await seedSettledQuestion(ctx);
    await seedReply(ctx, seed);
    await seedExtraQuestion(
      ctx,
      seed,
      SETTLED_AT - 1,
      "Which cohort's plates were logged in the second notebook?",
    );
    // One real model, one fixture, in the order the report scores them. A run
    // like this is what a half-migrated deployment produces, and it is exactly
    // the run whose warning an equality test on the joined name would drop.
    let call = 0;
    ctx.register(internal.delegations.callScoutModel, {
      _handler: (_inner: unknown, args: { prompt: string }) => {
        call += 1;
        const answer = fakeScoutModel(args.prompt);
        return call === 1 ? { ...answer, model: "gpt-5.6-sol" } : answer;
      },
    });

    const report = await runReport(ctx);

    expect(report.ranker).toBe("gpt-5.6-sol, stub.scout.v0");
    const asymmetry = report.asymmetry.join(" ");
    expect(asymmetry).toMatch(/Part of this run was ranked by the offline fixture/);
    expect(asymmetry).toMatch(/and part by gpt-5\.6-sol/);
    // The warning is the point. A mixed run is not the launch gate either.
    expect(asymmetry).toMatch(/not the gate the design's §10\.2 is asking for/);
    expect(report.aggregate.scout.system).toBe(
      "scout (gpt-5.6-sol, stub.scout.v0)",
    );
  });
});

describe("retrieve", () => {
  it("refuses a question that has been reopened under it", async () => {
    const ctx = new FakeCtx();
    const seed = await seedSettledQuestion(ctx);
    await seedReply(ctx, seed);
    await ctx.db.patch(seed.actionId, { settledAt: undefined });
    expect(
      await handlerOf(retrieve)(ctx, { actionId: seed.actionId } as never),
    ).toBeNull();
  });

  it("reports the caps and the drops even when no label survived", async () => {
    const ctx = new FakeCtx();
    const seed = await seedSettledQuestion(ctx);
    const reply = await seedReply(ctx, seed);
    await ctx.db.patch(reply, { visibility: "private" });

    const got = (await handlerOf(retrieve)(ctx, {
      actionId: seed.actionId,
    } as never)) as {
      labels: unknown[];
      labelsDropped: number;
      truncated: string[];
    } | null;

    // Not scoreable, but not silent: `null` here would throw away the drop
    // count and any read cap this re-derivation hit.
    expect(got).not.toBeNull();
    expect(got!.labels).toHaveLength(0);
    expect(got!.labelsDropped).toBe(1);
  });

  it("drops the note the question came out of from both sides", async () => {
    const ctx = new FakeCtx();
    const seed = await seedSettledQuestion(ctx);
    await seedReply(ctx, seed);
    for (let i = 0; i < 8; i++) {
      await seedAnnotation(ctx, { ...seed, memberId: seed.member }, {
        body: `Note ${i} on the incubation step.`,
      });
    }

    const got = (await handlerOf(retrieve)(ctx, {
      actionId: seed.actionId,
    } as never)) as {
      candidates: { _id: Id<"annotations"> }[];
      baselineRanked: Id<"annotations">[];
    };

    // The seed is `questionId`, and the report claims neither side is
    // penalised for it. That is only true if neither side spends a slot on it.
    expect(got.candidates.map((row) => row._id)).not.toContain(seed.questionId);
    expect(got.baselineRanked).not.toContain(seed.questionId);
    expect(got.baselineRanked).toHaveLength(6);
  });

  it("takes the lab and the question off the row, not off an argument", async () => {
    const ctx = new FakeCtx();
    const seed = await seedSettledQuestion(ctx);
    await seedReply(ctx, seed);
    const got = (await handlerOf(retrieve)(ctx, {
      actionId: seed.actionId,
    } as never)) as { labId: Id<"labs">; question: string };
    expect(got.labId).toBe(seed.labId);
    expect(got.question).toContain("reproducibility gap");
  });
});
