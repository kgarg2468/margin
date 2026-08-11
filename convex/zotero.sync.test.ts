import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { FakeCtx, handlerOf, seedLab } from "./delegations.fixtures";
import {
  SYNC_PAGE_ITEMS,
  commitPage,
  dueLinks,
  markSwept,
  newAmong,
  sweep,
  syncLink,
  syncPayload,
} from "./zotero";

vi.mock("@convex-dev/auth/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@convex-dev/auth/server")>()),
  getAuthUserId: async (ctx: unknown) =>
    (ctx as { auth?: { userId?: string } }).auth?.userId ?? null,
}));

/**
 * A sync that cannot run away.
 *
 * Everything here is a boundary, and every one of them is a thing that looks
 * fine in a browser with a forty-item test library and takes the product down
 * against a real one. A run that walks a whole four-thousand-item library. A
 * dedupe that reads the lab's shelf once per candidate. A cursor that advances
 * past items it never imported. A `lastVersion` that jumps to *now* halfway
 * through a walk and silently drops every edit made during it. A key replaced
 * while a run was in flight, writing papers under a credential the member has
 * already revoked.
 *
 * The library size is the risk the whole feature stands on: `listPapers` reads
 * a lab's shelf under one `take(200)` (`convex/papers.ts:570-578`, and
 * `convex/schema.ts:1150-1165` on why), and a real Zotero library is ten to
 * fifty times that. The cap and the collection scope are what make a first
 * version honest, and these are the tests that hold them.
 */

const KEY = "P9NiFoyLeZu2bZNvvuQPDWsd";
const HOUR = 60 * 60 * 1000;

/** One item as `/items/top` returns it. */
function item(n: number, over: Record<string, unknown> = {}) {
  return {
    key: `ITEM${String(n).padStart(4, "0")}`,
    version: 8000 + n,
    data: {
      key: `ITEM${String(n).padStart(4, "0")}`,
      itemType: "journalArticle",
      title: `Paper number ${n}`,
      creators: [{ creatorType: "author", firstName: "Ana", lastName: "Ruiz" }],
      date: "2024",
      ...over,
    },
  };
}

type Stub = { status: number; body?: unknown; headers?: Record<string, string>; bytes?: string };

function stubFetch(answers: Stub[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const queue = [...answers];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (next === undefined) throw new Error(`unexpected fetch: ${url}`);
    if (next.bytes !== undefined) {
      return new Response(next.bytes, {
        status: next.status,
        headers: { "content-type": "application/pdf", ...next.headers },
      });
    }
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: next.headers,
    });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

/** A lab with one member whose Zotero library is linked and never walked. */
async function linkedWorld(over: Record<string, unknown> = {}) {
  const ctx = new FakeCtx();
  const seed = await seedLab(ctx);
  ctx.auth = { userId: seed.pi };
  ctx
    .register(internal.zotero.syncPayload, syncPayload)
    .register(internal.zotero.newAmong, newAmong)
    .register(internal.zotero.commitPage, commitPage)
    .register(internal.zotero.markSwept, markSwept);
  const linkId = await ctx.db.insert("zoteroLinks", {
    userId: seed.pi,
    labId: seed.labId,
    apiKey: KEY,
    connectedAt: 1_000,
    libraryType: "user",
    libraryId: "475425",
    collectionKey: "C0LL3CTN",
    ...over,
  });
  return { ctx, seed, linkId };
}

const run = (ctx: FakeCtx, linkId: Id<"zoteroLinks">) =>
  handlerOf(syncLink)(ctx, { linkId } as never);

const link = (ctx: FakeCtx) => ctx.db.all("zoteroLinks")[0];
const papers = (ctx: FakeCtx) =>
  ctx.db.all("papers").filter((p) => p.zoteroItemKey !== undefined);

/** A page of `n` items with the headers Zotero sends. */
const page = (items: unknown[], total: number, version = 8431): Stub => ({
  status: 200,
  body: items,
  headers: {
    "Last-Modified-Version": String(version),
    "Total-Results": String(total),
  },
});

/** No attachments on this item. */
const noChildren: Stub = { status: 200, body: [] };

