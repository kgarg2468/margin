import { describe, expect, it } from "vitest";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { FakeCtx } from "./delegations.fixtures";
import { ensurePersonalLibrary, personalLibraryName } from "./labs";
import { seedDemoPaper } from "./seedDemo";
import { DEMO_ANCHORS, DEMO_PAGES } from "./seedDemoPaper.data";

/**
 * What a personal library is, and what the demo paper in it is not allowed to
 * touch.
 *
 * The provisioning itself is small enough to read in one sitting; almost
 * everything below is about the second half of that sentence. A seeded paper is
 * the only content in this product that nobody asked for, so the ways it could
 * turn up somewhere it was never wanted are the tests worth having — and every
 * one of them is a structural property rather than a filter, which is precisely
 * what makes it assertable here.
 */

/** A signed-in-from-nowhere account, the state the auth callback hands over. */
async function newAccount(ctx: FakeCtx, name: string): Promise<Id<"users">> {
  return await ctx.db.insert("users", { name, email: `${name}@example.edu` });
}

/** The deployment has been seeded: one stored blob, filed. */
async function withCanonicalPdf(ctx: FakeCtx): Promise<Id<"_storage">> {
  const storageId = "storage_demo" as Id<"_storage">;
  await ctx.db.insert("demoSeeds", {
    storageId,
    revision: 1,
    seededAt: 1,
  });
  return storageId;
}

function asMutationCtx(ctx: FakeCtx): MutationCtx {
  return ctx as unknown as MutationCtx;
}

describe("naming a library nobody was asked to name", () => {
  it("makes a possessive out of the name already on every note", () => {
    expect(personalLibraryName("Ada Okonkwo")).toBe("Ada Okonkwo’s library");
  });

  it("does not double the s on a name that ends in one", () => {
    expect(personalLibraryName("James")).toBe("James’ library");
  });

  it("falls back to a name with no owner in it rather than a bare possessive", () => {
    // A sign-in link creates an account with an address and, for an instant,
    // no name at all. "’s library" is the wrong thing to put on a shelf.
    expect(personalLibraryName(undefined)).toBe("My library");
    expect(personalLibraryName("   ")).toBe("My library");
  });
});

describe("provisioning", () => {
  it("gives a new account a lab it is the sole PI of, without asking", async () => {
    const ctx = new FakeCtx();
    const userId = await newAccount(ctx, "Ada");

    const labId = await ensurePersonalLibrary(asMutationCtx(ctx), userId);

    const labs = ctx.db.all("labs");
    expect(labs).toHaveLength(1);
    expect(labs[0]?._id).toBe(labId);
    expect(labs[0]?.personalFor).toBe(userId);
    expect(labs[0]?.memberCount).toBe(1);

    const memberships = ctx.db.all("memberships");
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe("pi");
    expect(memberships[0]?.userId).toBe(userId);
  });

  it("is idempotent, because the callback that drives it fires more than once", async () => {
    const ctx = new FakeCtx();
    const userId = await newAccount(ctx, "Ada");
    await withCanonicalPdf(ctx);

    const first = await ensurePersonalLibrary(asMutationCtx(ctx), userId);
    const second = await ensurePersonalLibrary(asMutationCtx(ctx), userId);

    expect(second).toBe(first);
    expect(ctx.db.all("labs")).toHaveLength(1);
    expect(ctx.db.all("memberships")).toHaveLength(1);
    // The half that would be worst to get wrong: a second demo paper, and a
    // second set of notes, in a library the reader has already started using.
    expect(ctx.db.all("papers")).toHaveLength(1);
  });

  it("answers the question through the index that makes it cheap", async () => {
    const ctx = new FakeCtx();
    const userId = await newAccount(ctx, "Ada");
    await ensurePersonalLibrary(asMutationCtx(ctx), userId);

    const read = ctx.db.lastReadOf("by_personal_for");
    expect(read).toBeDefined();
    expect(read?.table).toBe("labs");
  });

  it("does not reach for somebody else's personal library", async () => {
    const ctx = new FakeCtx();
    const ada = await newAccount(ctx, "Ada");
    const ben = await newAccount(ctx, "Ben");

    const adaLab = await ensurePersonalLibrary(asMutationCtx(ctx), ada);
    const benLab = await ensurePersonalLibrary(asMutationCtx(ctx), ben);

    expect(benLab).not.toBe(adaLab);
    expect(ctx.db.all("labs")).toHaveLength(2);
  });

  it("provisions an empty library when the deployment was never seeded", async () => {
    // The degradation that matters: a deployment where nobody ran
    // `seedDemo:seedCanonicalPdf` still signs people up. It just has nothing
    // to put on the shelf.
    const ctx = new FakeCtx();
    const userId = await newAccount(ctx, "Ada");

    await ensurePersonalLibrary(asMutationCtx(ctx), userId);

    expect(ctx.db.all("papers")).toHaveLength(0);
    expect(ctx.db.all("annotations")).toHaveLength(0);
    expect(ctx.db.all("labs")).toHaveLength(1);
  });
});

