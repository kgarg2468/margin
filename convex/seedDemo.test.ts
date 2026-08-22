import { describe, expect, it, vi } from "vitest";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { FakeCtx, handlerOf } from "./delegations.fixtures";
import * as labs from "./labs";
import { ensurePersonalLibrary, personalLibraryName } from "./labs";
import * as papers from "./papers";
import { seedDemoPaper, sha256Hex } from "./seedDemo";
import { DEMO_ANCHORS, DEMO_PAGES } from "./seedDemoPaper.data";

vi.mock("@convex-dev/auth/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@convex-dev/auth/server")>()),
  getAuthUserId: async (ctx: unknown) =>
    (ctx as { auth?: { userId?: string } }).auth?.userId ?? null,
}));

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

    const { labId, created } = await ensurePersonalLibrary(
      asMutationCtx(ctx),
      userId,
    );
    expect(created).toBe(true);

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

  it("is idempotent, because every arrival at the app asks it again", async () => {
    const ctx = new FakeCtx();
    const userId = await newAccount(ctx, "Ada");
    await withCanonicalPdf(ctx);

    const first = await ensurePersonalLibrary(asMutationCtx(ctx), userId);
    const second = await ensurePersonalLibrary(asMutationCtx(ctx), userId);

    expect(second.labId).toBe(first.labId);
    // Only the arrival that actually minted it may claim to have done so: this
    // is the flag `/app` routes a brand-new account on, and a second sign-in
    // reporting `created` would reopen the add panel over a working library.
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
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

    expect(benLab.labId).not.toBe(adaLab.labId);
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

  it("seeds no reply, because a private one is a state the product cannot reach", async () => {
    // `annotations.reply` refuses a parent that isn't shared with the lab and
    // always writes the child `visibility: "lab"`. A private reply under a
    // private parent is therefore a row no member could ever have produced —
    // and the reader gives child cards no edit or withdraw control, so the
    // owner would be left with a note in their own name that they could
    // neither change nor get rid of.
    //
    // Sharing the pair instead would hand the seeded content to the digest,
    // the brief, the scout and the synthesis, which is the one thing this file
    // exists to prevent. So the answer is a second top-level note on the same
    // passage, and every seeded row stays something `annotations.create`
    // writes.
    const ctx = new FakeCtx();
    const userId = await newAccount(ctx, "Ada");
    await withCanonicalPdf(ctx);

    await ensurePersonalLibrary(asMutationCtx(ctx), userId);

    const notes = ctx.db.all("annotations");
    expect(notes.length).toBeGreaterThan(1);
    for (const note of notes) {
      expect(note.parentId).toBeUndefined();
    }
  });

  it("still puts two notes on one passage, which is what the thread was for", async () => {
    const ctx = new FakeCtx();
    const userId = await newAccount(ctx, "Ada");
    await withCanonicalPdf(ctx);

    await ensurePersonalLibrary(asMutationCtx(ctx), userId);

    const perQuote = new Map<string, number>();
    for (const note of ctx.db.all("annotations")) {
      const quote = note.anchor.quote;
      perQuote.set(quote, (perQuote.get(quote) ?? 0) + 1);
    }
    // A question and, further down the same margin, a partial answer to it.
    expect([...perQuote.values()].some((count) => count > 1)).toBe(true);
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

    const { labId } = await ensurePersonalLibrary(asMutationCtx(ctx), userId);
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

    const { labId } = await ensurePersonalLibrary(asMutationCtx(ctx), userId);

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

describe("pinning the file the anchors were measured against", () => {
  it("hex-encodes a digest the way the published vectors do", async () => {
    // NIST's SHA-256 vector for "abc". The constant this helper is compared
    // against was taken with `shasum -a 256`, so the two have to agree about
    // encoding or the pin rejects the very file it was made from.
    const abc = new TextEncoder().encode("abc");
    expect(await sha256Hex(abc.buffer as ArrayBuffer)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("pads a byte that hexes to one digit", async () => {
    // The empty string's digest begins `e3b0c442…` and contains `0x0b`. Without
    // `padStart` this returns 63 characters and every comparison fails.
    const digest = await sha256Hex(new ArrayBuffer(0));
    expect(digest).toHaveLength(64);
    expect(digest).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("who gets a library, now that a session is required to ask", () => {
  /**
   * The provisioning used to run in `afterUserCreatedOrUpdated`, and the reason
   * it no longer does is worth stating where it can be checked: requesting an
   * emailed sign-in link creates the user row *before the mail is sent*, so that
   * callback fired with `existingUserId === null` for any address a stranger
   * cared to type. A lab, a membership, two ledger events and a seeded paper,
   * from an unauthenticated POST, in a loop.
   *
   * `labs.ensureMyLibrary` needs a caller. These are the rules it applies once
   * it has one.
   */
  const callEnsureMyLibrary = async (ctx: FakeCtx) =>
    (await handlerOf(labs.ensureMyLibrary)(ctx, {} as never)) as {
      labId: Id<"labs">;
      created: boolean;
    } | null;

  it("refuses a caller with no session at all", async () => {
    const ctx = new FakeCtx();

    await expect(callEnsureMyLibrary(ctx)).rejects.toThrow();
    expect(ctx.db.all("labs")).toHaveLength(0);
  });

  it("provisions for an account that belongs nowhere", async () => {
    const ctx = new FakeCtx();
    const userId = await newAccount(ctx, "Ada");
    await withCanonicalPdf(ctx);
    ctx.auth.userId = userId;

    const outcome = await callEnsureMyLibrary(ctx);

    expect(outcome?.created).toBe(true);
    expect(ctx.db.all("labs")).toHaveLength(1);
    expect(ctx.db.all("papers")).toHaveLength(1);
  });

  it("says created only once, however many times the app arrives", async () => {
    const ctx = new FakeCtx();
    const userId = await newAccount(ctx, "Ada");
    await withCanonicalPdf(ctx);
    ctx.auth.userId = userId;

    const first = await callEnsureMyLibrary(ctx);
    const second = await callEnsureMyLibrary(ctx);

    expect(first?.created).toBe(true);
    expect(second?.created).toBe(false);
    expect(second?.labId).toBe(first?.labId);
    expect(ctx.db.all("labs")).toHaveLength(1);
    expect(ctx.db.all("papers")).toHaveLength(1);
  });

  it("leaves an account that already belongs to a lab exactly as it was", async () => {
    // The regression that would be noticed by everybody at once: people who
    // have used Margin for a year signing in one morning to a second library
    // and a paper they never added. Backfilling them is an operator's decision,
    // not something a sign-in does behind their back.
    const ctx = new FakeCtx();
    const userId = await newAccount(ctx, "Elena");
    await withCanonicalPdf(ctx);
    const labId = await ctx.db.insert("labs", {
      name: "Computational Memory Lab",
      createdBy: userId,
      memberCount: 2,
    });
    await ctx.db.insert("memberships", {
      labId,
      userId,
      role: "pi",
      joinedAt: 1,
    });
    ctx.auth.userId = userId;

    expect(await callEnsureMyLibrary(ctx)).toBeNull();
    expect(ctx.db.all("labs")).toHaveLength(1);
    expect(ctx.db.all("papers")).toHaveLength(0);
    expect(ctx.db.all("annotations")).toHaveLength(0);
  });

  it("still answers the library of somebody who has since joined real labs", async () => {
    // The personal library is found by `by_personal_for`, not by whichever
    // membership happens to come back first — otherwise the answer for a
    // two-lab member would depend on insertion order.
    const ctx = new FakeCtx();
    const userId = await newAccount(ctx, "Ada");
    await withCanonicalPdf(ctx);
    ctx.auth.userId = userId;
    const mine = await callEnsureMyLibrary(ctx);

    const other = await ctx.db.insert("labs", {
      name: "Reyes Lab",
      createdBy: userId,
      memberCount: 2,
    });
    await ctx.db.insert("memberships", {
      labId: other,
      userId,
      role: "member",
      joinedAt: 2,
    });

    const again = await callEnsureMyLibrary(ctx);
    expect(again?.labId).toBe(mine?.labId);
    expect(again?.created).toBe(false);
  });
});

describe("the blob every library points at", () => {
  /**
   * One stored file, referenced by every provisioned copy — which means the
   * question "may I delete this PDF" stopped being answerable from one paper's
   * row on the day P4 shipped. `papers.attachPdf` answered it from one row
   * anyway: replacing the file on your own demo paper deleted the bytes out from
   * under every other library, leaving each of them a `ready` paper that renders
   * as a broken download, discoverable only by somebody opening one.
   */
  const attachPdf = handlerOf(papers.attachPdf);
  const discardUpload = handlerOf(papers.discardUpload);

  /** A member, their library, and the demo paper on its shelf. */
  async function seededLibrary(ctx: FakeCtx, name: string) {
    const userId = await newAccount(ctx, name);
    const { labId } = await ensurePersonalLibrary(asMutationCtx(ctx), userId);
    const paper = ctx.db
      .all("papers")
      .filter((row) => row.labId === labId)
      .at(0);
    return { userId, labId, paperId: paper?._id as Id<"papers"> };
  }

  /** A fresh upload, declared to the platform the way a real one would be. */
  function upload(ctx: FakeCtx, id: string): Id<"_storage"> {
    ctx.db.putSystem(id, { contentType: "application/pdf", size: 1000 });
    return id as Id<"_storage">;
  }

  it("keeps the shared copy when one library swaps its own file", async () => {
    const ctx = new FakeCtx();
    const shared = await withCanonicalPdf(ctx);
    const ada = await seededLibrary(ctx, "Ada");
    await seededLibrary(ctx, "Ben");

    ctx.auth.userId = ada.userId;
    await attachPdf(ctx, {
      paperId: ada.paperId,
      storageId: upload(ctx, "storage_ada_replacement"),
      pages: ["a new text layer"],
    } as never);

    // Ben's copy is still readable, which it would not be if the delete had
    // gone through on Ada's say-so.
    expect(ctx.discarded).not.toContain(shared as string);
    const bens = ctx.db
      .all("papers")
      .filter((row) => row.addedBy !== ada.userId);
    expect(bens).toHaveLength(1);
    expect(bens[0]?.storageId).toBe(shared);
  });

  it("still collects a file genuinely nobody is using", async () => {
    // The guard has to stay a guard and not become a leak: an ordinary
    // replacement, on a blob no one else claims, must still free the bytes.
    const ctx = new FakeCtx();
    await withCanonicalPdf(ctx);
    const ada = await seededLibrary(ctx, "Ada");

    ctx.auth.userId = ada.userId;
    const first = upload(ctx, "storage_ada_one");
    await attachPdf(ctx, {
      paperId: ada.paperId,
      storageId: first,
      pages: ["one"],
    } as never);
    await attachPdf(ctx, {
      paperId: ada.paperId,
      storageId: upload(ctx, "storage_ada_two"),
      pages: ["two"],
    } as never);

    expect(ctx.discarded).toContain("storage_ada_one");
  });

  it("refuses to discard the canonical copy before the first signup claims it", async () => {
    // The window nothing else covers. Between seeding a deployment and its
    // first provisioned library, no `papers` row points at the canonical blob
    // at all — so a `by_pdf_storage` check alone would call it garbage.
    const ctx = new FakeCtx();
    const shared = await withCanonicalPdf(ctx);
    const userId = await newAccount(ctx, "Ada");
    const labId = await ctx.db.insert("labs", {
      name: "Reyes Lab",
      createdBy: userId,
      memberCount: 1,
    });
    await ctx.db.insert("memberships", {
      labId,
      userId,
      role: "pi",
      joinedAt: 1,
    });
    ctx.auth.userId = userId;

    await discardUpload(ctx, { labId, storageId: shared } as never);

    expect(ctx.discarded).toEqual([]);
  });
});