describe("one run is bounded", () => {
  it("never asks Zotero for more than a page at a time", async () => {
    const { ctx, linkId } = await linkedWorld();
    const calls = stubFetch([
      page(Array.from({ length: SYNC_PAGE_ITEMS }, (_, i) => item(i)), 4_000),
      ...Array.from({ length: SYNC_PAGE_ITEMS }, () => noChildren),
    ]);
    await run(ctx, linkId);

    const url = new URL(calls[0]?.url ?? "");
    expect(url.searchParams.get("limit")).toBe(String(SYNC_PAGE_ITEMS));
    expect(SYNC_PAGE_ITEMS).toBeLessThanOrEqual(50);
  });

  it("imports a page out of a four-thousand-item library and stops", async () => {
    // The whole point. A naive full walk here is four thousand items, four
    // thousand children requests and a shelf `listPapers` cannot list.
    const { ctx, linkId } = await linkedWorld();
    stubFetch([
      page(Array.from({ length: SYNC_PAGE_ITEMS }, (_, i) => item(i)), 4_000),
      ...Array.from({ length: SYNC_PAGE_ITEMS }, () => noChildren),
    ]);
    await run(ctx, linkId);

    expect(papers(ctx)).toHaveLength(SYNC_PAGE_ITEMS);
    expect(link(ctx)?.syncCursor).toEqual({
      targetVersion: 8431,
      start: SYNC_PAGE_ITEMS,
      total: 4_000,
      imported: SYNC_PAGE_ITEMS,
    });
    // And the walk is not finished, so the version counter has not moved.
    expect(link(ctx)?.lastVersion).toBeUndefined();
  });

  it("picks the walk up where it left off", async () => {
    // A full page, because a short one means something else entirely — see the
    // test below it. This is the middle of a walk: the request resumes at the
    // offset the cursor holds and the cursor advances by what this run walked.
    const { ctx, linkId } = await linkedWorld({
      syncCursor: { targetVersion: 8431, start: 25, total: 60, imported: 25 },
    });
    const calls = stubFetch([
      page(Array.from({ length: SYNC_PAGE_ITEMS }, (_, i) => item(100 + i)), 60),
      ...Array.from({ length: SYNC_PAGE_ITEMS }, () => noChildren),
    ]);
    await run(ctx, linkId);

    expect(new URL(calls[0]?.url ?? "").searchParams.get("start")).toBe("25");
    expect(link(ctx)?.syncCursor?.start).toBe(50);
    expect(link(ctx)?.syncCursor?.imported).toBe(50);
  });

  it("closes the walk when the last page comes back short", async () => {
    // A short page is Zotero saying there is no more, whatever `Total-Results`
    // claimed when the walk started — libraries shrink too.
    const { ctx, linkId } = await linkedWorld({
      syncCursor: { targetVersion: 8431, start: 50, total: 60, imported: 40 },
    });
    stubFetch([page([item(1)], 60), noChildren]);
    await run(ctx, linkId);

    expect(link(ctx)?.syncCursor).toBeUndefined();
    expect(link(ctx)?.lastVersion).toBe(8431);
  });

  it("does not read a page it could not parse as a page with nothing on it", async () => {
    // The difference between a bad minute and a lost library. Zotero answers a
    // maintenance page or a proxy error with HTML, and an empty list is a
    // *short* page — which closes the walk and moves `lastVersion` to the mark
    // it started at. The 3,975 items this run never looked at all sit below
    // that version, so `?since=` would exclude them from every future walk and
    // they would be gone until somebody edited each one in Zotero by hand.
    const { ctx, linkId } = await linkedWorld({
      syncCursor: { targetVersion: 8431, start: 25, total: 4_000, imported: 25 },
    });
    stubFetch([
      {
        status: 200,
        bytes: "<html><body>Zotero is down for maintenance</body></html>",
        headers: { "content-type": "text/html" },
      },
    ]);
    await run(ctx, linkId);

    expect(link(ctx)?.syncCursor?.start, "the walk is where it was").toBe(25);
    expect(link(ctx)?.lastVersion).toBeUndefined();
    // And it says nothing about the member's key, because this was not about
    // their key.
    expect(link(ctx)?.lastSync?.statusCode).toBeUndefined();
  });

  it("commits the version the walk started at, not the last page's", async () => {
    // A member editing a paper on page four of their own walk. `lastVersion` is
    // the mark `?since=` uses next time, so committing anything the walk did not
    // actually cover puts that edit behind the mark and loses it; committing the
    // version the walk pinned at the top means the next walk sees it again, at
    // the cost of re-reading a handful of items.
    //
    // The mark therefore comes off the cursor and never off the page in hand —
    // asserted here with a page that carries no version header at all, so a
    // reading of the response could only produce a different answer. The case
    // where the page reports a *higher* version is the test below: that walk
    // does not commit a mark at all, it starts again.
    const { ctx, linkId } = await linkedWorld({
      syncCursor: { targetVersion: 8431, start: 25, total: 26, imported: 25 },
    });
    stubFetch([
      { status: 200, body: [item(9)], headers: { "Total-Results": "26" } },
      noChildren,
    ]);
    await run(ctx, linkId);

    expect(link(ctx)?.lastVersion).toBe(8431);
  });

  it("does not close a walk on a count Zotero never sent", async () => {
    // `Total-Results` is optional, and `start >= total` used to be half of what
    // ended a walk. Absent, the only fallback is the page in hand — so a full
    // *first* page with no header read as "25 items, 25 walked, finished", and
    // `lastVersion` moved past three thousand items nobody had fetched. A short
    // page is Zotero's own answer to "is there more" and needs no header.
    const { ctx, linkId } = await linkedWorld();
    stubFetch([
      {
        status: 200,
        body: Array.from({ length: SYNC_PAGE_ITEMS }, (_, i) => item(i)),
        headers: { "Last-Modified-Version": "8431" },
      },
      ...Array.from({ length: SYNC_PAGE_ITEMS }, () => noChildren),
    ]);
    await run(ctx, linkId);

    expect(link(ctx)?.syncCursor?.start).toBe(SYNC_PAGE_ITEMS);
    expect(link(ctx)?.lastVersion).toBeUndefined();
  });

  it("walks the page it asked for, not the page it was handed", async () => {
    // `limit=25` is a request. A proxy, a future API version or something
    // hostile answering with a hundred rows would otherwise buy a hundred
    // `/children` requests and a hundred downloads inside one action — the
    // exact shape `SYNC_PAGE_ITEMS` exists to refuse.
    const { ctx, linkId } = await linkedWorld();
    const calls = stubFetch([
      page(Array.from({ length: 100 }, (_, i) => item(i)), 4_000),
      ...Array.from({ length: SYNC_PAGE_ITEMS }, () => noChildren),
    ]);
    await run(ctx, linkId);

    expect(papers(ctx)).toHaveLength(SYNC_PAGE_ITEMS);
    expect(link(ctx)?.syncCursor?.start).toBe(SYNC_PAGE_ITEMS);
    expect(calls, "one page, then one children request each").toHaveLength(
      1 + SYNC_PAGE_ITEMS,
    );
  });

  it("starts the walk again when its result set got shorter", async () => {
    // The one change offset pagination cannot survive. An item leaving the set
    // pulls its neighbours to *lower* offsets, under the read head: those rows
    // are never fetched, and `lastVersion` closes over them at the end of the
    // walk, so `?since=` excludes them from every walk after this one.
    //
    // The cursor is rewound rather than dropped, so a member watching the
    // settings row reads "0 of 400" — a walk starting again — instead of a
    // progress line that vanished. And the mark stays where it was, because
    // this walk has not covered the library yet.
    const { ctx, linkId } = await linkedWorld({
      lastVersion: 8000,
      syncCursor: { targetVersion: 8431, start: 25, total: 400, imported: 25 },
    });
    stubFetch([page([item(1)], 380, 8500)]);
    await run(ctx, linkId);

    expect(link(ctx)?.syncCursor).toEqual({
      targetVersion: 8431,
      start: 0,
      // Re-baselined to what this run saw, not left at the number that fired
      // the trigger — see the test below, which is what that costs.
      total: 380,
      imported: 0,
      generation: 1,
    });
    expect(link(ctx)?.lastVersion, "the mark has not moved").toBe(8000);
    expect(papers(ctx)).toHaveLength(0);
  });

  it("walks after a restart instead of restarting for ever", async () => {
    // The livelock the rewind opened, and the reason a cleared cursor did not
    // have it: a walk with no cursor reads its baseline off the next page's
    // header, and a rewound one carries whatever it had. The trigger is
    // "smaller than the number in the cursor", so a cursor keeping the *old*
    // number meets its own trigger on the next run, and on the one after that.
    // A library that permanently loses one item would restart every hour for
    // ever, importing nothing, until the member unlinked, re-keyed, re-scoped,
    // or the library grew back past the size it used to be.
    const { ctx, linkId } = await linkedWorld({
      lastVersion: 8000,
      syncCursor: { targetVersion: 8431, start: 25, total: 400, imported: 25 },
    });
    stubFetch([page([item(1)], 380, 8500)]);
    await run(ctx, linkId);
    expect(link(ctx)?.syncCursor?.start, "restarted once").toBe(0);

    // An hour later, and the library is still the size it now is.
    stubFetch([
      page(Array.from({ length: SYNC_PAGE_ITEMS }, (_, i) => item(i)), 380, 8500),
      ...Array.from({ length: SYNC_PAGE_ITEMS }, () => noChildren),
    ]);
    await run(ctx, linkId);

    expect(papers(ctx), "the second run walks").toHaveLength(SYNC_PAGE_ITEMS);
    expect(link(ctx)?.syncCursor?.start).toBe(SYNC_PAGE_ITEMS);
    expect(link(ctx)?.syncCursor?.generation, "and stays restarted once").toBe(1);
  });

  it("finishes a walk a member keeps editing", async () => {
    // The starvation this pins against, which a version-based restart caused
    // and this test would have caught. One page a run against an hourly sweep
    // makes a thousand-item library a forty-hour walk, and any edit in any of
    // those hours lifts `Last-Modified-Version` above the walk's mark — so a
    // member who touches Zotero more than once an hour never once got past
    // their first twenty-five papers, and every restart looked like a clean
    // no-op from the outside.
    //
    // Here the member edits something between every run: the version climbs on
    // every page and the set never gets shorter. The walk has to finish.
    const { ctx, linkId } = await linkedWorld();
    for (const [from, size, version] of [
      [0, SYNC_PAGE_ITEMS, 8500],
      [25, SYNC_PAGE_ITEMS, 8600],
      [50, 10, 8700],
    ] as const) {
      stubFetch([
        page(Array.from({ length: size }, (_, i) => item(from + i)), 60, version),
        ...Array.from({ length: size }, () => noChildren),
      ]);
      await run(ctx, linkId);
    }

    expect(papers(ctx), "sixty papers, not twenty-five, forever").toHaveLength(60);
    expect(link(ctx)?.syncCursor, "and the walk is finished").toBeUndefined();
    // At the version the walk started against, not at any of the edits made
    // during it — those are all above this mark and the next walk sees them.
    expect(link(ctx)?.lastVersion).toBe(8500);
  });
});