describe("the seeded paper", () => {
  it("points at the deployment's one stored copy rather than a new upload", async () => {
    const ctx = new FakeCtx();
    const userId = await newAccount(ctx, "Ada");
    const storageId = await withCanonicalPdf(ctx);

    await ensurePersonalLibrary(asMutationCtx(ctx), userId);
    const ben = await newAccount(ctx, "Ben");
    await ensurePersonalLibrary(asMutationCtx(ctx), ben);

    const papers = ctx.db.all("papers");
    expect(papers).toHaveLength(2);
    // Both libraries, one blob. Storing a copy per signup is the thing this
    // whole `demoSeeds` table exists to avoid.
    expect(papers.map((paper) => paper.storageId)).toEqual([
      storageId,
      storageId,
    ]);
    expect(ctx.stored).toHaveLength(0);
  });

  it("arrives readable, with its text layer already in", async () => {
    const ctx = new FakeCtx();
    const userId = await newAccount(ctx, "Ada");
    await withCanonicalPdf(ctx);

    await ensurePersonalLibrary(asMutationCtx(ctx), userId);

    const paper = ctx.db.all("papers")[0];
    // `ready` is the one state the margins can be written in, and it would be
    // a lie without the pages below — `ingestStateFor` draws the same line.
    expect(paper?.ingestStatus).toBe("ready");
    expect(paper?.pageCount).toBe(DEMO_PAGES.length);

    const pages = ctx.db.all("paperPages");
    expect(pages).toHaveLength(DEMO_PAGES.length);
    expect(pages.map((page) => page.text)).toEqual([...DEMO_PAGES]);
  });

  it("hangs every note off a passage that is really there", async () => {
    // The failure this catches is silent and total: regenerate the text layer
    // from a different PDF, or re-wrap it by hand, and every stored offset
    // still points *somewhere* — a few words off the sentence it names, on
    // every seeded highlight, in every library ever provisioned after.
    for (const [key, anchor] of Object.entries(DEMO_ANCHORS)) {
      const page = DEMO_PAGES[anchor.pageIndex];
      expect(page, `${key} names page ${anchor.pageIndex}`).toBeDefined();
      expect(page?.slice(anchor.start, anchor.end), key).toBe(anchor.quote);
      // And it names one passage, not a phrase the paper happens to repeat —
      // a fuzzy re-anchor against the reader's own extraction has to have one
      // candidate to land on.
      expect(page?.indexOf(anchor.quote), key).toBe(anchor.start);
      expect(page?.indexOf(anchor.quote, anchor.start + 1), key).toBe(-1);
    }
  });

  it("puts a thread in the margin, not just a pile of highlights", async () => {
    const ctx = new FakeCtx();
    const userId = await newAccount(ctx, "Ada");
    await withCanonicalPdf(ctx);

    await ensurePersonalLibrary(asMutationCtx(ctx), userId);

    const notes = ctx.db.all("annotations");
    expect(notes.length).toBeGreaterThan(1);
    const replies = notes.filter((note) => note.parentId !== undefined);
    // A margin with no reply in it demonstrates highlighting. The reply is
    // what demonstrates the thing the product is for.
    expect(replies.length).toBeGreaterThan(0);
    for (const reply of replies) {
      expect(notes.some((note) => note._id === reply.parentId)).toBe(true);
    }
  });
});

