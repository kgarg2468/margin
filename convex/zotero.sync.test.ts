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
 * a lab's shelf under one `take(200)` (`convex/schema.ts:1119-1122`), and a
 * real Zotero library is ten to fifty times that. The cap and the collection
 * scope are what make a first version honest, and these are the tests that
 * hold them.
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

  it("commits the version the walk started at, not the library's latest", async () => {
    // A member editing a paper on page four of their own walk. Committing the
    // *current* version would put that edit behind the mark and lose it
    // forever; committing the target means the next walk sees it again, at the
    // cost of re-reading a handful of items.
    const { ctx, linkId } = await linkedWorld({
      syncCursor: { targetVersion: 8431, start: 25, total: 26, imported: 25 },
    });
    stubFetch([page([item(9)], 26, 9999), noChildren]);
    await run(ctx, linkId);

    expect(link(ctx)?.lastVersion).toBe(8431);
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
    await ctx.db.insert("papers", {
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

    expect(papers(ctx)).toHaveLength(1);
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
   * The member pastes a new key while a run is in flight.
   *
   * Hung off the preflight query rather than written between two statements
   * in the test, and the difference matters. Every await in this context
   * resolves in the same microtask, so a `patch` after `run(…)` lands *before*
   * the run has read the link — which is a race, but the harmless one, and a
   * test that staged it would pass while proving nothing. Wired here, the
   * replacement happens where the danger is: after the run read the key and
   * before its outcome tries to land.
   */
  function replaceKeyDuringRun(
    ctx: FakeCtx,
    linkId: Id<"zoteroLinks">,
    fields: Record<string, unknown>,
  ) {
    ctx.register(internal.zotero.newAmong, {
      _handler: async (inner: unknown, args: never) => {
        await ctx.db.patch(linkId, fields);
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
    replaceKeyDuringRun(ctx, linkId, {
      connectedAt: 9_000,
      apiKey: "Zx7QmT4rWbNc8VhJ2LpKd6Ye",
    });
    await run(ctx, linkId);

    expect(papers(ctx)).toHaveLength(0);
    expect(link(ctx)?.syncCursor).toBeUndefined();
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
    replaceKeyDuringRun(ctx, linkId, { connectedAt: 9_000 });
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