describe("a sweep with nothing to do", () => {
  it("costs one conditional request and writes no papers", async () => {
    const { ctx, linkId } = await linkedWorld({ lastVersion: 8431, lastSyncAt: 1 });
    const calls = stubFetch([{ status: 304 }]);
    await run(ctx, linkId);

    expect(calls).toHaveLength(1);
    expect(
      new Headers(calls[0]?.init.headers).get("If-Modified-Since-Version"),
    ).toBe("8431");
    expect(papers(ctx)).toHaveLength(0);
    // It still counts as having looked, or the sweep picks the same link
    // every hour forever.
    expect(link(ctx)?.lastSyncAt).toBeGreaterThan(1);
  });

  it("asks only for what changed once it has a version", async () => {
    const { ctx, linkId } = await linkedWorld({ lastVersion: 8431 });
    const calls = stubFetch([page([], 0)]);
    await run(ctx, linkId);
    expect(new URL(calls[0]?.url ?? "").searchParams.get("since")).toBe("8431");
  });
});

describe("dedupe", () => {
  it("recognises an item it has already imported, by index", async () => {
    const { ctx, seed, linkId } = await linkedWorld();
    await ctx.db.insert("papers", {
      labId: seed.labId,
      title: "Paper number 1",
      addedBy: seed.pi,
      ingestStatus: "ready",
      zoteroItemKey: "ITEM0001",
    });
    stubFetch([page([item(1)], 1)]);
    await run(ctx, linkId);

    expect(papers(ctx)).toHaveLength(1);
    // And it went through the index rather than reading the shelf.
    expect(ctx.db.lastReadOf("by_lab_and_zotero_item")).toBeDefined();
  });

  it("recognises a paper the lab already has by DOI", async () => {
    const { ctx, seed, linkId } = await linkedWorld();
    const paperId = await ctx.db.insert("papers", {
      labId: seed.labId,
      title: "Added from a DOI months ago",
      doi: "10.1038/nature12373",
      addedBy: seed.pi,
      ingestStatus: "ready",
    });
    stubFetch([page([item(1, { DOI: "10.1038/nature12373" })], 1)]);
    await run(ctx, linkId);

    // No second row for a paper the lab already has. The one it has is claimed
    // for the Zotero item instead, so an edit upstream patches this row rather
    // than arriving as a duplicate next hour.
    expect(papers(ctx)).toHaveLength(1);
    expect((await ctx.db.get(paperId))?.zoteroItemKey).toBe("ITEM0001");
    expect(ctx.db.lastReadOf("by_lab_and_doi")).toBeDefined();
  });

  it("takes the DOI Zotero holds, however Zotero spells it", async () => {
    // Zotero stores whatever the publisher's metadata said, prefix and casing
    // included. Written raw, `by_lab_and_doi` stops being a dedupe key: the
    // same paper lands twice and neither row can see the other.
    const { ctx, seed, linkId } = await linkedWorld();
    const paperId = await ctx.db.insert("papers", {
      labId: seed.labId,
      title: "Added from a DOI months ago",
      doi: "10.1038/nature12373",
      addedBy: seed.pi,
      ingestStatus: "ready",
    });
    stubFetch([
      page([item(1, { DOI: "https://doi.org/10.1038/Nature12373" })], 1),
    ]);
    await run(ctx, linkId);

    // Asserted on the *claim* rather than on a count: a row filed under the
    // prefixed spelling would carry an item key of its own and satisfy a
    // count, which is exactly how this test would go quietly vacuous.
    expect(papers(ctx)).toHaveLength(1);
    expect((await ctx.db.get(paperId))?.zoteroItemKey).toBe("ITEM0001");
  });

  it("recognises a DOI-less paper by the same identity a .bib import uses", async () => {
    // A paper pasted from a citation export last month and synced from Zotero
    // today is one paper. `referenceIdentity` is what decides that, and it is
    // the same function `createFromMetadata` uses.
    const { ctx, seed, linkId } = await linkedWorld();
    const paperId = await ctx.db.insert("papers", {
      labId: seed.labId,
      title: "Paper number 3",
      year: 2024,
      addedBy: seed.pi,
      ingestStatus: "needs-pdf",
    });
    stubFetch([page([item(3)], 1)]);
    await run(ctx, linkId);

    expect(papers(ctx)).toHaveLength(1);
    expect((await ctx.db.get(paperId))?.zoteroItemKey).toBe("ITEM0003");
  });

  it("reads the lab's shelf once per run, not once per item", async () => {
    // The audit's second-riskiest finding: `createFromMetadata` dedupes with a
    // full `by_lab` read per candidate, which at 25 items and 200 papers is
    // 5,000 document reads a run and grows with the shelf. One read, one map.
    const { ctx, seed, linkId } = await linkedWorld();
    for (let n = 0; n < 30; n++) {
      await ctx.db.insert("papers", {
        labId: seed.labId,
        title: `Shelf paper ${n}`,
        addedBy: seed.pi,
        ingestStatus: "ready",
      });
    }
    stubFetch([
      page(Array.from({ length: SYNC_PAGE_ITEMS }, (_, i) => item(i)), 25),
      ...Array.from({ length: SYNC_PAGE_ITEMS }, () => noChildren),
    ]);
    await run(ctx, linkId);

    const shelfReads = ctx.db.reads.filter(
      (read) => read.table === "papers" && read.index === "by_lab",
    );
    // One in the preflight query, one in the committing mutation. Not
    // twenty-five of each.
    expect(shelfReads.length).toBeLessThanOrEqual(2);
  });

  it("compares against the two hundred papers a member can actually see", async () => {
    // `by_lab` ascending reads the *oldest* two hundred; the library page shows
    // the newest (`convex/papers.ts:570-578`). An ascending fallback therefore
    // compares a sync against precisely the papers nobody can see on the shelf,
    // and last week's `.bib` paste — the newest row, and the likeliest
    // duplicate there is — arrives a second time.
    const { ctx, seed, linkId } = await linkedWorld();
    for (let n = 0; n < 200; n++) {
      await ctx.db.insert("papers", {
        labId: seed.labId,
        title: `Shelf paper ${n}`,
        addedBy: seed.pi,
        ingestStatus: "ready",
      });
    }
    const pasted = await ctx.db.insert("papers", {
      labId: seed.labId,
      title: "Paper number 5",
      year: 2024,
      addedBy: seed.pi,
      ingestStatus: "needs-pdf",
    });
    stubFetch([page([item(5)], 1)]);
    await run(ctx, linkId);

    expect((await ctx.db.get(pasted))?.zoteroItemKey).toBe("ITEM0005");
  });

  it("collapses a paper the member duplicated inside Zotero itself", async () => {
    // Two rows on one page with the same title and year. The shelf map cannot
    // catch the second one, because the first was filed in this same
    // transaction and the map was read before either.
    const { ctx, linkId } = await linkedWorld();
    stubFetch([
      page([item(7), { ...item(8), data: { ...item(7).data, key: "ITEM0008" } }], 2),
      noChildren,
      noChildren,
    ]);
    await run(ctx, linkId);

    expect(papers(ctx)).toHaveLength(1);
  });

  it("patches a title the member fixed upstream rather than adding a second row", async () => {
    const { ctx, seed, linkId } = await linkedWorld();
    const paperId = await ctx.db.insert("papers", {
      labId: seed.labId,
      title: "Paper nubmer 4",
      addedBy: seed.pi,
      ingestStatus: "ready",
      zoteroItemKey: "ITEM0004",
    });
    stubFetch([page([item(4)], 1)]);
    await run(ctx, linkId);

    expect(papers(ctx)).toHaveLength(1);
    expect((await ctx.db.get(paperId))?.title).toBe("Paper number 4");
  });

  it("does not strip a paper of what the Zotero row never knew", async () => {
    // `db.patch` reads an `undefined` as *delete this field*, and a Zotero item
    // is routinely thinner than the paper Margin holds: a `.bib` import or a
    // DOI walk fills in a venue, an abstract and a list of authors the member's
    // own Zotero row never had. Claiming that row for a Zotero item would blank
    // them — and `chooseScope` resets `lastVersion`, so every scope change
    // re-walks the library and strips the same papers again.
    const { ctx, seed, linkId } = await linkedWorld();
    const paperId = await ctx.db.insert("papers", {
      labId: seed.labId,
      title: "Paper number 4",
      authors: ["Ana Ruiz", "Ben Okafor"],
      year: 2024,
      venue: "Journal of Reproducible Assays",
      abstract: "A 4 °C step explains the gap.",
      doi: "10.1038/nature12373",
      addedBy: seed.pi,
      ingestStatus: "ready",
      zoteroItemKey: "ITEM0004",
    });
    // A title and nothing else, which is what most of a real library looks
    // like once somebody has been dragging PDFs in for a decade.
    stubFetch([page([item(4, { creators: [], date: undefined })], 1)]);
    await run(ctx, linkId);

    expect(await ctx.db.get(paperId)).toMatchObject({
      authors: ["Ana Ruiz", "Ben Okafor"],
      year: 2024,
      venue: "Journal of Reproducible Assays",
      abstract: "A 4 °C step explains the gap.",
      doi: "10.1038/nature12373",
    });
  });

  it("takes a DOI the member corrected upstream", async () => {
    const { ctx, seed, linkId } = await linkedWorld();
    const paperId = await ctx.db.insert("papers", {
      labId: seed.labId,
      title: "Paper number 4",
      doi: "10.1038/nature00000",
      addedBy: seed.pi,
      ingestStatus: "ready",
      zoteroItemKey: "ITEM0004",
    });
    stubFetch([page([item(4, { DOI: "10.1038/nature12373" })], 1)]);
    await run(ctx, linkId);

    expect((await ctx.db.get(paperId))?.doi).toBe("10.1038/nature12373");
  });

  it("will not hand a correction a second row already answers to", async () => {
    // The one edit that can break `by_lab_and_doi` from outside: the member
    // fixes a typo in Zotero, and the corrected DOI is the one another paper on
    // the shelf has held since a `.bib` import. Written through, two rows would
    // sit under one dedupe key — and from then on every lookup that dedupes
    // against that DOI finds whichever row Convex hands back first, which is a
    // fact about an index rather than about the lab.
    const { ctx, seed, linkId } = await linkedWorld();
    const older = await ctx.db.insert("papers", {
      labId: seed.labId,
      title: "The paper that DOI belongs to",
      doi: "10.1038/nature12373",
      addedBy: seed.pi,
      ingestStatus: "ready",
    });
    const claimed = await ctx.db.insert("papers", {
      labId: seed.labId,
      title: "Paper number 4",
      doi: "10.1038/nature00000",
      addedBy: seed.pi,
      ingestStatus: "ready",
      zoteroItemKey: "ITEM0004",
    });
    stubFetch([page([item(4, { DOI: "10.1038/nature12373" })], 1)]);
    await run(ctx, linkId);

    // The row that was here first keeps it; the guest keeps its own row and its
    // own item key, and does not get somebody else's identifier.
    expect((await ctx.db.get(older))?.doi).toBe("10.1038/nature12373");
    expect((await ctx.db.get(claimed))?.doi).toBe("10.1038/nature00000");
  });
});

