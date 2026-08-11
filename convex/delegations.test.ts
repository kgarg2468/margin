import { ConvexError } from "convex/values";
import { describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import * as actions from "./actions";
import {
  DAILY_RUN_BUDGET,
  DELEGATION_LEASE_MS,
  FAILURE_SENTENCES,
  MAX_ACTIVE_PER_LAB,
  MAX_BATCH_CANDIDATES,
  MAX_BATCH_QUESTIONS,
  MAX_CANDIDATES,
  MAX_COLLISION_LINES,
  MAX_COLLISION_LINE_CHARS,
  MAX_SEARCH_LENGTH,
  actionSubjectIsOpen,
  annotationSubjectIsOpen,
  buildBatchPrompt,
  cancel,
  capVerdict,
  cascadeForAnnotation,
  citationRowsFor,
  claim,
  enqueueForBrief,
  expireStale,
  fail,
  gather,
  holdsLease,
  leaseExpired,
  listForSubject,
  parseScoutJson,
  readModelPayload,
  reduceToSearchQuery,
  request,
  runForBrief,
  store,
  storeEmpty,
  subjectOf,
  type DelegationModelFailure,
} from "./delegations";
import {
  FakeCtx,
  handlerOf,
  registerFakeScoutModel,
  rowAt,
  seedAnnotation,
  seedLab,
} from "./delegations.fixtures";
import * as findings from "./findings";

vi.mock("@convex-dev/auth/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@convex-dev/auth/server")>()),
  getAuthUserId: async (ctx: unknown) =>
    (ctx as { auth?: { userId?: string } }).auth?.userId ?? null,
}));

/**
 * The scout's lifecycle, exercised.
 *
 * `delegations.privacy.test.ts` is the half of this suite whose failure would
 * be a product-promise failure. This is the other half: the transitions. A
 * claim that can happen twice is a lab billed twice; a lease that never
 * expires is a slot the lab never gets back; a settled question that keeps
 * being scouted is the subject fence not holding. None of that is visible
 * from a pure function, so these tests drive the real registered handlers
 * against the in-memory context in `delegations.fixtures.ts`.
 */

type Seed = Awaited<ReturnType<typeof seedLab>>;

async function seeded(options: { modelFailure?: DelegationModelFailure } = {}) {
  const ctx = new FakeCtx();
  const seed = await seedLab(ctx);
  ctx
    .register(internal.delegations.claim, claim)
    .register(internal.delegations.gather, gather)
    .register(internal.delegations.store, store)
    .register(internal.delegations.storeEmpty, storeEmpty)
    .register(internal.delegations.fail, fail);
  const calls = registerFakeScoutModel(ctx, options);
  return { ctx, seed, calls };
}

/** A lab-visible note the stub scout will find and cite. */
async function corpus(ctx: FakeCtx, seed: Seed) {
  return await seedAnnotation(
    ctx,
    { ...seed, memberId: seed.pi },
    { body: "The 4°C incubation step is where the two cohorts diverge." },
  );
}

/** A queued delegation on v1's subject: the open-question annotation. */
async function queue(
  ctx: FakeCtx,
  seed: Seed,
  over: Record<string, unknown> = {},
): Promise<Id<"delegations">> {
  return await ctx.db.insert("delegations", {
    labId: seed.labId,
    agentKind: "scout.corpus",
    trigger: "manual",
    annotationId: seed.questionId,
    requestedBy: seed.pi,
    requestedAt: Date.now(),
    status: "queued",
    ...over,
  });
}

const run = (ctx: FakeCtx, delegationId: Id<"delegations">) =>
  handlerOf(runForBrief)(ctx, { delegationIds: [delegationId] } as never);

/** A brief row carrying the collisions section, for a run to read back. */
async function brief(
  ctx: FakeCtx,
  seed: Seed,
  section: { items: { text: string; annotationIds: Id<"annotations">[] }[] },
): Promise<Id<"briefs">> {
  return await ctx.db.insert("briefs", {
    sessionId: seed.sessionId,
    labId: seed.labId,
    paperId: seed.paperId,
    generation: 1,
    generatedAt: 1,
    generatedBy: seed.pi,
    trigger: "scheduled",
    sections: [
      {
        key: "collisions",
        heading: "Where the lab collided",
        droppedCount: 0,
        items: section.items,
      },
    ],
  });
}

/* -------------------------------------------------------------------------
 * Query reduction
 * ---------------------------------------------------------------------- */

describe("reduceToSearchQuery", () => {
  it("drops stopwords and keeps the terms in the order they were written", () => {
    expect(
      reduceToSearchQuery(
        "Does the 4°C incubation step explain the gap between the two cohorts?",
      ),
    ).toBe("4°c incubation step explain gap between two cohorts");
  });

  it("keeps the end of a long question, which is where the noun usually is", () => {
    // A slice would throw away exactly the part a scientist writes last. The
    // reduction removes noise first and only then drops whole terms.
    const question = `${"redundant preamble ".repeat(20)}mitochondrial`;
    const reduced = reduceToSearchQuery(question);
    expect(reduced.length).toBeLessThanOrEqual(MAX_SEARCH_LENGTH);
    expect(reduced).toContain("mitochondrial");
  });

  it("never cuts a word in half", () => {
    const reduced = reduceToSearchQuery(
      Array.from({ length: 60 }, (_, i) => `term${i}`).join(" "),
    );
    expect(reduced.length).toBeLessThanOrEqual(MAX_SEARCH_LENGTH);
    expect(reduced.split(" ").every((term) => /^term\d+$/.test(term))).toBe(
      true,
    );
  });

  it("returns nothing for a question that is all stopwords", () => {
    expect(reduceToSearchQuery("is it? and so on")).toBe("");
  });
});

/* -------------------------------------------------------------------------
 * The lease
 * ---------------------------------------------------------------------- */

