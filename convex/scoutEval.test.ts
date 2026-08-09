import { describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  FakeCtx,
  handlerOf,
  seedAnnotation,
  seedLab,
} from "./delegations.fixtures";
import type { ScoutEvalReport } from "../lib/eval/scout-eval";
import { baselineTopSix, questions, retrieve, run } from "./scoutEval";
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
    return new FakeCtx()
      .register(internal.scoutEval.questions, questions)
      .register(internal.scoutEval.retrieve, retrieve);
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
    expect(report.asymmetry.join(" ")).toMatch(/stub ranker/);
    expect(report.groundTruth.caveats.join(" ")).toMatch(/proxies/);
  });

  it("says nothing rather than something when the corpus has no settled questions", async () => {
    const ctx = registered();
    await seedLab(ctx);
    const report = await runReport(ctx);
    expect(report.population.questionsSettled).toBe(0);
    expect(report.verdict).toMatch(/statement about the data/);
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

describe("retrieve", () => {
  it("refuses a question that has been reopened under it", async () => {
    const ctx = new FakeCtx();
    const seed = await seedSettledQuestion(ctx);
    await ctx.db.patch(seed.actionId, { settledAt: undefined });
    expect(
      await handlerOf(retrieve)(ctx, { actionId: seed.actionId } as never),
    ).toBeNull();
  });

  it("takes the lab and the question off the row, not off an argument", async () => {
    const ctx = new FakeCtx();
    const seed = await seedSettledQuestion(ctx);
    const got = (await handlerOf(retrieve)(ctx, {
      actionId: seed.actionId,
    } as never)) as { labId: Id<"labs">; question: string };
    expect(got.labId).toBe(seed.labId);
    expect(got.question).toContain("reproducibility gap");
  });
});