describe("the attachment", () => {
  const attachment = (over: Record<string, unknown> = {}) => [
    {
      key: "PDF00001",
      data: {
        key: "PDF00001",
        itemType: "attachment",
        linkMode: "imported_url",
        contentType: "application/pdf",
        filename: "ruiz.pdf",
        md5: "9f86d081884c7d659a2feaa0c55ad015",
        ...over,
      },
    },
  ];

  it("never forwards the key to the host the redirect points at", async () => {
    // The finding. `fetch` strips `Authorization` across a cross-origin
    // redirect and strips nothing else, so a followed 302 from `/file` hands a
    // member's Zotero key to Amazon. Asserted on the second hop's actual
    // headers, because this is invisible unless somebody looks.
    const { ctx, linkId } = await linkedWorld();
    const calls = stubFetch([
      page([item(1)], 1),
      { status: 200, body: attachment() },
      { status: 302, headers: { location: "https://zotero-storage.s3.amazonaws.com/abc" } },
      { status: 200, bytes: "%PDF-1.7 fake" },
    ]);
    await run(ctx, linkId);

    const hop = calls[3];
    expect(hop?.url).toContain("amazonaws.com");
    expect(new Headers(hop?.init.headers).get("Zotero-API-Key")).toBeNull();
    expect(JSON.stringify(hop?.init.headers ?? {})).not.toContain(KEY);
  });

  it("lands the paper pending, so the reader finishes the ingest", async () => {
    // Exactly what a DOI-fetched open-access copy does: bytes in storage, no
    // text layer, `useTextLayer` closes the gap on first open. No new ingest
    // path and no new client code.
    const { ctx, linkId } = await linkedWorld();
    stubFetch([
      page([item(1)], 1),
      { status: 200, body: attachment() },
      { status: 302, headers: { location: "https://zotero-storage.s3.amazonaws.com/abc" } },
      { status: 200, bytes: "%PDF-1.7 fake" },
    ]);
    await run(ctx, linkId);

    expect(papers(ctx)[0]?.ingestStatus).toBe("pending");
    expect(papers(ctx)[0]?.storageId).toBeDefined();
    expect(ctx.stored).toHaveLength(1);
  });

  it("lands a WebDAV-stored item as needs-pdf without spending a download", async () => {
    const { ctx, linkId } = await linkedWorld();
    const calls = stubFetch([
      page([item(1)], 1),
      { status: 200, body: attachment({ md5: undefined }) },
    ]);
    await run(ctx, linkId);

    expect(calls).toHaveLength(2);
    expect(papers(ctx)[0]?.ingestStatus).toBe("needs-pdf");
  });

  it("still files the paper when the download fails", async () => {
    // A paper with no readable copy is still worth having, and the library
    // already renders `needs-pdf` honestly.
    const { ctx, linkId } = await linkedWorld();
    stubFetch([
      page([item(1)], 1),
      { status: 200, body: attachment() },
      { status: 500 },
    ]);
    await run(ctx, linkId);

    expect(papers(ctx)).toHaveLength(1);
    expect(papers(ctx)[0]?.ingestStatus).toBe("needs-pdf");
  });

  it("refuses a redirect that leaves https or points at a machine", async () => {
    // `nextRedirectHop` is reused rather than restated: a host that answers
    // 302 with an internal address is the reason the pasted-link path steers
    // manually, and a Zotero attachment is the same shape of hop.
    const { ctx, linkId } = await linkedWorld();
    const calls = stubFetch([
      page([item(1)], 1),
      { status: 200, body: attachment() },
      { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } },
    ]);
    await run(ctx, linkId);

    expect(calls).toHaveLength(3);
    expect(papers(ctx)[0]?.ingestStatus).toBe("needs-pdf");
  });
});

