import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { FakeCtx, handlerOf, rowAt } from "./delegations.fixtures";
import { recordEvent } from "./lib/ledger";
import {
  assembleRecall,
  buildSessionPrep,
  catchUp,
  isSolo,
  recallWhen,
} from "./digests";

vi.mock("@convex-dev/auth/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@convex-dev/auth/server")>()),
  getAuthUserId: async (ctx: unknown) =>
    (ctx as { auth?: { userId?: string } }).auth?.userId ?? null,
}));

/**
 * The lab of one, and the rule that keeps its digest honest.
 *
 * Everywhere else a digest is what somebody *else* wrote. In a one-member lab
 * that set is empty by definition, so the boundary hands back the member's own
 * older notes instead — which puts two failure modes one line of code apart
 * from each other. The first is an echo: a digest that reads out the paragraph
 * the reader typed twenty minutes ago, which is worse than an empty inbox
 * because it teaches them the card is noise. The second is the invariant on the
 * other side of the same pool, that nobody who is not in this lab may ever be
 * counted as lab activity — the reason it is tested here is that a solo lab is
 * exactly where a stray author would be least visible, since there is no
 * colleague for the reader to be surprised by.
 *
 * The assembly itself is pure and covered directly; the rest drives the real
 * `catchUp` handler against the in-memory database, because "which notes come
 * back" is a question about a read, a window and a clock at once.
 */