describe("the lease", () => {
  it("is a token as well as a clock", () => {
    const now = 1_000_000;
    const row = { lease: "mine", leaseAcquiredAt: now };
    expect(holdsLease(row, "mine", now + 1000)).toBe(true);
    // A run that overran and came back to find someone else holding the row.
    expect(holdsLease(row, "theirs", now + 1000)).toBe(false);
    // And one still holding its own token, three minutes late.
    expect(holdsLease(row, "mine", now + DELEGATION_LEASE_MS)).toBe(false);
  });

  it("treats a row that never acquired one as expired", () => {
    expect(
      leaseExpired({ lease: undefined, leaseAcquiredAt: undefined }, 1),
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------
 * Caps
 * ---------------------------------------------------------------------- */

describe("caps", () => {
  it("bounds concurrency", () => {
    expect(capVerdict({ active: MAX_ACTIVE_PER_LAB, labDay: 0 }).ok).toBe(false);
    expect(capVerdict({ active: MAX_ACTIVE_PER_LAB - 1, labDay: 0 }).ok).toBe(
      true,
    );
  });

  it("bounds the day as well as the moment", () => {
    // Concurrency says what is in flight and nothing about what a week costs.
    expect(capVerdict({ active: 0, labDay: DAILY_RUN_BUDGET }).ok).toBe(false);
  });

  it("refuses in sentences, because every refusal is shown to somebody", () => {
    const verdict = capVerdict({ active: MAX_ACTIVE_PER_LAB, labDay: 0 });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.refusal).toMatch(/scout/i);
  });

  it("does not let a crashed run keep a slot forever", async () => {
    // Status alone is not occupancy. A run whose process died never wrote a
    // terminal status, so counting `running` rows would let eight crashes
    // take the scout away from a lab permanently — no message, nothing to
    // press, and no cron in this codebase to come and fix it.
    const { ctx, seed } = await seeded();
    for (let i = 0; i < MAX_ACTIVE_PER_LAB; i += 1) {
      await queue(ctx, seed, {
        annotationId: undefined,
        actionId: seed.actionId,
        status: "running",
        lease: `dead-${i}`,
        leaseAcquiredAt: Date.now() - DELEGATION_LEASE_MS - 1,
      });
    }

    ctx.auth = { userId: seed.pi };
    await handlerOf(request)(ctx, {
      subject: { kind: "annotation", annotationId: seed.questionId },
    } as never);

    // The new run exists, and the dead ones were closed rather than ignored:
    // an abandoned row that stays `running` is a lie the audit trail tells.
    const rows = ctx.db.all("delegations");
    expect(rows.filter((row) => row.status === "queued")).toHaveLength(1);
    expect(rows.filter((row) => row.status === "failed")).toHaveLength(
      MAX_ACTIVE_PER_LAB,
    );
    expect(rows.filter((row) => row.failure === "lease-expired")).toHaveLength(
      MAX_ACTIVE_PER_LAB,
    );
  });

  it("does not let a run that never started keep a slot either", async () => {
    // `runForBrief` is a scheduled action, and Convex runs those at most
    // once. A failure before `claim` leaves a row at `queued` that nothing
    // will ever pick up — and a lab whose scout quietly stops working, with
    // eight rows sitting queued and no error anywhere, has no way to even
    // describe what went wrong.
    const { ctx, seed } = await seeded();
    const stranded: Id<"delegations">[] = [];
    for (let i = 0; i < MAX_ACTIVE_PER_LAB; i += 1) {
      stranded.push(
        await queue(ctx, seed, {
          annotationId: undefined,
          actionId: seed.actionId,
          requestedAt: Date.now() - DELEGATION_LEASE_MS - 1,
        }),
      );
    }

    ctx.auth = { userId: seed.pi };
    const fresh = await handlerOf(request)(ctx, {
      subject: { kind: "annotation", annotationId: seed.questionId },
    } as never);

    expect(fresh).toBeDefined();
    for (const delegationId of stranded) {
      const row = await ctx.db.get(delegationId);
      expect(row?.status).toBe("failed");
      // Told apart from a scout that started and did not come back, because
      // the two are different faults and read differently to whoever asks
      // why the question went unanswered.
      expect(row?.failure).toBe("never-started");
      expect(row?.failureReason).toMatch(/never picked up/);
    }
    expect(
      ctx.db.all("events").filter((e) => e.type === "delegation.failed"),
    ).toHaveLength(MAX_ACTIVE_PER_LAB);
  });

  it("leaves a queued run that is merely young alone", async () => {
    const { ctx, seed } = await seeded();
    const fresh = await queue(ctx, seed, {
      annotationId: undefined,
      actionId: seed.actionId,
    });
    expect(
      await handlerOf(expireStale)(ctx, { labId: seed.labId } as never),
    ).toBe(0);
    expect((await ctx.db.get(fresh))?.status).toBe("queued");
  });

  it("still refuses when the slots are held by runs that are alive", async () => {
    const { ctx, seed } = await seeded();
    for (let i = 0; i < MAX_ACTIVE_PER_LAB; i += 1) {
      await queue(ctx, seed, {
        annotationId: undefined,
        actionId: seed.actionId,
        status: "running",
        lease: `alive-${i}`,
        leaseAcquiredAt: Date.now(),
      });
    }
    ctx.auth = { userId: seed.pi };
    await expect(
      handlerOf(request)(ctx, {
        subject: { kind: "annotation", annotationId: seed.questionId },
      } as never),
    ).rejects.toThrow(ConvexError);
  });

  it("reads the day through the time index, not the status one", async () => {
    // Rows are never deleted. Counting the day's spend through
    // `by_lab_and_status` would be a walk over every run the lab has ever
    // made, getting slower every week — a cost bound that costs more the
    // longer you have it.
    const { ctx, seed } = await seeded();
    ctx.auth = { userId: seed.pi };
    await handlerOf(request)(ctx, {
      subject: { kind: "annotation", annotationId: seed.questionId },
    } as never);
    expect(ctx.db.lastReadOf("by_lab_and_time")?.table).toBe("delegations");
  });
});

/* -------------------------------------------------------------------------
 * The subject fence
 * ---------------------------------------------------------------------- */

describe("the subject fence", () => {
  const labId = "labs_1" as Id<"labs">;

  const note = (over: Record<string, unknown>) =>
    ({
      labId,
      visibility: "lab",
      type: "open-question",
      deletedAt: undefined,
      parentId: undefined,
      ...over,
    }) as never;

  it("admits a shared, top-level open question and nothing else", () => {
    expect(annotationSubjectIsOpen(note({}), labId)).toBe(true);
    // The one that matters most: a question its author took back.
    expect(annotationSubjectIsOpen(note({ visibility: "private" }), labId)).toBe(
      false,
    );
    expect(annotationSubjectIsOpen(note({ deletedAt: 5 }), labId)).toBe(false);
    expect(annotationSubjectIsOpen(note({ type: "critique" }), labId)).toBe(
      false,
    );
    expect(
      annotationSubjectIsOpen(note({ parentId: "annotations_9" }), labId),
    ).toBe(false);
    expect(annotationSubjectIsOpen(null, labId)).toBe(false);
  });

  it("admits an open outcome question and nothing else", () => {
    const outcome = (over: Record<string, unknown>) =>
      ({ labId, kind: "question", settledAt: undefined, ...over }) as never;
    expect(actionSubjectIsOpen(outcome({}), labId)).toBe(true);
    expect(actionSubjectIsOpen(outcome({ settledAt: 1 }), labId)).toBe(false);
    expect(actionSubjectIsOpen(outcome({ kind: "decision" }), labId)).toBe(
      false,
    );
    expect(actionSubjectIsOpen(outcome({ kind: "task" }), labId)).toBe(false);
    expect(actionSubjectIsOpen(null, labId)).toBe(false);
  });

  it("reads the annotation subject first, since v1 sets both never at once", () => {
    expect(
      subjectOf({
        annotationId: "annotations_1" as Id<"annotations">,
        actionId: undefined,
      }),
    ).toEqual({ kind: "annotation", annotationId: "annotations_1" });
    expect(
      subjectOf({ annotationId: undefined, actionId: "actions_1" as Id<"actions"> }),
    ).toEqual({ kind: "action", actionId: "actions_1" });
    expect(subjectOf({ annotationId: undefined, actionId: undefined })).toBeNull();
  });
});

/* -------------------------------------------------------------------------
 * Claiming
 * ---------------------------------------------------------------------- */

describe("claim", () => {
  it("moves a queued row to running and stamps a fresh lease", async () => {
    const { ctx, seed } = await seeded();
    const delegationId = await queue(ctx, seed);

    const claimed = (await handlerOf(claim)(ctx, {
      delegationId,
    } as never)) as { lease: string; question: string } | null;

    expect(claimed).not.toBeNull();
    const row = rowAt(ctx.db.all("delegations"));
    expect(row.status).toBe("running");
    expect(row.lease).toBe(claimed?.lease);
    expect(row.leaseAcquiredAt).toBeTypeOf("number");
    // The question the scout works on is the note's own words.
    expect(claimed?.question).toContain("4°C");
  });

  it("refuses a second claim while the first lease is alive", async () => {
    const { ctx, seed } = await seeded();
    const delegationId = await queue(ctx, seed);
    await handlerOf(claim)(ctx, { delegationId } as never);

    // A scheduled action can be retried after a crash the first run never
    // saw. The state machine is what stops the retry paying for a second
    // model call.
    expect(await handlerOf(claim)(ctx, { delegationId } as never)).toBeNull();
    expect(rowAt(ctx.db.all("delegations")).status).toBe("running");
  });

  it("reclaims the slot rather than re-running when the lease has expired", async () => {
    const { ctx, seed } = await seeded();
    const delegationId = await queue(ctx, seed, {
      status: "running",
      lease: "dead",
      leaseAcquiredAt: Date.now() - DELEGATION_LEASE_MS - 1,
    });

    expect(await handlerOf(claim)(ctx, { delegationId } as never)).toBeNull();
    const row = rowAt(ctx.db.all("delegations"));
    expect(row.status).toBe("failed");
    expect(row.failure).toBe("lease-expired");
    expect(row.lease).toBeUndefined();
    expect(row.failureReason).toMatch(/ran out of time/);
  });

  it("cancels rather than claiming when the question was settled in between", async () => {
    const { ctx, seed } = await seeded();
    const delegationId = await queue(ctx, seed, {
      annotationId: undefined,
      actionId: seed.actionId,
    });
    await ctx.db.patch(seed.actionId as string, { settledAt: Date.now() });

    expect(await handlerOf(claim)(ctx, { delegationId } as never)).toBeNull();
    expect(rowAt(ctx.db.all("delegations")).status).toBe("cancelled");
  });

  it("does nothing to a terminal row", async () => {
    const { ctx, seed } = await seeded();
    const delegationId = await queue(ctx, seed, { status: "cancelled" });
    expect(await handlerOf(claim)(ctx, { delegationId } as never)).toBeNull();
    expect(rowAt(ctx.db.all("delegations")).status).toBe("cancelled");
  });
});

/* -------------------------------------------------------------------------
 * The stub run, end to end
 * ---------------------------------------------------------------------- */

describe("a run, start to finish", () => {
  it("returns a cited finding, its join rows, and one ledger event", async () => {
    const { ctx, seed } = await seeded();
    const noteId = await corpus(ctx, seed);

    await run(ctx, await queue(ctx, seed));

    const row = rowAt(ctx.db.all("delegations"));
    expect(row.status).toBe("returned");
    expect(row.findingId).toBeDefined();
    // The lease goes back the moment the run is finished with it.
    expect(row.lease).toBeUndefined();

    const finding = rowAt(ctx.db.all("findings"));
    expect(rowAt(finding.items).citedAnnotationIds).toEqual([noteId]);
    expect(rowAt(finding.items).citedPaperIds).toEqual([seed.paperId]);
    expect(finding.coverage.annotationsSearched).toBe(1);
    expect(finding.annotationId).toBe(seed.questionId);

    expect(ctx.db.all("findingCitations")).toHaveLength(1);
    expect(
      ctx.db.all("events").filter((e) => e.type === "delegation.returned"),
    ).toHaveLength(1);
  });

  it("calls the corpus empty rather than failed when nothing matched", async () => {
    const { ctx, seed } = await seeded();

    await run(ctx, await queue(ctx, seed));

    // The honest null. "The lab has not written about this" is an answer.
    expect(rowAt(ctx.db.all("delegations")).status).toBe("empty");
    expect(ctx.db.all("findings")).toEqual([]);
    expect(
      ctx.db.all("events").some((e) => e.type === "delegation.empty"),
    ).toBe(true);
  });

  it("says cancelled, not empty, when the question went away mid-run", async () => {
    const { ctx, seed } = await seeded();
    const delegationId = await queue(ctx, seed);
    const claimed = (await handlerOf(claim)(ctx, { delegationId } as never)) as {
      lease: string;
    };
    await ctx.db.patch(seed.questionId as string, { visibility: "private" });

    await handlerOf(storeEmpty)(ctx, {
      delegationId,
      lease: claimed.lease,
    } as never);

    // "The lab has not written about this" is a claim about the corpus. It
    // must not be the sentence left behind by a run whose question nobody
    // can find any more — an audit trail that is subtly wrong about why a
    // run stopped is worse than none, because it will be believed.
    const row = rowAt(ctx.db.all("delegations"));
    expect(row.status).toBe("cancelled");
    expect(row.cancellation).toBe("subject-withdrawn");
  });

  it("still knows where a run belongs after its subject is deleted", async () => {
    const { ctx, seed } = await seeded();
    ctx.auth = { userId: seed.pi };
    const delegationId = (await handlerOf(request)(ctx, {
      subject: { kind: "annotation", annotationId: seed.questionId },
    } as never)) as Id<"delegations">;

    // `annotations.remove` hard-deletes. Reading placement off the subject
    // would land nothing on the timeline at exactly the moment placement
    // matters — the runs that fall off would be the runs that ended badly.
    await ctx.db.delete(seed.questionId as string);
    expect(await ctx.db.get(seed.questionId)).toBeNull();
    await ctx.db.patch(delegationId as string, {
      requestedAt: Date.now() - DELEGATION_LEASE_MS - 1,
    });
    await handlerOf(expireStale)(ctx, { labId: seed.labId } as never);

    const failed = ctx.db
      .all("events")
      .find((e) => e.type === "delegation.failed");
    expect(failed?.paperId).toBe(seed.paperId);
    expect(failed?.sessionId).toBe(seed.sessionId);
  });

  it("puts a failed run on the same timelines as a successful one", async () => {
    const { ctx, seed } = await seeded();
    await run(ctx, await queue(ctx, seed));
    const empty = ctx.db
      .all("events")
      .find((e) => e.type === "delegation.empty");
    // Otherwise a lab's paper timeline shows the runs that worked and none of
    // the runs that did not, which is the one shape of record that flatters
    // the feature.
    expect(empty?.paperId).toBe(seed.paperId);
    expect(empty?.sessionId).toBe(seed.sessionId);

    const { ctx: other, seed: seed2 } = await seeded();
    await queue(other, seed2, {
      status: "running",
      lease: "dead",
      leaseAcquiredAt: Date.now() - DELEGATION_LEASE_MS - 1,
    });
    await handlerOf(expireStale)(other, { labId: seed2.labId } as never);
    const failed = other.db
      .all("events")
      .find((e) => e.type === "delegation.failed");
    expect(failed?.paperId).toBe(seed2.paperId);
  });

  it("is a no-op on retry, and writes exactly one finding", async () => {
    const { ctx, seed } = await seeded();
    await corpus(ctx, seed);
    const delegationId = await queue(ctx, seed);

    await run(ctx, delegationId);
    await run(ctx, delegationId);

    expect(ctx.db.all("findings")).toHaveLength(1);
    expect(rowAt(ctx.db.all("delegations")).status).toBe("returned");
  });

  it("supersedes the previous finding when a second run returns", async () => {
    const { ctx, seed } = await seeded();
    await corpus(ctx, seed);

    await run(ctx, await queue(ctx, seed));
    await run(ctx, await queue(ctx, seed));

    const stored = ctx.db.all("findings");
    expect(stored).toHaveLength(2);
    // A thread renders the newest non-superseded one; the older stays
    // reachable from the delegation history rather than being deleted.
    expect(stored.filter((f) => f.supersededAt === undefined)).toHaveLength(1);
    expect(rowAt(stored).supersededAt).toBeTypeOf("number");
  });

  it("cancels a row whose subject has gone and keeps the rest of the batch", async () => {
    const { ctx, seed } = await seeded();
    await corpus(ctx, seed);
    const good = await queue(ctx, seed);
    // A row whose subject has gone: it cancels itself and the batch carries on.
    const orphan = await queue(ctx, seed, {
      annotationId: "annotations_404" as Id<"annotations">,
    });

    await handlerOf(runForBrief)(ctx, {
      delegationIds: [orphan, good],
    } as never);

    expect((await ctx.db.get(orphan))?.status).toBe("cancelled");
    expect((await ctx.db.get(good))?.status).toBe("returned");
  });
});

/* -------------------------------------------------------------------------
 * One call for the whole brief
 * ---------------------------------------------------------------------- */

/** The material the prompt actually carries, read back the way a model would. */
function materialOf(prompt: string): {
  questions: {
    ref: string;
    question: string;
    labels: string[];
    collisions: { text: string; labels: string[] }[];
  }[];
  annotations: { label: string; body: string }[];
} {
  const marker = "MATERIAL (JSON):\n";
  return JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length)) as {
    questions: {
      ref: string;
      question: string;
      labels: string[];
      collisions: { text: string; labels: string[] }[];
    }[];
    annotations: { label: string; body: string }[];
  };
}

describe("a brief's questions, in one call", () => {
  it("asks the model once for the whole batch and stores a finding each", async () => {
    const { ctx, seed, calls } = await seeded();
    await corpus(ctx, seed);
    const second = await seedAnnotation(
      ctx,
      { ...seed, memberId: seed.member },
      { type: "open-question", body: "Which cohort ran the second replicate?" },
    );
    const first = await queue(ctx, seed);
    const other = await queue(ctx, seed, { annotationId: second });

    await handlerOf(runForBrief)(ctx, {
      delegationIds: [first, other],
    } as never);

    // The cost bound the design asks for: one brief, one call.
    expect(calls).toHaveLength(1);
    expect(ctx.db.all("findings")).toHaveLength(2);
    for (const row of ctx.db.all("delegations")) {
      expect(row.status).toBe("returned");
    }
  });

  it("labels one note once, however many questions retrieved it", async () => {
    const { ctx, seed, calls } = await seeded();
    const noteId = await corpus(ctx, seed);
    const second = await seedAnnotation(
      ctx,
      { ...seed, memberId: seed.member },
      { type: "open-question", body: "Does the 4°C incubation step matter?" },
    );
    await handlerOf(runForBrief)(ctx, {
      delegationIds: [
        await queue(ctx, seed),
        await queue(ctx, seed, { annotationId: second }),
      ],
    } as never);

    // Two labels for one note would be two names for one thing in a prompt
    // that has to be unambiguous — and two rows in the join table.
    const payload = materialOf(rowAt(calls).prompt);
    const body = (await ctx.db.get(noteId))?.body;
    const labels = payload.annotations
      .filter((one) => one.body === body)
      .map((one) => one.label);
    expect(labels).toHaveLength(1);
    // The label space is batch-global, so the one name is a name both
    // questions may use — that is what makes sharing the layout safe.
    for (const question of payload.questions) {
      expect(question.labels).toContain(rowAt(labels));
    }
    expect(new Set(payload.annotations.map((one) => one.label)).size).toBe(
      payload.annotations.length,
    );

    const stored = ctx.db.all("findings");
    expect(stored).toHaveLength(2);
    for (const finding of stored) {
      expect(finding.items.flatMap((item) => item.citedAnnotationIds)).toContain(
        noteId,
      );
      expect(
        ctx.db
          .all("findingCitations")
          .filter(
            (row) =>
              row.findingId === finding._id && row.annotationId === noteId,
          ),
      ).toHaveLength(1);
    }
  });

  it("fails every claimed row when the one call fails, and only those", async () => {
    const { ctx, seed } = await seeded({ modelFailure: "model-timeout" });
    await corpus(ctx, seed);
    const withCorpus = await queue(ctx, seed);
    // A row whose subject has gone never reaches the call and is cancelled.
    const orphan = await queue(ctx, seed, {
      annotationId: "annotations_404" as Id<"annotations">,
    });

    await handlerOf(runForBrief)(ctx, {
      delegationIds: [withCorpus, orphan],
    } as never);

    expect((await ctx.db.get(withCorpus))?.failure).toBe("model-timeout");
    expect((await ctx.db.get(orphan))?.status).toBe("cancelled");
  });

  it("strands no claimed row when a gather throws mid-batch", async () => {
    // The per-row wrapper this batch replaced caught exactly this. Without a
    // catch here the action rejects while holding live leases on every row it
    // had already taken: they sit `running` with nothing coming back, holding
    // the lab's slots until the sweep notices, and the questions behind them
    // never start.
    const { ctx, seed, calls } = await seeded();
    await corpus(ctx, seed);
    const second = await seedAnnotation(
      ctx,
      { ...seed, memberId: seed.member },
      { type: "open-question", body: "Which cohort ran the second replicate?" },
    );
    const first = await queue(ctx, seed);
    const other = await queue(ctx, seed, { annotationId: second });

    // A read limit on a lab with a long history, a conflict, a transient
    // failure — the second row's gather does not come back.
    let reads = 0;
    const real = handlerOf(gather);
    ctx.register(internal.delegations.gather, {
      _handler: async (inner: unknown, args: unknown) => {
        reads += 1;
        if (reads === 2) throw new Error("too many reads in this query");
        return await real(inner, args as never);
      },
    });

    await handlerOf(runForBrief)(ctx, {
      delegationIds: [first, other],
    } as never);

    expect(calls).toEqual([]);
    for (const delegationId of [first, other]) {
      const row = await ctx.db.get(delegationId);
      expect(row?.status).toBe("failed");
      expect(row?.failure).toBe("run-error");
      // Failing is not stranding: the slot goes back either way.
      expect(row?.lease).toBeUndefined();
    }
  });

  it("still spends nothing on a batch that gathered nothing", async () => {
    const { ctx, seed, calls } = await seeded();
    await run(ctx, await queue(ctx, seed));
    // The refusal belongs before the money is spent: an empty corpus is an
    // answer, and `storeEmpty` is where it is recorded.
    expect(calls).toEqual([]);
    expect(rowAt(ctx.db.all("delegations")).status).toBe("empty");
  });
});

/* -------------------------------------------------------------------------
 * How big one prompt is allowed to get
 * ---------------------------------------------------------------------- */

describe("the batch's candidate cap", () => {
  const labId = "labs_1" as Id<"labs">;

  /** A question with `count` lab-visible notes of its own, in rank order. */
  const question = (index: number, count: number) => ({
    ref: `Q${index + 1}`,
    question: `Question ${index}`,
    candidates: Array.from({ length: count }, (_, rank) => ({
      _id: `annotations_${index}_${rank}` as Id<"annotations">,
      labId,
      paperId: "papers_1" as Id<"papers">,
      visibility: "lab" as const,
      type: "note",
      body: `note ${index}/${rank}`,
    })),
  });

  /** The largest batch the caps allow, each question at its own ceiling. */
  const fullBatch = () =>
    Array.from({ length: MAX_BATCH_QUESTIONS }, (_, index) =>
      question(index, MAX_CANDIDATES),
    );

  it("truncates a union past the cap and still gives every question its best", () => {
    // The batch the budgets are derived for: eight questions at the
    // per-question ceiling is 320 distinct notes, and a lab whose notes run
    // long would put a megabyte in one input.
    const questions = fullBatch();
    const gate = buildBatchPrompt(labId, questions);
    const payload = materialOf(gate.prompt);

    expect(payload.annotations).toHaveLength(MAX_BATCH_CANDIDATES);
    // Round-robin by rank: every question's best note is laid out before any
    // question's second, so a cap that bites takes the tail off all of them
    // rather than the whole of the last one.
    expect(
      payload.annotations
        .slice(0, MAX_BATCH_QUESTIONS)
        .map((one) => one.body),
    ).toEqual(questions.map((_, index) => `note ${index}/0`));
    for (const [index, one] of payload.questions.entries()) {
      expect(one.labels).toContain(`A${index + 1}`);
      // The ten the constant's comment promises, at the size it promises it
      // for — a guarantee derived at eight questions and tested at three is a
      // guarantee about a batch nobody runs.
      expect(one.labels.length).toBeGreaterThanOrEqual(
        Math.floor(MAX_BATCH_CANDIDATES / MAX_BATCH_QUESTIONS),
      );
    }
  });

  it("promises no question a label the prompt does not carry", () => {
    // The right to cite is derived from the layout, not from the gather. A
    // question told it may cite a note that fell off the end would be a
    // question whose every citation of it is dropped as invented — the item
    // lost and the reason invisible.
    const gate = buildBatchPrompt(labId, fullBatch());
    const payload = materialOf(gate.prompt);
    const laid = new Set(payload.annotations.map((one) => one.label));

    expect(gate.byLabel.size).toBe(payload.annotations.length);
    for (const one of payload.questions) {
      for (const label of one.labels) {
        expect(laid.has(label)).toBe(true);
        expect(gate.byLabel.has(label)).toBe(true);
      }
      expect([...(gate.allowed.get(one.ref) ?? [])]).toEqual(one.labels);
    }
  });

  it("counts a finding's coverage off what its question was shown", async () => {
    // The number the reader is given has to be one the code can stand behind.
    // Until the cap, "searched" and "shown" were the same set; a truncated
    // question's gather count is a claim about material the model never saw.
    const { ctx, seed, calls } = await seeded();
    const notes: Id<"annotations">[] = [];
    for (let index = 0; index < 3 * MAX_CANDIDATES; index += 1) {
      notes.push(
        await seedAnnotation(
          ctx,
          { ...seed, memberId: seed.pi },
          { type: "note", body: `Note ${index} on the incubation step` },
        ),
      );
    }
    const subjects = [seed.questionId];
    for (const which of ["second", "third"]) {
      subjects.push(
        await seedAnnotation(
          ctx,
          { ...seed, memberId: seed.member },
          {
            type: "open-question",
            body: `Which cohort ran the ${which} replicate?`,
          },
        ),
      );
    }
    const delegationIds = [];
    for (const annotationId of subjects) {
      delegationIds.push(await queue(ctx, seed, { annotationId }));
    }

    // Three full gathers, disjoint, so the union really is 120 — which the
    // in-memory search index cannot produce on its own, since every question
    // reads the same rows out of it.
    const rows = await Promise.all(notes.map((id) => ctx.db.get(id)));
    const slices = new Map(
      delegationIds.map((id, index) => [
        id,
        rows
          .slice(index * MAX_CANDIDATES, (index + 1) * MAX_CANDIDATES)
          .flatMap((row) => (row === null ? [] : [row])),
      ]),
    );
    ctx.register(internal.delegations.gather, {
      _handler: (_inner: unknown, args: { delegationId: Id<"delegations"> }) => ({
        question: "Does the 4°C incubation step matter?",
        candidates: slices.get(args.delegationId) ?? [],
        coverage: {
          annotationsSearched: MAX_CANDIDATES,
          papersTouched: 1,
          queriesRun: 1,
        },
      }),
    });

    await handlerOf(runForBrief)(ctx, { delegationIds } as never);

    const payload = materialOf(rowAt(calls).prompt);
    expect(payload.annotations).toHaveLength(MAX_BATCH_CANDIDATES);
    for (const [index, annotationId] of subjects.entries()) {
      const finding = ctx.db
        .all("findings")
        .find((row) => row.annotationId === annotationId);
      const shown = rowAt(payload.questions, index).labels.length;
      // Each question gathered forty and was shown a share of eighty.
      expect(shown).toBeLessThan(MAX_CANDIDATES);
      expect(finding?.coverage.annotationsSearched).toBe(shown);
    }
  });

  it("offers a collision line no label its own question may not cite", () => {
    // A line's notes are merged into its own question's gather, so normally
    // both ends are citable. Not when one of them falls off `MAX_CANDIDATES`
    // and a *neighbour* puts it in the layout anyway — the state this batch
    // stands in for by pointing the line at the other question's note. The
    // label exists, this question may not use it, and offering it would
    // promise a citation the gate drops as invented: the item lost and the
    // reason invisible.
    const mine = question(0, 2);
    const neighbour = question(1, 2);
    const ours = rowAt(mine.candidates)._id;
    const theirs = rowAt(neighbour.candidates)._id;
    const gate = buildBatchPrompt(labId, [
      {
        ...mine,
        collisionLines: [
          { text: "Two members, one passage.", annotationIds: [ours, theirs] },
        ],
      },
      neighbour,
    ]);

    const asked = rowAt(materialOf(gate.prompt).questions);
    const line = rowAt(asked.collisions);
    // The end this question gathered, named, and nothing else.
    expect(line.labels).toHaveLength(1);
    expect(gate.byLabel.get(rowAt(line.labels))?._id).toBe(ours);
    expect(asked.labels).toContain(rowAt(line.labels));

    // The neighbour's note is in the batch's vocabulary all the same. Being
    // labelled is what makes it worth withholding here.
    const theirLabel = [...gate.byLabel].find(
      ([, candidate]) => candidate._id === theirs,
    )?.[0];
    expect(theirLabel).toBeDefined();
    expect(line.labels).not.toContain(theirLabel);
  });

  it("counts the brief read in `queriesRun`, so coverage cannot overstate either", async () => {
    // `coverage` is the honest null's whole credibility: a reader who is told
    // nothing was found has to be able to see how hard the machine looked.
    // Two sources means two queries, and a hardcoded 1 would make the number
    // a decoration.
    const { ctx, seed } = await seeded();
    await corpus(ctx, seed);
    const briefId = await ctx.db.insert("briefs", {
      sessionId: seed.sessionId,
      labId: seed.labId,
      paperId: seed.paperId,
      generation: 1,
      generatedAt: 1,
      generatedBy: seed.pi,
      trigger: "scheduled",
      sections: [],
    });

    await run(ctx, await queue(ctx, seed, { briefId }));
    expect(rowAt(ctx.db.all("findings")).coverage.queriesRun).toBe(2);
  });

  it("carries no more of the brief's lines than the brief's own section holds", async () => {
    // `MAX_COLLISION_LINES` is a bound on what a *stored* row may spend a
    // prompt on. The assembler caps its own section at six, and this does not
    // take its word for it — a row is untrusted whatever wrote it.
    const { ctx, seed, calls } = await seeded();
    const note = await corpus(ctx, seed);
    await run(
      ctx,
      await queue(ctx, seed, {
        briefId: await brief(ctx, seed, {
          items: Array.from({ length: MAX_COLLISION_LINES + 3 }, (_, index) => ({
            text: `Two members, one passage (${index}).`,
            annotationIds: [note],
          })),
        }),
      }),
    );

    expect(
      rowAt(materialOf(rowAt(calls).prompt).questions).collisions,
    ).toHaveLength(MAX_COLLISION_LINES);
  });

  it("cuts a line that arrived longer than a line has any business being", async () => {
    const { ctx, seed, calls } = await seeded();
    const note = await corpus(ctx, seed);
    await run(
      ctx,
      await queue(ctx, seed, {
        briefId: await brief(ctx, seed, {
          items: [{ text: "x".repeat(2_000), annotationIds: [note] }],
        }),
      }),
    );

    const line = rowAt(rowAt(materialOf(rowAt(calls).prompt).questions).collisions);
    expect(line.text).toHaveLength(MAX_COLLISION_LINE_CHARS);
  });

  it("counts one query for a run with no brief behind it", async () => {
    // The on-demand path (v1.5) has no brief to read, and a run that claimed
    // two queries on the strength of a source it never had would be lying in
    // the one field the reader is asked to trust.
    const { ctx, seed } = await seeded();
    await corpus(ctx, seed);

    await run(ctx, await queue(ctx, seed));
    expect(rowAt(ctx.db.all("findings")).coverage.queriesRun).toBe(1);
  });

  it("leaves a union that fits alone, however many questions share it", () => {
    const questions = [0, 1].map((index) => question(index, 3));
    const payload = materialOf(buildBatchPrompt(labId, questions).prompt);
    expect(payload.annotations).toHaveLength(6);
    for (const one of payload.questions) expect(one.labels).toHaveLength(3);
  });
});

/* -------------------------------------------------------------------------
 * What a model can do to a run
 * ---------------------------------------------------------------------- */

describe("readModelPayload", () => {
  it("reads the text out of the output array, not out of output_text", () => {
    // A run that spends its whole budget reasoning comes back with an
    // `output` array and no message in it. The flat convenience property is
    // something the SDKs assemble, and there is no SDK here.
    expect(
      readModelPayload({
        status: "completed",
        output: [
          { type: "reasoning", content: [] },
          { type: "message", content: [{ type: "output_text", text: "{}" }] },
        ],
      }),
    ).toEqual({ ok: true, text: "{}" });
  });

  it("refuses a truncated answer rather than storing half of one", () => {
    expect(
      readModelPayload({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      }),
    ).toEqual({ ok: false, failure: "over-budget" });
  });

  it("calls a failed run and a refusal what they are", () => {
    expect(
      readModelPayload({ status: "failed", error: { message: "boom" } }),
    ).toEqual({ ok: false, failure: "model-unavailable" });
    expect(
      readModelPayload({
        status: "completed",
        output: [
          { type: "message", content: [{ type: "refusal", refusal: "no" }] },
        ],
      }),
    ).toEqual({ ok: false, failure: "model-output-invalid" });
  });

  it("takes the refusal over the answer the same message also wrote", () => {
    // A model may refuse *and* write something. Without the refusal branch
    // this payload comes back `{ok: true, text: "The lab has written…"}` and
    // a refusal walks into the citation gate dressed as an answer — so the
    // branch needs a case where the two parts disagree, not one where the
    // refusal is the only thing there.
    expect(
      readModelPayload({
        status: "completed",
        output: [
          {
            type: "message",
            content: [
              { type: "refusal", refusal: "no" },
              { type: "output_text", text: '{"items":[]}' },
            ],
          },
        ],
      }),
    ).toEqual({ ok: false, failure: "model-output-invalid" });
  });

  it("treats an empty answer as unreadable output", () => {
    expect(readModelPayload({ status: "completed", output: [] })).toEqual({
      ok: false,
      failure: "model-output-invalid",
    });
  });
});

describe("parseScoutJson", () => {
  it("survives a fenced answer, because a model that was told bare JSON may fence anyway", () => {
    expect(parseScoutJson('```json\n{"items":[]}\n```')).toEqual({ items: [] });
  });

  it("is null for anything that is not an object", () => {
    expect(parseScoutJson("not json")).toBeNull();
    expect(parseScoutJson("[1,2]")).toBeNull();
  });
});

describe("a model call that does not come back with items", () => {
  const cases = [
    ["model-unavailable", "couldn't reach"],
    ["model-timeout", "in time"],
    ["model-output-invalid", "couldn't read"],
    ["over-budget", "more to read"],
  ] as const;

  for (const [failure] of cases) {
    it(`fails the run as ${failure}, stores nothing, and frees the slot`, async () => {
      const { ctx, seed } = await seeded({ modelFailure: failure });
      await corpus(ctx, seed);

      await run(ctx, await queue(ctx, seed));

      const row = rowAt(ctx.db.all("delegations"));
      expect(row.status).toBe("failed");
      expect(row.failure).toBe(failure);
      // The sentence the reader gets is ours, not the model's.
      expect(row.failureReason).toBe(FAILURE_SENTENCES[failure]);
      expect(row.lease).toBeUndefined();
      expect(ctx.db.all("findings")).toEqual([]);
      // The ledger gets the vocabulary, never the sentence.
      const failed = ctx.db
        .all("events")
        .find((event) => event.type === "delegation.failed");
      expect(failed?.reason).toBe(failure);
      expect(JSON.stringify(failed)).not.toContain(FAILURE_SENTENCES[failure]);
    });
  }

  it("gives every new failure a sentence written by us", () => {
    for (const [failure] of cases) {
      const sentence = FAILURE_SENTENCES[failure];
      expect(sentence.length).toBeGreaterThan(0);
      // C4 renders these verbatim, and a reader is owed what happened to
      // their question and what to do about it.
      expect(sentence).toMatch(/Nothing was stored/);
    }
  });

  it("does not call the model twice when the run is retried", async () => {
    // §6.2, structurally: the second attempt finds the row `running` with a
    // live lease and exits before the seam.
    const { ctx, seed, calls } = await seeded();
    await corpus(ctx, seed);
    const delegationId = await queue(ctx, seed);

    await run(ctx, delegationId);
    await run(ctx, delegationId);

    expect(calls).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------
 * Storing under a moved lease
 * ---------------------------------------------------------------------- */

describe("store refuses when the row has moved", () => {
  const items = (noteId: Id<"annotations">, paperId: Id<"papers">) => [
    {
      text: "A cited sentence.",
      citedAnnotationIds: [noteId],
      citedPaperIds: [paperId],
    },
  ];

  it("writes nothing when another run holds the lease", async () => {
    const { ctx, seed } = await seeded();
    const noteId = await corpus(ctx, seed);
    const delegationId = await queue(ctx, seed, {
      status: "running",
      lease: "second-run",
      leaseAcquiredAt: Date.now(),
    });

    await handlerOf(store)(ctx, {
      delegationId,
      lease: "first-run",
      items: items(noteId, seed.paperId),
      coverage: { annotationsSearched: 1, papersTouched: 1, queriesRun: 1 },
      droppedForCitation: 0,
      model: "stub.scout.v0",
    } as never);

    expect(ctx.db.all("findings")).toEqual([]);
    expect(rowAt(ctx.db.all("delegations")).status).toBe("running");
  });

  it("writes nothing when the run overran its three minutes", async () => {
    const { ctx, seed } = await seeded();
    const noteId = await corpus(ctx, seed);
    const delegationId = await queue(ctx, seed, {
      status: "running",
      lease: "mine",
      leaseAcquiredAt: Date.now() - DELEGATION_LEASE_MS - 1,
    });

    await handlerOf(store)(ctx, {
      delegationId,
      lease: "mine",
      items: items(noteId, seed.paperId),
      coverage: { annotationsSearched: 1, papersTouched: 1, queriesRun: 1 },
      droppedForCitation: 0,
      model: "stub.scout.v0",
    } as never);

    expect(ctx.db.all("findings")).toEqual([]);
  });

  it("fails closed after a cancellation, because cancel clears the lease", async () => {
    const { ctx, seed } = await seeded();
    ctx.auth = { userId: seed.pi };
    const noteId = await corpus(ctx, seed);
    const delegationId = await queue(ctx, seed, {
      status: "running",
      lease: "mine",
      leaseAcquiredAt: Date.now(),
    });

    await handlerOf(cancel)(ctx, { delegationId } as never);
    await handlerOf(store)(ctx, {
      delegationId,
      lease: "mine",
      items: items(noteId, seed.paperId),
      coverage: { annotationsSearched: 1, papersTouched: 1, queriesRun: 1 },
      droppedForCitation: 0,
      model: "stub.scout.v0",
    } as never);

    // The cancellation did not have to race the run. It made the run's next
    // write a no-op.
    expect(ctx.db.all("findings")).toEqual([]);
    expect(rowAt(ctx.db.all("delegations")).status).toBe("cancelled");
  });
});

/* -------------------------------------------------------------------------
 * Expiry sweep
 * ---------------------------------------------------------------------- */

describe("expireStale", () => {
  it("reclaims slots nobody is coming back for, and leaves live runs alone", async () => {
    const { ctx, seed } = await seeded();
    const dead = await queue(ctx, seed, {
      status: "running",
      lease: "dead",
      leaseAcquiredAt: Date.now() - DELEGATION_LEASE_MS - 1,
    });
    const alive = await queue(ctx, seed, {
      status: "running",
      lease: "alive",
      leaseAcquiredAt: Date.now(),
    });

    const reclaimed = await handlerOf(expireStale)(ctx, {
      labId: seed.labId,
    } as never);

    expect(reclaimed).toBe(1);
    expect((await ctx.db.get(dead))?.status).toBe("failed");
    expect((await ctx.db.get(alive))?.status).toBe("running");
  });
});

/* -------------------------------------------------------------------------
 * The brief chain's entry point
 * ---------------------------------------------------------------------- */

describe("enqueueForBrief", () => {
  async function withBrief() {
    const { ctx, seed } = await seeded();
    const briefId = await ctx.db.insert("briefs", {
      sessionId: seed.sessionId,
      labId: seed.labId,
      paperId: seed.paperId,
      generation: 1,
      generatedAt: 1,
      generatedBy: seed.pi,
      trigger: "scheduled",
      sections: [],
    });
    return { ctx, seed, briefId };
  }

  it("queues one run per carried-forward question and credits the presenter", async () => {
    const { ctx, seed, briefId } = await withBrief();
    const queued = (await handlerOf(enqueueForBrief)(ctx, {
      briefId,
      annotationIds: [seed.questionId],
    } as never)) as Id<"delegations">[];

    expect(queued).toHaveLength(1);
    const row = rowAt(ctx.db.all("delegations"));
    expect(row.trigger).toBe("brief");
    expect(row.annotationId).toBe(seed.questionId);
    expect(row.requestedBy).toBe(seed.pi);
    expect(row.briefId).toBe(briefId);
    // One scheduled batch, not one job per question.
    expect(ctx.scheduled.map((call) => call.name)).toEqual([
      "delegations:runForBrief",
    ]);
    expect(rowAt(ctx.scheduled).args).toEqual({ delegationIds: queued });
  });

  it("skips a note that is not an open question, and one already running", async () => {
    const { ctx, seed, briefId } = await withBrief();
    const critique = await seedAnnotation(
      ctx,
      { ...seed, memberId: seed.pi },
      { type: "critique" },
    );

    await handlerOf(enqueueForBrief)(ctx, {
      briefId,
      annotationIds: [seed.questionId, critique],
    } as never);
    expect(ctx.db.all("delegations")).toHaveLength(1);

    // Asked again while the first is still queued.
    expect(
      await handlerOf(enqueueForBrief)(ctx, {
        briefId,
        annotationIds: [seed.questionId],
      } as never),
    ).toEqual([]);
    expect(ctx.db.all("delegations")).toHaveLength(1);
  });

  it("skips a question its author has taken private", async () => {
    const { ctx, seed, briefId } = await withBrief();
    await ctx.db.patch(seed.questionId as string, { visibility: "private" });
    expect(
      await handlerOf(enqueueForBrief)(ctx, {
        briefId,
        annotationIds: [seed.questionId],
      } as never),
    ).toEqual([]);
  });

  it("stops at the concurrency cap without telling anybody", async () => {
    const { ctx, seed, briefId } = await withBrief();
    const annotationIds: Id<"annotations">[] = [];
    for (let i = 0; i < MAX_ACTIVE_PER_LAB + 3; i += 1) {
      annotationIds.push(
        await seedAnnotation(
          ctx,
          { ...seed, memberId: seed.pi },
          { body: `Open question ${i} about the incubation step` },
        ),
      );
    }

    const queued = (await handlerOf(enqueueForBrief)(ctx, {
      briefId,
      annotationIds,
    } as never)) as Id<"delegations">[];

    // Nobody asked for these runs, so nobody is waiting to be told they did
    // not happen. The brief renders what came back and says nothing about
    // what did not.
    expect(queued).toHaveLength(MAX_ACTIVE_PER_LAB);
  });

  it("does nothing once the meeting it was for is no longer scheduled", async () => {
    const { ctx, seed, briefId } = await withBrief();
    await ctx.db.patch(seed.sessionId as string, { status: "cancelled" });
    expect(
      await handlerOf(enqueueForBrief)(ctx, {
        briefId,
        annotationIds: [seed.questionId],
      } as never),
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
 * Asking, and calling it off
 * ---------------------------------------------------------------------- */

describe("request and cancel", () => {
  const onQuestion = (seed: Seed) => ({
    subject: { kind: "annotation", annotationId: seed.questionId },
  });

  it("returns the run already going instead of starting a second", async () => {
    const { ctx, seed } = await seeded();
    ctx.auth = { userId: seed.member };

    const first = await handlerOf(request)(ctx, onQuestion(seed) as never);
    const second = await handlerOf(request)(ctx, onQuestion(seed) as never);

    // Pressing a button twice is not an error, and a second row would be the
    // lab paying twice for one answer.
    expect(second).toBe(first);
    expect(ctx.db.all("delegations")).toHaveLength(1);
  });

  it("works on an outcomes-panel question too", async () => {
    const { ctx, seed } = await seeded();
    ctx.auth = { userId: seed.member };
    await handlerOf(request)(ctx, {
      subject: { kind: "action", actionId: seed.actionId },
    } as never);
    expect(rowAt(ctx.db.all("delegations")).actionId).toBe(seed.actionId);
    expect(rowAt(ctx.db.all("delegations")).annotationId).toBeUndefined();
  });

  it("refuses a question that is private, and one in a lab you are not in", async () => {
    const { ctx, seed } = await seeded();
    ctx.auth = { userId: seed.member };
    await ctx.db.patch(seed.questionId as string, { visibility: "private" });
    await expect(
      handlerOf(request)(ctx, onQuestion(seed) as never),
    ).rejects.toThrow(ConvexError);

    await ctx.db.patch(seed.questionId as string, { visibility: "lab" });
    ctx.auth = { userId: "users_999" };
    await expect(
      handlerOf(request)(ctx, onQuestion(seed) as never),
    ).rejects.toThrow(ConvexError);
  });

  it("lets the requester and the PI call a run off, and nobody else", async () => {
    const { ctx, seed } = await seeded();
    const delegationId = await queue(ctx, seed, { requestedBy: seed.member });

    ctx.auth = { userId: "users_999" };
    await expect(
      handlerOf(cancel)(ctx, { delegationId } as never),
    ).rejects.toThrow(ConvexError);

    ctx.auth = { userId: seed.pi };
    await handlerOf(cancel)(ctx, { delegationId } as never);
    const row = rowAt(ctx.db.all("delegations"));
    expect(row.status).toBe("cancelled");
    expect(row.cancellation).toBe("by-member");
    expect(row.lease).toBeUndefined();
    // The ledger names the person who cancelled, not the person who asked.
    expect(
      ctx.db.all("events").find((e) => e.type === "delegation.cancelled")
        ?.actorId,
    ).toBe(seed.pi);
  });

  it("is quiet about a run that has already finished", async () => {
    const { ctx, seed } = await seeded();
    ctx.auth = { userId: seed.pi };
    const delegationId = await queue(ctx, seed, { status: "returned" });
    await handlerOf(cancel)(ctx, { delegationId } as never);
    expect(rowAt(ctx.db.all("delegations")).status).toBe("returned");
  });
});

/* -------------------------------------------------------------------------
 * Reading the status back
 * ---------------------------------------------------------------------- */

describe("listForSubject", () => {
  it("decides cancellability on the server, per row", async () => {
    const { ctx, seed } = await seeded();
    await queue(ctx, seed, { requestedBy: seed.member });
    await queue(ctx, seed, { status: "returned", requestedBy: seed.member });

    ctx.auth = { userId: seed.member };
    const mine = (await handlerOf(listForSubject)(ctx, {
      subject: { kind: "annotation", annotationId: seed.questionId },
    } as never)) as { status: string; canCancel: boolean }[];
    expect(mine.map((row) => row.canCancel)).toEqual([false, true]);

    // A run nobody else may call off.
    ctx.auth = { userId: "users_999" };
    expect(
      await handlerOf(listForSubject)(ctx, {
        subject: { kind: "annotation", annotationId: seed.questionId },
      } as never),
    ).toEqual([]);
  });

  it("shows nothing once the question has gone private", async () => {
    const { ctx, seed } = await seeded();
    await queue(ctx, seed);
    ctx.auth = { userId: seed.pi };
    await ctx.db.patch(seed.questionId as string, { visibility: "private" });
    expect(
      await handlerOf(listForSubject)(ctx, {
        subject: { kind: "annotation", annotationId: seed.questionId },
      } as never),
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
 * Reading a finding back
 * ---------------------------------------------------------------------- */

describe("findings.forDelegation", () => {
  async function returned() {
    const { ctx, seed } = await seeded();
    await corpus(ctx, seed);
    const delegationId = await queue(ctx, seed);
    await run(ctx, delegationId);
    return { ctx, seed, delegationId };
  }

  it("shows a member of the lab what their run found", async () => {
    const { ctx, seed, delegationId } = await returned();
    ctx.auth = { userId: seed.member };
    expect(
      await handlerOf(findings.forDelegation)(ctx, { delegationId } as never),
    ).not.toBeNull();
  });

  it("closes once the question it was about goes private", async () => {
    const { ctx, seed, delegationId } = await returned();
    await ctx.db.patch(seed.questionId as string, { visibility: "private" });

    ctx.auth = { userId: seed.member };
    // A delegation id is a bearer token by accident: anyone who watched the
    // run start is holding one. Membership alone would leave a finding on a
    // since-privatized question readable to exactly the people most likely
    // to have kept the id.
    expect(
      await handlerOf(findings.forDelegation)(ctx, { delegationId } as never),
    ).toBeNull();
    expect(
      await handlerOf(findings.newestForSubject)(ctx, {
        subject: { kind: "annotation", annotationId: seed.questionId },
      } as never),
    ).toBeNull();
  });

  it("closes for somebody outside the lab", async () => {
    const { ctx, delegationId } = await returned();
    ctx.auth = { userId: "users_999" };
    expect(
      await handlerOf(findings.forDelegation)(ctx, { delegationId } as never),
    ).toBeNull();
  });
});

/* -------------------------------------------------------------------------
 * The subject lifecycle cascade
 * ---------------------------------------------------------------------- */

describe("the cascade", () => {
  /** A run in flight on the outcomes-panel question. */
  const onAction = (ctx: FakeCtx, seed: Seed) =>
    queue(ctx, seed, { annotationId: undefined, actionId: seed.actionId });

  it("cancels the run when the question is settled", async () => {
    const { ctx, seed } = await seeded();
    ctx.auth = { userId: seed.pi };
    const inFlight = await onAction(ctx, seed);

    await handlerOf(actions.setSettled)(ctx, {
      actionId: seed.actionId,
      settled: true,
    } as never);

    const row = await ctx.db.get(inFlight);
    expect(row?.status).toBe("cancelled");
    expect(row?.cancellation).toBe("subject-settled");
    expect(row?.lease).toBeUndefined();
  });

  it("leaves a returned finding standing when the question is settled", async () => {
    const { ctx, seed } = await seeded();
    await corpus(ctx, seed);
    ctx.auth = { userId: seed.pi };
    await run(ctx, await onAction(ctx, seed));

    await handlerOf(actions.setSettled)(ctx, {
      actionId: seed.actionId,
      settled: true,
    } as never);

    // `supersededAt` means "a newer run returned", nothing else — and a
    // finding that informed a settlement is exactly the artifact somebody
    // will want to read afterwards. "Why did we decide that" is the question
    // the record exists to answer.
    expect(rowAt(ctx.db.all("findings")).supersededAt).toBeUndefined();
  });

  it("cancels in flight when the question is withdrawn, before the row goes", async () => {
    const { ctx, seed } = await seeded();
    ctx.auth = { userId: seed.pi };
    const inFlight = await onAction(ctx, seed);

    await handlerOf(actions.remove)(ctx, { actionId: seed.actionId } as never);

    expect(await ctx.db.get(seed.actionId)).toBeNull();
    // The delegation keeps the deleted id as a tombstone reference, which is
    // what the surface renders as "question withdrawn".
    const row = await ctx.db.get(inFlight);
    expect(row?.status).toBe("cancelled");
    expect(row?.cancellation).toBe("subject-withdrawn");
    expect(row?.actionId).toBe(seed.actionId);
  });

  it("leaves everything alone when a question is merely reopened", async () => {
    const { ctx, seed } = await seeded();
    ctx.auth = { userId: seed.pi };
    await ctx.db.patch(seed.actionId as string, { settledAt: 1 });
    const queued = await onAction(ctx, seed);

    await handlerOf(actions.setSettled)(ctx, {
      actionId: seed.actionId,
      settled: false,
    } as never);

    expect((await ctx.db.get(queued))?.status).toBe("queued");
  });

  it("finds findings that cite a withdrawn note through the join table", async () => {
    const { ctx, seed } = await seeded();
    const noteId = await corpus(ctx, seed);
    await run(ctx, await queue(ctx, seed));

    const findingId = rowAt(ctx.db.all("findings"))._id;
    expect(
      ctx.db.all("findingCitations").map((row) => row.annotationId),
    ).toEqual([noteId]);

    const result = await cascadeForAnnotation(ctx as never, noteId, seed.pi);

    // Reached through `findingCitations.by_annotation`, not by scanning the
    // lab's findings — citations live nested inside `items`, which Convex
    // cannot index.
    expect(result.findingsAffected).toEqual([findingId]);
    expect(ctx.db.lastReadOf("by_annotation")?.table).toBe("findingCitations");

    // Located, not redacted. The stored row is untouched: read-time
    // whole-item redaction is what protects the withdrawn note, and it holds
    // whether or not this function ever runs.
    expect((await ctx.db.get(findingId))?.supersededAt).toBeUndefined();
  });

  it("cancels a run whose subject note was withdrawn", async () => {
    const { ctx, seed } = await seeded();
    const inFlight = await queue(ctx, seed);

    const result = await cascadeForAnnotation(
      ctx as never,
      seed.questionId,
      seed.pi,
    );

    expect(result.cancelled).toBe(1);
    // The note *was* the question, so the reason is that the subject went —
    // not that a citation under it moved.
    expect((await ctx.db.get(inFlight))?.cancellation).toBe("subject-withdrawn");
  });

  it("writes one join row per distinct note, however many items cite it", () => {
    const a = "annotations_1" as Id<"annotations">;
    const b = "annotations_2" as Id<"annotations">;
    expect(
      citationRowsFor([
        { text: "", citedAnnotationIds: [a, b], citedPaperIds: [] },
        { text: "", citedAnnotationIds: [a], citedPaperIds: [] },
      ]),
    ).toEqual([a, b]);
  });
});