describe("an outcome that arrives after the member moved", () => {
  /**
   * The member changes something while a run is in flight.
   *
   * Hung off the preflight query rather than written between two statements
   * in the test, and the difference matters. Every await in this context
   * resolves in the same microtask, so a `patch` after `run(…)` lands *before*
   * the run has read the link — which is a race, but the harmless one, and a
   * test that staged it would pass while proving nothing. Wired here, the
   * change happens where the danger is: after the run read the link and its
   * key, and before its outcome tries to land.
   */
  function duringRun(ctx: FakeCtx, change: () => Promise<unknown>) {
    ctx.register(internal.zotero.newAmong, {
      _handler: async (inner: unknown, args: never) => {
        await change();
        return await handlerOf(newAmong)(inner, args);
      },
    });
  }

  it("writes nothing under a key that has been replaced", async () => {
    // The papers this run is about to write were read with a credential the
    // member has revoked, and the cursor it is about to advance belongs to a
    // walk that no longer exists.
    const { ctx, linkId } = await linkedWorld();
    stubFetch([
      page([item(1)], 40),
      { status: 200, body: [] },
    ]);
    duringRun(ctx, () =>
      ctx.db.patch(linkId, {
        connectedAt: 9_000,
        apiKey: "Zx7QmT4rWbNc8VhJ2LpKd6Ye",
      }),
    );
    await run(ctx, linkId);

    expect(papers(ctx)).toHaveLength(0);
    expect(link(ctx)?.syncCursor).toBeUndefined();
  });

  it("writes nothing under a scope the member re-pointed", async () => {
    // `connectedAt` says nothing about this one: the key is the same key. But
    // the page in hand was read out of one collection and the link now names
    // another, so filing it puts papers on the lab's shelf out of a library
    // nobody currently syncs — and moves a cursor that belongs to the old
    // scope's walk. `chooseScope` has already cleared that cursor, so the run
    // would be re-creating a walk the member ended.
    const { ctx, linkId } = await linkedWorld();
    stubFetch([page([item(1)], 40), { status: 200, body: [] }]);
    duringRun(ctx, () =>
      ctx.db.patch(linkId, {
        collectionKey: "N3WC0LL3",
        collectionName: "Thursday",
        syncCursor: undefined,
      }),
    );
    await run(ctx, linkId);

    expect(papers(ctx)).toHaveLength(0);
    expect(link(ctx)?.syncCursor).toBeUndefined();
  });

  it("does not leave a blob behind when the member unlinked mid-run", async () => {
    // Unlink is a delete, so there is no `connectedAt` left to compare and the
    // page is refused by the row simply being gone. The bytes were already
    // fetched by then, and a blob with nothing pointing at it is a file nobody
    // will ever find again and nothing will ever collect.
    const { ctx, linkId } = await linkedWorld();
    stubFetch([
      page([item(1)], 40),
      {
        status: 200,
        body: [
          {
            key: "PDF00001",
            data: {
              key: "PDF00001",
              itemType: "attachment",
              linkMode: "imported_url",
              contentType: "application/pdf",
              md5: "9f86d081884c7d659a2feaa0c55ad015",
            },
          },
        ],
      },
      { status: 302, headers: { location: "https://s3.amazonaws.com/abc" } },
      { status: 200, bytes: "%PDF-1.7 fake" },
    ]);
    duringRun(ctx, () => ctx.db.delete(linkId));
    await run(ctx, linkId);

    expect(ctx.stored).toHaveLength(1);
    expect(ctx.discarded).toHaveLength(1);
    expect(papers(ctx)).toHaveLength(0);
  });

  it("refuses a page read before a walk that has since finished", async () => {
    // Offset zero and no walk at all are not the same state, and arithmetic
    // that defaults one to the other cannot tell them apart. This run reads
    // page one of a fresh walk; in the gap, a second run walks the whole
    // library and finishes it, clearing the cursor and moving the mark. The
    // page in hand now describes a library that has been fully imported —
    // committed, it installs `{ start: 25 }` on top of a *completed* walk, and
    // the next run asks `?since=8431&start=25`: twenty-five items into a
    // changed-items set that is almost never that long. Everything in it is
    // stepped over, and `lastVersion` closes the gap behind it.
    const { ctx, linkId } = await linkedWorld();
    stubFetch([
      page(Array.from({ length: SYNC_PAGE_ITEMS }, (_, i) => item(i)), 400),
      ...Array.from({ length: SYNC_PAGE_ITEMS }, () => noChildren),
    ]);
    duringRun(ctx, () =>
      ctx.db.patch(linkId, { lastVersion: 8431, syncCursor: undefined }),
    );
    await run(ctx, linkId);

    expect(
      link(ctx)?.syncCursor,
      "no walk is re-opened on top of a finished one",
    ).toBeUndefined();
    expect(link(ctx)?.lastVersion).toBe(8431);
    expect(papers(ctx)).toHaveLength(0);
  });

  /**
   * The member changes something while the *request* is in flight.
   *
   * `duringRun` hangs off the preflight query, which a run only reaches once it
   * has a page to ask about — so it cannot stage the runs that end before that:
   * a refusal, a `304`, a restart. Those end at `markSwept`, and the interval
   * that matters for them is the one around the fetch itself.
   */
  function duringFetch(
    ctx: FakeCtx,
    answers: Stub[],
    change: () => Promise<unknown>,
  ) {
    const calls = stubFetch(answers);
    const answering = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      await change();
      return await answering(url, init);
    });
    return calls;
  }

  it("says nothing about a scope the member has left", async () => {
    // `chooseScope` re-points a link without touching `connectedAt` — the key
    // is the same key — so a run that read the *old* library passed the
    // credential check and wrote its outcome onto a row that now describes a
    // different one. There is no page to file on this path, which is how it
    // read as harmless; but `lastSync` is the sentence the settings row shows
    // a member, and a 403 from the group they just left, rendered against the
    // collection they just chose, tells them to replace a key that is fine.
    //
    // Only the scope is patched here, so anything that appears in `lastSync`
    // afterwards could only have come from this run.
    const { ctx, linkId } = await linkedWorld({
      lastSyncAt: 1_000,
      lastSync: { at: 1_000, connectedAt: 1_000, imported: 4, skipped: 1 },
    });
    duringFetch(ctx, [{ status: 403, body: { message: "Invalid key" } }], () =>
      ctx.db.patch(linkId, {
        collectionKey: "N3WC0LL3",
        collectionName: "Thursday",
      }),
    );
    await run(ctx, linkId);

    expect(
      link(ctx)?.lastSync?.statusCode,
      "no refusal against a library nobody queried",
    ).toBeUndefined();
    expect(link(ctx)?.lastSync?.imported, "the row is untouched").toBe(4);
    expect(link(ctx)?.lastSyncAt, "and so is the last-checked time").toBe(1_000);
  });

  it("does not restart a walk belonging to a scope the member has left", async () => {
    // The other half of the same guard. `chooseScope` clears the cursor itself,
    // so this cannot rewind a live walk today — but that is a fact about a
    // different function, and it is the kind of fact that stops being true.
    const { ctx, linkId } = await linkedWorld({
      syncCursor: { targetVersion: 8431, start: 25, total: 400, imported: 25 },
    });
    duringFetch(ctx, [page([item(1)], 380, 8500)], () =>
      ctx.db.patch(linkId, { collectionKey: "N3WC0LL3" }),
    );
    await run(ctx, linkId);

    expect(link(ctx)?.syncCursor?.start, "the walk is where it was").toBe(25);
    expect(link(ctx)?.syncCursor?.generation).toBeUndefined();
  });

  it("refuses a page fetched before the walk was sent back to its start", async () => {
    // The one interleaving `start` cannot see. A restarted walk sits at offset
    // zero, and so does a walk that has only just begun; a restart does not
    // touch `lastVersion` either. So a run holding a page from *before* a
    // restart matches on both, commits, and pushes the read head to twenty-five
    // across exactly the rows the restart existed to read again — the restart
    // undone by the run that provoked it, and the rows lost for good once
    // `lastVersion` closes over them.
    const { ctx, linkId } = await linkedWorld({
      lastVersion: 8000,
      syncCursor: {
        targetVersion: 8431,
        start: 0,
        total: 380,
        imported: 0,
        generation: 1,
      },
    });
    stubFetch([
      page(Array.from({ length: SYNC_PAGE_ITEMS }, (_, i) => item(i)), 380),
      ...Array.from({ length: SYNC_PAGE_ITEMS }, () => noChildren),
    ]);
    // A second run finds the set shorter again and restarts while this one is
    // still fetching its files.
    duringRun(ctx, () =>
      ctx.db.patch(linkId, {
        syncCursor: {
          targetVersion: 8431,
          start: 0,
          total: 360,
          imported: 0,
          generation: 2,
        },
      }),
    );
    await run(ctx, linkId);

    expect(link(ctx)?.syncCursor?.generation).toBe(2);
    expect(
      link(ctx)?.syncCursor?.start,
      "the head has not moved off the restart",
    ).toBe(0);
    expect(papers(ctx)).toHaveLength(0);
  });

  it("refuses a page fetched at an offset the walk has already left", async () => {
    // Two runs overlapping — the hourly sweep and a member pressing Sync now.
    // Both read from the same offset, one commits and moves the cursor, and the
    // other arrives with a page describing where the walk *was*. Applied, it
    // rewinds `start` to somewhere the walk has been, re-counts what it already
    // imported, and hands `lastVersion` a walk that never covered the middle.
    const { ctx, linkId } = await linkedWorld({
      syncCursor: { targetVersion: 8431, start: 50, total: 400, imported: 50 },
    });
    stubFetch([
      page(Array.from({ length: SYNC_PAGE_ITEMS }, (_, i) => item(i)), 400),
      ...Array.from({ length: SYNC_PAGE_ITEMS }, () => noChildren),
    ]);
    duringRun(ctx, () =>
      ctx.db.patch(linkId, {
        syncCursor: { targetVersion: 8431, start: 75, total: 400, imported: 60 },
      }),
    );
    await run(ctx, linkId);

    expect(link(ctx)?.syncCursor?.start, "where the other run left it").toBe(75);
    expect(link(ctx)?.syncCursor?.imported).toBe(60);
    expect(papers(ctx)).toHaveLength(0);
  });

  it("does not leave a fetched blob with nothing pointing at it", async () => {
    const { ctx, linkId } = await linkedWorld();
    stubFetch([
      page([item(1)], 40),
      {
        status: 200,
        body: [
          {
            key: "PDF00001",
            data: {
              key: "PDF00001",
              itemType: "attachment",
              linkMode: "imported_url",
              contentType: "application/pdf",
              md5: "9f86d081884c7d659a2feaa0c55ad015",
            },
          },
        ],
      },
      { status: 302, headers: { location: "https://s3.amazonaws.com/abc" } },
      { status: 200, bytes: "%PDF-1.7 fake" },
    ]);
    duringRun(ctx, () => ctx.db.patch(linkId, { connectedAt: 9_000 }));
    await run(ctx, linkId);

    expect(ctx.stored).toHaveLength(1);
    expect(ctx.discarded).toHaveLength(1);
  });
});

