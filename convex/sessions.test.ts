import { ConvexError } from "convex/values";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  FakeCtx,
  handlerOf,
  seedLab,
} from "./delegations.fixtures";
import { recordEvent } from "./lib/ledger";
import type { LedgerEvent } from "./lib/ledger";
import { reopenSession, restoreSession, startSession } from "./sessions";

vi.mock("@convex-dev/auth/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@convex-dev/auth/server")>()),
  getAuthUserId: async (ctx: unknown) =>
    (ctx as { auth?: { userId?: string } }).auth?.userId ?? null,
}));

/**
 * The two back edges, and the one sentence the start button refuses with.
 *
 * Every other transition in `sessions.ts` moves forward, and forward moves are
 * allowed to be irreversible. These two are not: they exist so that the
 * ten seconds after a misclick are recoverable, and everything worth testing
 * about them is a boundary — the window that closes, the status that has to be
 * the one the undo was offered for, the prep digest that cancelling threw away
 * and restoring has to arm again, and the ledger, which gains a row and never
 * loses one.
 *
 * The refusal-copy test is here rather than in `lib/` because the sentence the
 * server sends is the one a presenter reads while their lab watches, and it has
 * been wrong before — "isn't until in about 25 hours away" is what you get when
 * the prose and the distance disagree about which half of the sentence they own.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * The undo window, restated rather than imported — deliberately.
 *
 * Importing `UNDO_WINDOW_MS` from `sessions.ts` would make these tests agree
 * with whatever the module currently says, which is precisely the thing they
 * exist to check: a suite that imports the constant passes just as happily
 * after somebody halves it. The number is the spec, so it is written here, and
 * a change to the module's value has to be a deliberate change to this line too.
 */
const UNDO_WINDOW = 10 * 60 * 1000;

/** The synthesis generation lease, restated for the same reason. */
const GENERATION_LEASE = 3 * 60 * 1000;

/** How many meetings a lab may have on the books at once. Same bargain. */
const MAX_SCHEDULED = 50;

/**
 * The at-the-boundary cases stop the clock, because they are a millisecond
 * wide. The handler reads `Date.now()` itself, so a test that seeded
 * `now - UNDO_WINDOW` and then lost a millisecond to the await would be
 * asserting `UNDO_WINDOW + 1` half the time — a flake that looks exactly like
 * an off-by-one in the guard.
 */
function freezeClock(): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-04T10:00:00.000Z"));
}

afterEach(() => {
  vi.useRealTimers();
});

type Seed = Awaited<ReturnType<typeof seedLab>>;

/** A session of the caller's choosing, owned by the PI from `seedLab`. */
async function seedSession(
  ctx: FakeCtx,
  seed: Seed,
  fields: Partial<Doc<"sessions">> & { status: Doc<"sessions">["status"] },
): Promise<Id<"sessions">> {
  return await ctx.db.insert("sessions", {
    labId: seed.labId,
    paperId: seed.paperId,
    presenterId: seed.pi,
    createdBy: seed.pi,
    scheduledAt: Date.now() + 24 * HOUR,
    ...fields,
  });
}

async function world() {
  const ctx = new FakeCtx();
  const seed = await seedLab(ctx);
  ctx.auth = { userId: seed.pi };
  return { ctx, seed };
}

const reopen = (ctx: FakeCtx, sessionId: Id<"sessions">) =>
  handlerOf(reopenSession)(ctx, { sessionId } as never);
const restore = (ctx: FakeCtx, sessionId: Id<"sessions">) =>
  handlerOf(restoreSession)(ctx, { sessionId } as never);

/** The typed row back out of the fake db, without the `| null` at every use. */
async function sessionRow(
  ctx: FakeCtx,
  sessionId: Id<"sessions">,
): Promise<Doc<"sessions">> {
  const session = await ctx.db.get(sessionId);
  if (session === null) throw new Error("the test's own session is missing");
  return session;
}

function eventTypes(ctx: FakeCtx): string[] {
  return ctx.db.all("events").map((event) => event.type);
}

/**
 * The forward event, written the way the product writes one.
 *
 * Through `recordEvent` rather than `ctx.db.insert("events", …)`: the ledger
 * has exactly one write path, `eslint.config.mjs` enforces that for every file
 * under `convex/`, and a test that seeded the table by hand would be the one
 * place in the repo where the append-only claim is made by something other
 * than the module that owns it. `at` is stamped by the ledger, so the seeded
 * row is a moment older than these assertions pretend — irrelevant here, where
 * what is asserted is which rows exist and in what order.
 */
async function seedEvent(ctx: FakeCtx, event: LedgerEvent): Promise<void> {
  await recordEvent(ctx as unknown as MutationCtx, event);
}

