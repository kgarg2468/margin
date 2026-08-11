import { describe, expect, it, vi } from "vitest";
import type { Doc, Id } from "./_generated/dataModel";
import { buildForSession, generate, redactWithdrawn } from "./briefs";
import {
  FakeCtx,
  handlerOf,
  rowAt,
  seedAnnotation,
  seedLab,
} from "./delegations.fixtures";
import { WITHDRAWN_ITEM_TEXT } from "./synthesis";

vi.mock("@convex-dev/auth/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@convex-dev/auth/server")>()),
  getAuthUserId: async (ctx: unknown) =>
    (ctx as { auth?: { userId?: string } }).auth?.userId ?? null,
}));

/**
 * What a stored brief is still allowed to say, and what it sets going.
 *
 * The assembly itself is tested in `lib/brief/` — it is pure and knows nothing
 * about a database. This covers the other half, which is the half that has a
 * privacy consequence: a brief row is a snapshot of a margin that keeps moving,
 * and every line of it was built out of notes that their authors can withdraw
 * or flip back to private at any point afterwards.
 *
 * The case worth writing down is a collision. Its text names two members and
 * quotes both, so a rule that only redacts when *every* citation has gone would
 * keep serving a withdrawn member's name and passage for as long as the other
 * member's note survived — which is a way around `visibility: "private"` that
 * looks, on the page, exactly like a line that is fine.
 *
 * The second block below is about reachability rather than redaction: the scout
 * costs money per run, so *which* assembly queues one is a product decision,
 * and it is enforced here against the real handlers.
 */

const note = (n: number) => `annotation_${n}` as Id<"annotations">;

type Section = Doc<"briefs">["sections"][number];

/** A collision line: two members, two citations, one sentence built from both. */
const collision = (): Section => ({
  key: "collisions",
  heading: "Where the lab disagrees",
  droppedCount: 0,
  items: [
    {
      text: "Ana Ruiz defined a term on the passage Ben Okafor left an open question on",
      annotationIds: [note(1), note(2)],
      pairType: "possible answer",
    },
  ],
});

/** An ordinary one-note line, for contrast. */
const single = (): Section => ({
  key: "open-questions",
  heading: "Open questions",
  droppedCount: 0,
  items: [
    {
      text: "Ben Okafor, p. 4: “what fixes the temperature here?”",
      annotationIds: [note(3)],
    },
  ],
});

const shared = (...ids: Id<"annotations">[]) => new Set(ids);

describe("redactWithdrawn", () => {
  it("leaves a line alone while every note behind it is still shared", () => {
    const [section] = redactWithdrawn([collision()], shared(note(1), note(2)));
    expect(section?.items[0]?.text).toBe(collision().items[0]?.text);
  });

  it("redacts a two-note collision when one of the two is withdrawn", () => {
    const [section] = redactWithdrawn([collision()], shared(note(1)));
    expect(section?.items[0]?.text).toBe(WITHDRAWN_ITEM_TEXT);
  });

  it("redacts whichever half of a collision goes, not a favoured one", () => {
    const [section] = redactWithdrawn([collision()], shared(note(2)));
    expect(section?.items[0]?.text).toBe(WITHDRAWN_ITEM_TEXT);
  });

  it("names neither member once a collision has been redacted", () => {
    const [section] = redactWithdrawn([collision()], shared(note(1)));
    const text = section?.items[0]?.text ?? "";
    expect(text).not.toContain("Ana Ruiz");
    expect(text).not.toContain("Ben Okafor");
  });

  it("redacts when both notes behind a collision have gone", () => {
    const [section] = redactWithdrawn([collision()], shared());
    expect(section?.items[0]?.text).toBe(WITHDRAWN_ITEM_TEXT);
  });

  it("redacts a one-note line when its note has gone", () => {
    const [section] = redactWithdrawn([single()], shared());
    expect(section?.items[0]?.text).toBe(WITHDRAWN_ITEM_TEXT);
  });

  it("keeps the citations on a redacted line, so it can still be counted", () => {
    const [section] = redactWithdrawn([collision()], shared(note(1)));
    expect(section?.items[0]?.annotationIds).toEqual([note(1), note(2)]);
  });

  it("keeps the rest of the item, so the line still reads as a collision", () => {
    const [section] = redactWithdrawn([collision()], shared(note(1)));
    expect(section?.items[0]?.pairType).toBe("possible answer");
  });

  it("redacts one line without touching its neighbours", () => {
    const sections = redactWithdrawn(
      [collision(), single()],
      shared(note(1), note(3)),
    );
    expect(sections[0]?.items[0]?.text).toBe(WITHDRAWN_ITEM_TEXT);
    expect(sections[1]?.items[0]?.text).toBe(single().items[0]?.text);
  });

  it("keeps the section's own fields, so nothing is dropped silently", () => {
    const [section] = redactWithdrawn([collision()], shared(note(1)));
    expect(section?.key).toBe("collisions");
    expect(section?.heading).toBe("Where the lab disagrees");
    expect(section?.droppedCount).toBe(0);
    expect(section?.items).toHaveLength(1);
  });

  it("does not mutate the row it was handed", () => {
    const sections = [collision()];
    redactWithdrawn(sections, shared());
    expect(sections[0]?.items[0]?.text).toBe(collision().items[0]?.text);
  });
});

/* -------------------------------------------------------------------------
 * What assembling a brief sets going
 * ---------------------------------------------------------------------- */