describe("the ledger", () => {
  it("files one summary row when a run put papers on the shelf", async () => {
    const { ctx, seed, linkId } = await linkedWorld();
    stubFetch([page([item(1), item(2)], 2), noChildren, noChildren]);
    await run(ctx, linkId);

    const synced = ctx.db.all("events").filter((e) => e.type === "zotero.synced");
    expect(synced).toHaveLength(1);
    expect(synced[0]).toMatchObject({ imported: 2, skipped: 0, actorId: seed.pi });
    // The papers themselves carry the titles.
    expect(
      ctx.db.all("events").filter((e) => e.type === "paper.added"),
    ).toHaveLength(2);
  });

  it("files nothing for a poll that found nothing", async () => {
    // Otherwise the append-only table grows at one row per member per hour to
    // record that nothing happened, which is a fact about the scheduler.
    const { ctx, linkId } = await linkedWorld({ lastVersion: 8431 });
    stubFetch([{ status: 304 }]);
    await run(ctx, linkId);
    expect(ctx.db.all("events").filter((e) => e.type === "zotero.synced")).toHaveLength(0);
  });

  it("files nothing when every item on the page was already here", async () => {
    const { ctx, seed, linkId } = await linkedWorld();
    await ctx.db.insert("papers", {
      labId: seed.labId,
      title: "Paper number 1",
      addedBy: seed.pi,
      ingestStatus: "ready",
      zoteroItemKey: "ITEM0001",
    });
    stubFetch([page([item(1)], 1)]);
    await run(ctx, linkId);
    expect(ctx.db.all("events").filter((e) => e.type === "zotero.synced")).toHaveLength(0);
  });

  it("carries counts and nothing a title could hide in", async () => {
    const { ctx, linkId } = await linkedWorld();
    stubFetch([page([item(1)], 1), noChildren]);
    await run(ctx, linkId);

    const row = ctx.db.all("events").find((e) => e.type === "zotero.synced");
    expect(JSON.stringify(row)).not.toContain("Paper number 1");
    expect(JSON.stringify(row)).not.toContain(KEY);
  });
});