describe("reopenSession", () => {
  it("puts a session just ended back to live", async () => {
    const { ctx, seed } = await world();
    const sessionId = await seedSession(ctx, seed, {
      status: "ended",
      startedAt: Date.now() - HOUR,
      endedAt: Date.now() - MINUTE,
    });

    await reopen(ctx, sessionId);

    const session = await sessionRow(ctx, sessionId);
    expect(session.status).toBe("live");
    expect(session.endedAt).toBeUndefined();
  });

  it("leaves the write-up alone — a draft outlives the end it was written after", async () => {
    // The point of the whole design note: reopening is a status correction, not
    // a rollback. Someone who generated a synthesis and then reopened to add
    // ten more minutes should not find their draft gone.
    const { ctx, seed } = await world();
    const sessionId = await seedSession(ctx, seed, {
      status: "ended",
      endedAt: Date.now() - MINUTE,
      synthesis: "What the lab worked out.",
      synthesisApprovedAt: Date.now() - 30 * 1000,
    });

    await reopen(ctx, sessionId);

    const session = await sessionRow(ctx, sessionId);
    expect(session.synthesis).toBe("What the lab worked out.");
    expect(session.synthesisApprovedAt).toBeDefined();
  });

  it("still reopens at the last instant of the window", async () => {
    // The window is closed-ended, and which end it is closed on is a real
    // decision: someone pressing undo on the tenth minute is inside the toast
    // they were offered, not a second past it.
    const { ctx, seed } = await world();
    freezeClock();
    const sessionId = await seedSession(ctx, seed, {
      status: "ended",
      endedAt: Date.now() - UNDO_WINDOW,
    });

    await reopen(ctx, sessionId);

    expect((await sessionRow(ctx, sessionId)).status).toBe("live");
  });

  it("refuses one millisecond past the window", async () => {
    const { ctx, seed } = await world();
    const sessionId = await seedSession(ctx, seed, {
      status: "ended",
      endedAt: Date.now() - UNDO_WINDOW - 1,
    });

    await expect(reopen(ctx, sessionId)).rejects.toBeInstanceOf(ConvexError);
    expect((await sessionRow(ctx, sessionId)).status).toBe("ended");
  });

  it("refuses once the undo window has closed, and says that is why", async () => {
    // The copy is asserted because `instanceof ConvexError` is satisfied by
    // every other refusal in this handler too — a window guard that got
    // reordered behind the status check, or replaced by it, would still throw.
    const { ctx, seed } = await world();
    const sessionId = await seedSession(ctx, seed, {
      status: "ended",
      endedAt: Date.now() - 11 * MINUTE,
    });

    try {
      await reopen(ctx, sessionId);
      expect.unreachable("a session ended 11 minutes ago is past the window");
    } catch (caught) {
      expect(caught).toBeInstanceOf(ConvexError);
      // The phrase this handler alone can say: `restoreSession`'s lapse copy
      // is the same shape about a cancellation, and pinning only "more than
      // ten minutes ago" would pass if the two handlers swapped messages.
      expect((caught as ConvexError<string>).data).toContain(
        "ended more than ten minutes ago",
      );
    }
    expect((await sessionRow(ctx, sessionId)).status).toBe("ended");
  });

  it("refuses while a synthesis is being written, and says to wait", async () => {
    // The hand-off this branch exists to protect. Generate takes the lease and
    // the model call leaves the transaction; an undo pressed in that window
    // would move the session off `ended`, and `synthesis.store` only writes to
    // a session that has ended — so the run comes back to a refusal and a paid
    // call is thrown away with nothing on screen to say so.
    const { ctx, seed } = await world();
    const sessionId = await seedSession(ctx, seed, {
      status: "ended",
      endedAt: Date.now() - MINUTE,
      synthesisGeneratingAt: Date.now() - 10 * 1000,
      synthesisGeneratingLease: "lease-1",
    });

    try {
      await reopen(ctx, sessionId);
      expect.unreachable("a session mid-generation cannot be reopened");
    } catch (caught) {
      expect(caught).toBeInstanceOf(ConvexError);
      expect((caught as ConvexError<string>).data).toContain(
        "being written right now",
      );
    }
    expect((await sessionRow(ctx, sessionId)).status).toBe("ended");
  });

  it("reopens once a stale lease has expired", async () => {
    // The other side of the same guard, and the reason it is a window rather
    // than a flag: an action that died without releasing its lease must not
    // lock the undo out for good. Frozen, because this is a boundary — a
    // millisecond of drift here reads exactly like an off-by-one in the guard.
    const { ctx, seed } = await world();
    freezeClock();
    const sessionId = await seedSession(ctx, seed, {
      status: "ended",
      endedAt: Date.now() - MINUTE,
      synthesisGeneratingAt: Date.now() - GENERATION_LEASE,
      synthesisGeneratingLease: "lease-abandoned",
    });

    await reopen(ctx, sessionId);

    expect((await sessionRow(ctx, sessionId)).status).toBe("live");
  });

  it("refuses a session that never ended", async () => {
    const { ctx, seed } = await world();
    const sessionId = await seedSession(ctx, seed, { status: "scheduled" });

    await expect(reopen(ctx, sessionId)).rejects.toBeInstanceOf(ConvexError);
    expect((await sessionRow(ctx, sessionId)).status).toBe("scheduled");
  });

  it("says where the session actually is when it refuses", async () => {
    const { ctx, seed } = await world();
    const sessionId = await seedSession(ctx, seed, { status: "scheduled" });

    try {
      await reopen(ctx, sessionId);
      expect.unreachable("a scheduled session cannot be reopened");
    } catch (caught) {
      expect((caught as ConvexError<string>).data).toContain(
        "hasn't started yet",
      );
    }
  });

  it("refuses somebody who is neither presenter, scheduler, nor PI", async () => {
    const { ctx, seed } = await world();
    const sessionId = await seedSession(ctx, seed, {
      status: "ended",
      endedAt: Date.now() - MINUTE,
    });
    ctx.auth = { userId: seed.member };

    await expect(reopen(ctx, sessionId)).rejects.toBeInstanceOf(ConvexError);
    expect((await sessionRow(ctx, sessionId)).status).toBe("ended");
  });

  it("appends the compensating event and leaves the end on the record", async () => {
    const { ctx, seed } = await world();
    const sessionId = await seedSession(ctx, seed, {
      status: "ended",
      endedAt: Date.now() - MINUTE,
    });
    // The forward event as `endSession` would have written it. The undo adds a
    // second fact; it must not reach back for the first.
    await seedEvent(ctx, {
      labId: seed.labId,
      type: "session.ended",
      actorId: seed.pi,
      paperId: seed.paperId,
      sessionId,
    });

    await reopen(ctx, sessionId);

    expect(eventTypes(ctx)).toEqual(["session.ended", "session.reopened"]);
  });
});