const DAY = 24 * 60 * 60 * 1000;
/** A Tuesday in August, so every "in March" below is a fixed string. */
const NOW = Date.UTC(2026, 7, 18, 12, 0, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

/* -------------------------------------------------------------------------
 * A world
 * ---------------------------------------------------------------------- */

async function seedSoloLab(ctx: FakeCtx) {
  const me = await ctx.db.insert("users", { name: "Ana Ruiz" });
  const labId = await ctx.db.insert("labs", {
    name: "Ruiz Lab",
    createdBy: me,
    memberCount: 1,
  });
  await ctx.db.insert("memberships", {
    labId,
    userId: me,
    role: "pi",
    joinedAt: NOW - 400 * DAY,
  });
  const paperId = await ctx.db.insert("papers", {
    labId,
    title: "Cold-chain effects on assay reproducibility",
    addedBy: me,
    ingestStatus: "ready",
  });
  ctx.auth = { userId: me };
  return { me, labId, paperId };
}

/** A second person, so the lab stops being solo. */
async function addColleague(
  ctx: FakeCtx,
  labId: Id<"labs">,
): Promise<Id<"users">> {
  const them = await ctx.db.insert("users", { name: "Ben Okafor" });
  await ctx.db.insert("memberships", {
    labId,
    userId: them,
    role: "member",
    joinedAt: NOW - 400 * DAY,
  });
  return them;
}

/**
 * One note, written at a stated moment.
 *
 * The fixture's database stamps `_creationTime` from an insert counter, and an
 * annotation's age is the whole subject of these tests — a digest that decides
 * "March" from a row numbered 3 is not exercising the rule. So every row is
 * dated explicitly afterwards, which is also what makes the seeds read in the
 * order the assertions talk about them.
 */
async function noteAt(
  ctx: FakeCtx,
  seed: { labId: Id<"labs">; paperId: Id<"papers">; memberId: Id<"users"> },
  at: number,
  overrides: {
    type?: string;
    quote?: string;
    start?: number;
    end?: number;
    pageIndex?: number;
    visibility?: "lab" | "private";
    deletedAt?: number;
    paperId?: Id<"papers">;
    memberId?: Id<"users">;
  } = {},
): Promise<Id<"annotations">> {
  const id = await ctx.db.insert("annotations", {
    labId: seed.labId,
    paperId: overrides.paperId ?? seed.paperId,
    memberId: overrides.memberId ?? seed.memberId,
    anchor: {
      quote: overrides.quote ?? "incubated at 4°C overnight before the assay",
      prefix: "",
      suffix: "",
      start: overrides.start ?? 100,
      end: overrides.end ?? 140,
      pageIndex: overrides.pageIndex ?? 3,
    },
    type: overrides.type ?? "hypothesis",
    body: "The cold step is doing the work.",
    visibility: overrides.visibility ?? "lab",
    deletedAt: overrides.deletedAt,
  });
  await ctx.db.patch(id, { _creationTime: at });
  return id;
}

/**
 * The ledger beat that tells an arrival this paper is worth reading.
 *
 * Through `recordEvent` rather than a hand-written row, for the reason
 * `sessions.test.ts` gives: the ledger has one write path and a test that
 * seeded the table itself would be the only place in the repo making the
 * append-only claim on the module's behalf. The ledger stamps `at` from the
 * clock, so the clock is what says when the beat happened.
 */
async function wroteOn(
  ctx: FakeCtx,
  seed: { labId: Id<"labs">; paperId: Id<"papers"> },
  actorId: Id<"users">,
  annotationId: Id<"annotations">,
  at: number,
): Promise<void> {
  const resume = Date.now();
  vi.setSystemTime(at);
  await recordEvent(ctx as unknown as MutationCtx, {
    labId: seed.labId,
    actorId,
    type: "annotation.created",
    paperId: seed.paperId,
    annotationId,
    annotationType: "hypothesis",
    visibility: "lab",
  });
  vi.setSystemTime(resume);
}

const arrive = (ctx: FakeCtx, labId: Id<"labs">) =>
  handlerOf(catchUp)(ctx, { labId } as never);

/* -------------------------------------------------------------------------
 * Dating a memory
 * ---------------------------------------------------------------------- */

describe("recallWhen", () => {
  it("counts weeks while a note is recent enough to count in weeks", () => {
    expect(recallWhen(NOW - 21 * DAY, NOW)).toBe("3 weeks ago");
  });

  it("names the month once weeks stop being a useful unit", () => {
    expect(recallWhen(NOW - 100 * DAY, NOW)).toBe("in May");
  });

  it("adds the year when the month alone would be ambiguous", () => {
    expect(recallWhen(NOW - 400 * DAY, NOW)).toBe("in July 2025");
  });

  it("never says a note is older than it is", () => {
    expect(recallWhen(NOW - 14 * DAY, NOW)).toBe("2 weeks ago");
  });
});

/* -------------------------------------------------------------------------
 * The assembly
 * ---------------------------------------------------------------------- */

type Row = {
  id: string;
  paperId: string;
  memberId: string;
  memberName: string;
  type:
    | "note"
    | "hypothesis"
    | "method-note"
    | "critique"
    | "definition"
    | "connection-to-own-work"
    | "open-question";
  pageIndex: number;
  start: number;
  end: number;
  quote: string;
  createdAt: number;
};

const row = (overrides: Partial<Row> & { id: string }): Row => ({
  paperId: "paper_1",
  memberId: "me",
  memberName: "Ana Ruiz",
  type: "hypothesis",
  pageIndex: 3,
  start: 100,
  end: 140,
  quote: "incubated at 4°C overnight before the assay",
  createdAt: NOW - 100 * DAY,
  ...overrides,
});

const titles = new Map([
  ["paper_1", "Cold-chain effects"],
  ["paper_2", "Freeze–thaw and yield"],
]);

describe("assembleRecall", () => {
  it("speaks in the first person and dates what it hands back", () => {
    const { items } = assembleRecall({
      recalled: [row({ id: "a" })],
      fresh: [],
      paperTitles: titles,
      now: NOW,
    });
    expect(rowAt(items).line).toBe(
      "You left a hypothesis on Cold-chain effects in May — p. 4: “incubated at 4°C overnight before the assay”",
    );
  });

  it("never borrows a colleague's words for a note the reader wrote", () => {
    const { items } = assembleRecall({
      recalled: [row({ id: "a" }), row({ id: "b", paperId: "paper_2" })],
      fresh: [],
      paperTitles: titles,
      now: NOW,
    });
    for (const item of items) {
      expect(item.line).toMatch(/^You left/);
      expect(item.line).not.toMatch(/member|colleague|Ana Ruiz|Someone/);
    }
  });

  it("leads with the passage the reader has come back to", () => {
    // The whole feature in one assertion: a note on the same passage as
    // something written this visit is the line worth the slot, and it ranks
    // above the paper-level recall even though the paper line is older.
    const { items } = assembleRecall({
      recalled: [
        row({ id: "older", paperId: "paper_2", createdAt: NOW - 300 * DAY }),
        row({ id: "same-passage" }),
      ],
      fresh: [row({ id: "today", createdAt: NOW - 1000 })],
      paperTitles: titles,
      now: NOW,
    });
    expect(rowAt(items).line).toContain("on this same passage");
    expect(rowAt(items).annotationIds).toEqual(["same-passage", "today"]);
    expect(rowAt(items, 1).line).toContain("Freeze–thaw and yield");
  });

  it("puts the oldest memory first, which is the opposite of the news tiers", () => {
    const { items } = assembleRecall({
      recalled: [
        row({ id: "recent", paperId: "paper_1", createdAt: NOW - 20 * DAY }),
        row({ id: "ancient", paperId: "paper_2", createdAt: NOW - 300 * DAY }),
      ],
      fresh: [],
      paperTitles: titles,
      now: NOW,
    });
    expect(items.map((item) => item.paperId)).toEqual(["paper_2", "paper_1"]);
  });

  it("coalesces one paper's older notes into a line that counts them", () => {
    const { items } = assembleRecall({
      recalled: [
        row({ id: "a", createdAt: NOW - 300 * DAY }),
        row({ id: "b", createdAt: NOW - 100 * DAY }),
      ],
      fresh: [],
      paperTitles: titles,
      now: NOW,
    });
    expect(items).toHaveLength(1);
    expect(rowAt(items).line).toContain("You left 2 notes on Cold-chain effects");
    // Ten months back, so the bare month is unambiguous: there has only been
    // one October since. The year appears at twelve, not at the new year.
    expect(rowAt(items).line).toContain("the oldest in October");
    expect(rowAt(items).annotationIds).toEqual(["a", "b"]);
  });

  it("counts the notes the cap held back, not the lines", () => {
    const recalled = Array.from({ length: 7 }, (_, index) =>
      row({
        id: `note_${index}`,
        paperId: `paper_${index}`,
        createdAt: NOW - (300 - index) * DAY,
      }),
    );
    const { items, droppedCount } = assembleRecall({
      recalled,
      fresh: [],
      paperTitles: titles,
      now: NOW,
    });
    expect(items).toHaveLength(5);
    expect(droppedCount).toBe(2);
  });
});

/* -------------------------------------------------------------------------
 * The boundary, in a lab of one
 * ---------------------------------------------------------------------- */

describe("catchUp in a lab of one", () => {
  it("hands back the note the reader wrote on this passage in the spring", async () => {
    const ctx = new FakeCtx();
    const seed = await seedSoloLab(ctx);
    const old = await noteAt(ctx, { ...seed, memberId: seed.me }, NOW - 120 * DAY);
    const today = await noteAt(
      ctx,
      { ...seed, memberId: seed.me },
      NOW - 30 * 60 * 1000,
    );
    await wroteOn(ctx, seed, seed.me, today, NOW - 30 * 60 * 1000);

    const digestId = await arrive(ctx, seed.labId);

    expect(digestId).not.toBeNull();
    const digest = rowAt(ctx.db.all("digests"));
    expect(digest.boundary).toBe("since-away");
    expect(rowAt(digest.items).line).toBe(
      "You left a hypothesis on this same passage in April — Cold-chain effects on assay reproducibility, p. 4: “incubated at 4°C overnight before the assay”",
    );
    expect(rowAt(digest.items).annotationIds).toEqual([old, today]);
  });

  it("does not read back the note that was just written", async () => {
    // The echo. Everything on this paper is from this visit, so there is a
    // digest's worth of pool and nothing in it that could be a memory.
    const ctx = new FakeCtx();
    const seed = await seedSoloLab(ctx);
    const today = await noteAt(
      ctx,
      { ...seed, memberId: seed.me },
      NOW - 30 * 60 * 1000,
    );
    await wroteOn(ctx, seed, seed.me, today, NOW - 30 * 60 * 1000);

    expect(await arrive(ctx, seed.labId)).toBeNull();
    expect(ctx.db.all("digests")).toHaveLength(0);
  });

  it("refuses a note that is older than the window but younger than a fortnight", async () => {
    // The age floor doing the work the window cannot. This member caught up
    // two days ago, so a note from five days ago is behind the window — and it
    // is still last week's writing, which is not something they have forgotten.
    const ctx = new FakeCtx();
    const seed = await seedSoloLab(ctx);
    await ctx.db.insert("seenCursors", {
      userId: seed.me,
      labId: seed.labId,
      lastSeenAt: NOW - 2 * DAY,
    });
    await noteAt(ctx, { ...seed, memberId: seed.me }, NOW - 5 * DAY);
    const today = await noteAt(
      ctx,
      { ...seed, memberId: seed.me },
      NOW - 30 * 60 * 1000,
    );
    await wroteOn(ctx, seed, seed.me, today, NOW - 30 * 60 * 1000);

    expect(await arrive(ctx, seed.labId)).toBeNull();
  });

  it("refuses a note from inside the window even when it is months old", async () => {
    // And the window doing the work the age floor cannot: this member has not
    // been caught up since the spring, so a note from June is part of the
    // stretch this arrival is reporting on rather than a memory it surfaces.
    const ctx = new FakeCtx();
    const seed = await seedSoloLab(ctx);
    await ctx.db.insert("seenCursors", {
      userId: seed.me,
      labId: seed.labId,
      lastSeenAt: NOW - 90 * DAY,
    });
    await noteAt(ctx, { ...seed, memberId: seed.me }, NOW - 60 * DAY);
    const today = await noteAt(
      ctx,
      { ...seed, memberId: seed.me },
      NOW - 30 * 60 * 1000,
    );
    await wroteOn(ctx, seed, seed.me, today, NOW - 30 * 60 * 1000);

    expect(await arrive(ctx, seed.labId)).toBeNull();
  });

  it("keeps a private note out of the digest it could not be read from", async () => {
    // The row outlives the lab's size: a solo lab can gain a second member
    // tomorrow, and nothing re-reads a stored digest's provenance when it does.
    // A private note copied into one today is a leak scheduled for later.
    const ctx = new FakeCtx();
    const seed = await seedSoloLab(ctx);
    await noteAt(ctx, { ...seed, memberId: seed.me }, NOW - 120 * DAY, {
      visibility: "private",
      quote: "the unpublished number nobody else has",
    });
    await noteAt(ctx, { ...seed, memberId: seed.me }, NOW - 100 * DAY, {
      deletedAt: NOW - 50 * DAY,
      quote: "the sentence they took back",
    });
    const today = await noteAt(
      ctx,
      { ...seed, memberId: seed.me },
      NOW - 30 * 60 * 1000,
    );
    await wroteOn(ctx, seed, seed.me, today, NOW - 30 * 60 * 1000);

    expect(await arrive(ctx, seed.labId)).toBeNull();
    expect(ctx.db.all("digests")).toHaveLength(0);
  });

  it("rebuilds the waiting card in place rather than stacking a second", async () => {
    const ctx = new FakeCtx();
    const seed = await seedSoloLab(ctx);
    await noteAt(ctx, { ...seed, memberId: seed.me }, NOW - 120 * DAY);
    const today = await noteAt(
      ctx,
      { ...seed, memberId: seed.me },
      NOW - 30 * 60 * 1000,
    );
    await wroteOn(ctx, seed, seed.me, today, NOW - 30 * 60 * 1000);

    const first = await arrive(ctx, seed.labId);
    vi.setSystemTime(NOW + 2 * 60 * 60 * 1000);
    const second = await arrive(ctx, seed.labId);

    expect(second).toBe(first);
    expect(ctx.db.all("digests")).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------
 * What a second member changes, and what a non-member never earns
 * ---------------------------------------------------------------------- */

describe("membership decides what a digest may call activity", () => {
  it("stops recalling the reader's own notes as soon as the lab is two", async () => {
    const ctx = new FakeCtx();
    const seed = await seedSoloLab(ctx);
    await addColleague(ctx, seed.labId);
    await noteAt(ctx, { ...seed, memberId: seed.me }, NOW - 120 * DAY);
    const today = await noteAt(
      ctx,
      { ...seed, memberId: seed.me },
      NOW - 30 * 60 * 1000,
    );
    await wroteOn(ctx, seed, seed.me, today, NOW - 30 * 60 * 1000);

    expect(await arrive(ctx, seed.labId)).toBeNull();
    expect(ctx.db.all("digests")).toHaveLength(0);
  });

  it("never counts an author who is not in the lab as a colleague", async () => {
    // The ghost: a user with annotations in this lab's paper and no membership
    // row — someone who left, or content seeded under an author who was never
    // here. Their writing is the only writing since the cursor, so a digest
    // that treated it as lab activity would tell this member a colleague is
    // back at work.
    const ctx = new FakeCtx();
    const seed = await seedSoloLab(ctx);
    await addColleague(ctx, seed.labId);
    const ghost = await ctx.db.insert("users", { name: "Nobody At All" });
    const theirs = await noteAt(
      ctx,
      { ...seed, memberId: ghost },
      NOW - 30 * 60 * 1000,
      { memberId: ghost },
    );
    await wroteOn(ctx, seed, ghost, theirs, NOW - 30 * 60 * 1000);

    expect(await arrive(ctx, seed.labId)).toBeNull();
    expect(ctx.db.all("digests")).toHaveLength(0);
  });

  it("keeps a non-member's note out of a session's prep as well", async () => {
    const ctx = new FakeCtx();
    const seed = await seedSoloLab(ctx);
    await addColleague(ctx, seed.labId);
    const ghost = await ctx.db.insert("users", { name: "Nobody At All" });
    const sessionId = await ctx.db.insert("sessions", {
      labId: seed.labId,
      paperId: seed.paperId,
      presenterId: seed.me,
      scheduledAt: NOW + 2 * 60 * 60 * 1000,
      status: "scheduled",
      createdBy: seed.me,
    });
    await noteAt(ctx, { ...seed, memberId: ghost }, NOW - 60 * 60 * 1000, {
      memberId: ghost,
    });

    await handlerOf(buildSessionPrep)(ctx, {
      sessionId,
      boundary: "session-prep",
      expectedScheduledAt: NOW + 2 * 60 * 60 * 1000,
    } as never);

    expect(ctx.db.all("digests")).toHaveLength(0);
  });

  it("answers whether the lab is one person, from the membership rows", async () => {
    const ctx = new FakeCtx();
    const seed = await seedSoloLab(ctx);
    expect(await handlerOf(isSolo)(ctx, { labId: seed.labId } as never)).toBe(
      true,
    );
    await addColleague(ctx, seed.labId);
    expect(await handlerOf(isSolo)(ctx, { labId: seed.labId } as never)).toBe(
      false,
    );
  });
});