describe("what the seeding is not allowed to leak into", () => {
  it("writes no ledger event naming the paper or any note on it", async () => {
    // This is the catch-up digest's exclusion, and it is structural rather
    // than a filter. `digests.catchUp` builds its pool by reading `events` for
    // the lab and scanning the papers those events name — so a paper no event
    // mentions cannot enter the pool, cannot produce a digest line, and cannot
    // be paired by the cross-paper collision scan that runs over it.
    const ctx = new FakeCtx();
    const userId = await newAccount(ctx, "Ada");
    await withCanonicalPdf(ctx);

    const labId = await ensurePersonalLibrary(asMutationCtx(ctx), userId);
    const paperId = ctx.db.all("papers")[0]?._id;

    const events = ctx.db.all("events");
    for (const event of events) {
      expect(event).not.toHaveProperty("annotationId");
      expect((event as { paperId?: unknown }).paperId).toBeUndefined();
    }
    // The lab's own founding is still recorded — a library that exists is a
    // lab that exists, and those events name no paper.
    expect(events.map((event) => event.type).sort()).toEqual([
      "lab.created",
      "member.joined",
    ]);
    expect(events.every((event) => event.labId === labId)).toBe(true);
    expect(paperId).toBeDefined();
  });

  it("writes every seeded note private, which is what the rest of the backend reads past", async () => {
    // The load-bearing assertion in this file.
    //
    // Every derived surface here is defined as a read of
    // `by_paper_and_visibility` at "lab": the digest pool, the brief's
    // neighbour scan in `briefs.ts`, `delegations.gatherLabVisible` for the
    // scout, and the synthesis pool. None of them filters afterwards — the
    // codebase's own phrasing is "privacy is the index, not a filter" — so a
    // private note is outside all four by construction, with no exclusion
    // clause anywhere to add and none to forget.
    //
    // If this ever goes green with "lab" in it, seeded content is reachable by
    // the scout and every one of those exclusions has to be written by hand.
    const ctx = new FakeCtx();
    const userId = await newAccount(ctx, "Ada");
    await withCanonicalPdf(ctx);

    await ensurePersonalLibrary(asMutationCtx(ctx), userId);

    const notes = ctx.db.all("annotations");
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) {
      expect(note.visibility).toBe("private");
    }
  });

  it("attributes every note to the library's own owner, so they are readable at all", async () => {
    // The other half of the bargain above. `annotations.listForPaper` returns
    // the lab's shared notes plus *the caller's own* — so a private note by
    // anyone else would be a note nobody could ever read.
    const ctx = new FakeCtx();
    const userId = await newAccount(ctx, "Ada");
    await withCanonicalPdf(ctx);

    const labId = await ensurePersonalLibrary(asMutationCtx(ctx), userId);

    for (const note of ctx.db.all("annotations")) {
      expect(note.memberId).toBe(userId);
      expect(note.labId).toBe(labId);
    }
    expect(ctx.db.all("papers")[0]?.addedBy).toBe(userId);
  });

  it("mentions nobody, so nothing it contains can become email", async () => {
    const ctx = new FakeCtx();
    const userId = await newAccount(ctx, "Ada");
    await withCanonicalPdf(ctx);

    await ensurePersonalLibrary(asMutationCtx(ctx), userId);

    for (const note of ctx.db.all("annotations")) {
      expect(note.mentions).toBeUndefined();
    }
  });

  it("schedules nothing", async () => {
    // Provisioning is one transaction and finishes inside it. A scheduled job
    // here would be a signup that half-succeeds and an action running against
    // a library whose owner may never come back.
    const ctx = new FakeCtx();
    const userId = await newAccount(ctx, "Ada");
    await withCanonicalPdf(ctx);

    await ensurePersonalLibrary(asMutationCtx(ctx), userId);

    expect(ctx.scheduled).toEqual([]);
  });
});

describe("seeding a library directly", () => {
  it("answers null rather than throwing when there is nothing to seed", async () => {
    const ctx = new FakeCtx();
    const userId = await newAccount(ctx, "Ada");
    const labId = await ctx.db.insert("labs", {
      name: "Ruiz Lab",
      createdBy: userId,
      memberCount: 1,
    });

    expect(await seedDemoPaper(asMutationCtx(ctx), labId, userId)).toBeNull();
  });
});