describe("a refusal", () => {
  it("marks the row without moving the cursor", async () => {
    const { ctx, linkId } = await linkedWorld({
      syncCursor: { targetVersion: 8431, start: 25, total: 400, imported: 25 },
    });
    stubFetch([{ status: 403, body: { message: "Invalid key" } }]);
    await run(ctx, linkId);

    expect(link(ctx)?.lastSync?.statusCode).toBe(403);
    expect(link(ctx)?.syncCursor?.start, "the walk is where it was").toBe(25);
  });

  it("says nothing about a bad minute", async () => {
    const { ctx, linkId } = await linkedWorld();
    stubFetch([{ status: 503 }]);
    await run(ctx, linkId);
    expect(link(ctx)?.lastSync?.statusCode).toBeUndefined();
  });
});

describe("the sweep", () => {
  it("takes the most overdue links and fans them out", async () => {
    const ctx = new FakeCtx();
    const seed = await seedLab(ctx);
    const stale = await ctx.db.insert("zoteroLinks", {
      userId: seed.pi, labId: seed.labId, apiKey: KEY, connectedAt: 1,
      libraryType: "user", libraryId: "1", lastSyncAt: Date.now() - 4 * HOUR,
    });
    await ctx.db.insert("zoteroLinks", {
      userId: seed.member, labId: seed.labId, apiKey: KEY, connectedAt: 1,
      libraryType: "user", libraryId: "2", lastSyncAt: Date.now(),
    });
    ctx.register(internal.zotero.dueLinks, dueLinks);

    await handlerOf(sweep)(ctx, {} as never);

    // Scheduled, not run inline: one member's slow library must not hold up
    // everybody else's, which is the same fan-out `convex/digests.ts` uses.
    expect(ctx.scheduled.map((call) => call.args)).toEqual([{ linkId: stale }]);
  });

  it("finds its work through the index, never by scanning", async () => {
    const ctx = new FakeCtx();
    const seed = await seedLab(ctx);
    await ctx.db.insert("zoteroLinks", {
      userId: seed.pi, labId: seed.labId, apiKey: KEY, connectedAt: 1,
      libraryType: "user", libraryId: "1",
    });
    ctx.register(internal.zotero.dueLinks, dueLinks);
    await handlerOf(sweep)(ctx, {} as never);

    expect(ctx.db.lastReadOf("by_due")).toBeDefined();
    expect(ctx.db.reads.some((read) => read.index === "(table scan)")).toBe(false);
  });
});
