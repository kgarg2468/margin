import { ConvexError } from "convex/values";
import { describe, expect, it, vi } from "vitest";
import type { Id } from "./_generated/dataModel";
import { setSettled } from "./actions";
import { FakeCtx, handlerOf, rowAt, seedLab } from "./delegations.fixtures";

vi.mock("@convex-dev/auth/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@convex-dev/auth/server")>()),
  getAuthUserId: async (ctx: unknown) =>
    (ctx as { auth?: { userId?: string } }).auth?.userId ?? null,
}));

/**
 * Settling a question with a machine's report in front of you.
 *
 * The claim being stored is provenance — "this is what informed it" — and
 * provenance nobody checked is decoration. So the id is validated against the
 * question it names, not merely against the lab: a report about somebody
 * else's question is not evidence about this one, whoever pasted the id.
 */
async function seedFinding(
  ctx: FakeCtx,
  seed: Awaited<ReturnType<typeof seedLab>>,
  actionId: Id<"actions">,
): Promise<Id<"findings">> {
  const delegationId = await ctx.db.insert("delegations", {
    labId: seed.labId,
    agentKind: "scout.corpus",
    trigger: "manual",
    actionId,
    requestedBy: seed.pi,
    requestedAt: 1,
    status: "returned",
  });
  return await ctx.db.insert("findings", {
    labId: seed.labId,
    delegationId,
    agentKind: "scout.corpus",
    actionId,
    items: [
      {
        text: "Two members read the 4°C step the same way.",
        citedAnnotationIds: [seed.questionId],
        citedPaperIds: [seed.paperId],
      },
    ],
    coverage: { annotationsSearched: 4, papersTouched: 1, queriesRun: 1 },
    droppedForCitation: 0,
    model: "test",
    generatedAt: 1,
  });
}

describe("settling with a finding", () => {
  it("records which report informed it", async () => {
    const ctx = new FakeCtx();
    const seed = await seedLab(ctx);
    const findingId = await seedFinding(ctx, seed, seed.actionId);
    ctx.auth = { userId: seed.pi };

    await handlerOf(setSettled)(ctx, {
      actionId: seed.actionId,
      settled: true,
      findingId,
    } as never);

    const action = await ctx.db.get(seed.actionId);
    expect(action?.settledWithFindingId).toBe(findingId);
    const event = rowAt(
      (await ctx.db.query("events").collect()).filter(
        (row) => row.type === "action.settled",
      ),
    );
    expect(event.findingId).toBe(findingId);
  });

  it("settles without one, exactly as it always did", async () => {
    const ctx = new FakeCtx();
    const seed = await seedLab(ctx);
    ctx.auth = { userId: seed.pi };

    await handlerOf(setSettled)(ctx, {
      actionId: seed.actionId,
      settled: true,
    } as never);

    const action = await ctx.db.get(seed.actionId);
    expect(action?.settledAt).toBeGreaterThan(0);
    expect(action?.settledWithFindingId).toBeUndefined();
  });

  it("refuses a finding about a different question", async () => {
    const ctx = new FakeCtx();
    const seed = await seedLab(ctx);
    const other = await ctx.db.insert("actions", {
      labId: seed.labId,
      sessionId: seed.sessionId,
      paperId: seed.paperId,
      kind: "question",
      body: "Something else entirely?",
      recordedBy: seed.pi,
    });
    const findingId = await seedFinding(ctx, seed, other);
    ctx.auth = { userId: seed.pi };

    await expect(
      handlerOf(setSettled)(ctx, {
        actionId: seed.actionId,
        settled: true,
        findingId,
      } as never),
    ).rejects.toThrow(ConvexError);
    expect((await ctx.db.get(seed.actionId))?.settledAt).toBeUndefined();
  });

  it("lets go of the provenance when the question is reopened", async () => {
    const ctx = new FakeCtx();
    const seed = await seedLab(ctx);
    const findingId = await seedFinding(ctx, seed, seed.actionId);
    ctx.auth = { userId: seed.pi };

    await handlerOf(setSettled)(ctx, {
      actionId: seed.actionId,
      settled: true,
      findingId,
    } as never);
    await handlerOf(setSettled)(ctx, {
      actionId: seed.actionId,
      settled: false,
    } as never);

    const action = await ctx.db.get(seed.actionId);
    // The answer did not hold, so what informed it is not a fact about the row
    // any more. The ledger still has both events, which is where a walk
    // between states belongs.
    expect(action?.settledWithFindingId).toBeUndefined();
  });
});