describe("restoreSession", () => {
  it("puts a cancelled session back on the calendar", async () => {
    const { ctx, seed } = await world();
    const sessionId = await seedSession(ctx, seed, {
      status: "cancelled",
      cancelledAt: Date.now() - MINUTE,
    });

    await restore(ctx, sessionId);

    const session = await sessionRow(ctx, sessionId);
    expect(session.status).toBe("scheduled");
    expect(session.cancelledAt).toBeUndefined();
  });

  it("re-arms the prep digest cancelling threw away", async () => {
    const { ctx, seed } = await world();
    const sessionId = await seedSession(ctx, seed, {
      status: "cancelled",
      scheduledAt: Date.now() + 24 * HOUR,
      cancelledAt: Date.now() - MINUTE,
    });

    await restore(ctx, sessionId);

    expect((await sessionRow(ctx, sessionId)).prepDigestJobId).toBeDefined();
  });

  it("arms nothing for a meeting whose time has already passed", async () => {
    // Same call `createSession` refuses outright: there is no prep left to do
    // for a session whose hour is behind the lab, and a job armed now would
    // fire a "coming up in two hours" digest about yesterday.
    const { ctx, seed } = await world();
    const sessionId = await seedSession(ctx, seed, {
      status: "cancelled",
      scheduledAt: Date.now() - 2 * HOUR,
      cancelledAt: Date.now() - MINUTE,
    });

    await restore(ctx, sessionId);

    const session = await sessionRow(ctx, sessionId);
    expect(session.status).toBe("scheduled");
    expect(session.prepDigestJobId).toBeUndefined();
  });

  it("refuses when the lab's calendar is already full", async () => {
    // The way around the ceiling that an unchecked undo opens: a lab at fifty
    // cancels one, schedules its replacement, and restores the cancelled one.
    // `seedLab` leaves one scheduled session behind, so the fill is one short.
    const { ctx, seed } = await world();
    for (let i = 0; i < MAX_SCHEDULED - 1; i++) {
      await seedSession(ctx, seed, { status: "scheduled" });
    }
    const sessionId = await seedSession(ctx, seed, {
      status: "cancelled",
      cancelledAt: Date.now() - MINUTE,
    });

    try {
      await restore(ctx, sessionId);
      expect.unreachable("a lab at the ceiling cannot restore a fifty-first");
    } catch (caught) {
      expect(caught).toBeInstanceOf(ConvexError);
      expect((caught as ConvexError<string>).data).toContain(
        `already has ${MAX_SCHEDULED} sessions on the calendar`,
      );
    }
    expect((await sessionRow(ctx, sessionId)).status).toBe("cancelled");
  });

  it("restores the one that takes the lab back up to the ceiling", async () => {
    // One below, which is the case the cap must not eat: cancelling is what
    // freed the slot, and the undo is entitled to the slot it freed.
    const { ctx, seed } = await world();
    for (let i = 0; i < MAX_SCHEDULED - 2; i++) {
      await seedSession(ctx, seed, { status: "scheduled" });
    }
    const sessionId = await seedSession(ctx, seed, {
      status: "cancelled",
      cancelledAt: Date.now() - MINUTE,
    });

    await restore(ctx, sessionId);

    expect((await sessionRow(ctx, sessionId)).status).toBe("scheduled");
  });

  it("still restores at the last instant of the window", async () => {
    const { ctx, seed } = await world();
    freezeClock();
    const sessionId = await seedSession(ctx, seed, {
      status: "cancelled",
      cancelledAt: Date.now() - UNDO_WINDOW,
      scheduledAt: Date.now() + 24 * HOUR,
    });

    await restore(ctx, sessionId);

    expect((await sessionRow(ctx, sessionId)).status).toBe("scheduled");
  });

  it("refuses one millisecond past the window", async () => {
    const { ctx, seed } = await world();
    const sessionId = await seedSession(ctx, seed, {
      status: "cancelled",
      cancelledAt: Date.now() - UNDO_WINDOW - 1,
    });

    await expect(restore(ctx, sessionId)).rejects.toBeInstanceOf(ConvexError);
    expect((await sessionRow(ctx, sessionId)).status).toBe("cancelled");
  });

  it("refuses once the undo window has closed, and says that is why", async () => {
    const { ctx, seed } = await world();
    const sessionId = await seedSession(ctx, seed, {
      status: "cancelled",
      cancelledAt: Date.now() - 11 * MINUTE,
    });

    try {
      await restore(ctx, sessionId);
      expect.unreachable("a session cancelled 11 minutes ago is past the window");
    } catch (caught) {
      expect(caught).toBeInstanceOf(ConvexError);
      expect((caught as ConvexError<string>).data).toContain(
        "was cancelled more than ten minutes ago",
      );
    }
    expect((await sessionRow(ctx, sessionId)).status).toBe("cancelled");
  });

  it("refuses a session that was never cancelled", async () => {
    const { ctx, seed } = await world();
    const sessionId = await seedSession(ctx, seed, {
      status: "live",
      startedAt: Date.now() - MINUTE,
    });

    await expect(restore(ctx, sessionId)).rejects.toBeInstanceOf(ConvexError);
    expect((await sessionRow(ctx, sessionId)).status).toBe("live");
  });

  it("refuses somebody who is neither presenter, scheduler, nor PI", async () => {
    const { ctx, seed } = await world();
    const sessionId = await seedSession(ctx, seed, {
      status: "cancelled",
      cancelledAt: Date.now() - MINUTE,
    });
    ctx.auth = { userId: seed.member };

    await expect(restore(ctx, sessionId)).rejects.toBeInstanceOf(ConvexError);
    expect((await sessionRow(ctx, sessionId)).status).toBe("cancelled");
  });

  it("appends the compensating event and leaves the cancellation on the record", async () => {
    const { ctx, seed } = await world();
    const sessionId = await seedSession(ctx, seed, {
      status: "cancelled",
      cancelledAt: Date.now() - MINUTE,
    });
    await seedEvent(ctx, {
      labId: seed.labId,
      type: "session.cancelled",
      actorId: seed.pi,
      paperId: seed.paperId,
      sessionId,
    });

    await restore(ctx, sessionId);

    expect(eventTypes(ctx)).toEqual(["session.cancelled", "session.restored"]);
  });
});

describe("the start-window refusal", () => {
  it("reads as one sentence about the distance, not two halves of one", async () => {
    // Locks the copy Task 1 landed. `awayProse` returns "about 25 hours away",
    // which only reads as English after "is still". The regression to guard is
    // the earlier phrasing, where "isn't until" met the same distance string
    // and produced "isn't until in about 25 hours away".
    const { ctx, seed } = await world();
    const sessionId = await seedSession(ctx, seed, {
      status: "scheduled",
      scheduledAt: Date.now() + 48 * HOUR,
    });

    try {
      await handlerOf(startSession)(ctx, { sessionId } as never);
      expect.unreachable("a session two days out cannot be started");
    } catch (caught) {
      const message = (caught as ConvexError<string>).data;
      expect(message).toContain("is still about");
      expect(message).not.toContain("isn't until in");
    }
  });
});