/**
 * A lab with a session two hours out and a prior session that left one
 * question unanswered — the shape `lib/brief/assemble.ts` carries forward.
 */
async function briefWorld() {
  const ctx = new FakeCtx();
  const seed = await seedLab(ctx);
  const priorSessionId = await ctx.db.insert("sessions", {
    labId: seed.labId,
    paperId: seed.paperId,
    presenterId: seed.member,
    // Before the upcoming one, which is what makes it prior.
    scheduledAt: -1,
    status: "ended",
    createdBy: seed.pi,
  });
  const carried = await seedAnnotation(
    ctx,
    { ...seed, memberId: seed.member },
    {
      type: "open-question",
      body: "Which cohort ran the second replicate?",
      sessionId: priorSessionId,
    },
  );
  return { ctx, seed, priorSessionId, carried };
}

describe("the scout rides the brief", () => {
  it("queues one run per carried-forward question, after the brief is written", async () => {
    const { ctx, seed, carried } = await briefWorld();

    await handlerOf(buildForSession)(ctx, {
      sessionId: seed.sessionId,
      expectedScheduledAt: 1,
    } as never);

    // The brief exists first and the enqueue is a separate transaction
    // scheduled after it: the scout rides along behind the brief, and a
    // delegation that failed to queue must not be able to roll back a brief
    // that is already correct.
    expect(ctx.db.all("briefs")).toHaveLength(1);
    const queued = ctx.scheduled.filter((call) =>
      call.name.includes("enqueueForBrief"),
    );
    expect(queued).toHaveLength(1);
    expect(rowAt(queued).args).toEqual({
      briefId: rowAt(ctx.db.all("briefs"))._id,
      annotationIds: [carried],
    });
  });

  it("queues nothing when the brief carries no open questions forward", async () => {
    // No subject, no scout. A brief with an empty "carried-over" section is
    // the common case for a lab's first session, and it must cost nothing.
    const { ctx, seed, carried } = await briefWorld();
    // Answered: a reply is what takes a question off the carried list.
    await ctx.db.patch(carried, { type: "claim" });

    await handlerOf(buildForSession)(ctx, {
      sessionId: seed.sessionId,
      expectedScheduledAt: 1,
    } as never);

    expect(ctx.db.all("briefs")).toHaveLength(1);
    expect(
      ctx.scheduled.filter((call) => call.name.includes("enqueueForBrief")),
    ).toEqual([]);
  });

  it("queues nothing for a brief a person assembled by hand", async () => {
    // `generate` is a button, and a batch of model calls per press is not what
    // pressing "assemble" means. §6.1 puts the trigger on the T−2h chain
    // precisely because that one fires once.
    const { ctx, seed } = await briefWorld();
    ctx.auth = { userId: seed.pi };

    await handlerOf(generate)(ctx, { sessionId: seed.sessionId } as never);

    expect(ctx.db.all("briefs")).toHaveLength(1);
    expect(
      ctx.scheduled.filter((call) => call.name.includes("enqueueForBrief")),
    ).toEqual([]);
  });
});

describe("the brief past the paper boundary", () => {
  it("draws a line between two papers and marks the far citation", async () => {
    const ctx = new FakeCtx();
    const seed = await seedLab(ctx);
    const claim =
      "data were collected from two independent cohorts under identical conditions";
    const other = await ctx.db.insert("papers", {
      labId: seed.labId,
      title: "The other one",
      addedBy: seed.pi,
      ingestStatus: "ready",
    });
    await seedAnnotation(ctx, { ...seed, memberId: seed.pi }, {
      type: "hypothesis",
      quote: claim,
    });
    await seedAnnotation(ctx, { ...seed, memberId: seed.member }, {
      type: "critique",
      paperId: other,
      quote: claim,
    });

    ctx.auth = { userId: seed.pi };
    await handlerOf(generate)(ctx, { sessionId: seed.sessionId } as never);

    const brief = rowAt(ctx.db.all("briefs"));
    const line = brief.sections
      .find((s) => s.key === "collisions")
      ?.items.find((item) => item.crossPaperIds !== undefined);
    expect(line?.text).toContain("The other one");
    expect(line?.crossPaperIds).toHaveLength(1);
  });
});

describe("what the boundary lift costs", () => {
  it("reads twelve neighbours at most, however many papers the lab has", async () => {
    // `CROSS_PAPER_PAPERS` is a promise about how many documents one press of
    // the button reads, and the papers query takes thirteen so it can afford
    // to skip this meeting's own paper. When this paper is older than all
    // thirteen the skip never fires — so the loop has to stop itself, or the
    // budget is 1,950 rows rather than the 1,800 it says.
    const ctx = new FakeCtx();
    const seed = await seedLab(ctx);
    for (let i = 0; i < 14; i++) {
      const other = await ctx.db.insert("papers", {
        labId: seed.labId,
        title: `Neighbour ${i}`,
        addedBy: seed.pi,
        ingestStatus: "ready",
      });
      await seedAnnotation(
        ctx,
        { ...seed, memberId: seed.member },
        { paperId: other, type: "critique" },
      );
    }

    ctx.auth = { userId: seed.pi };
    await handlerOf(generate)(ctx, { sessionId: seed.sessionId } as never);

    // One read for this paper's own pool, twelve for the neighbours.
    expect(
      ctx.db.reads.filter(
        (read) => read.index === "by_paper_and_visibility",
      ),
    ).toHaveLength(1 + 12);
  });
});
