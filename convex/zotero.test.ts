import { ConvexError } from "convex/values";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal as internalApi } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { FakeCtx, handlerOf, seedLab } from "./delegations.fixtures";
import {
  ZoteroRefusal,
  callerIn,
  callerLinkId,
  chooseScope,
  connect,
  disconnect,
  listLibraries,
  permanentStatus,
  saveLink,
  status,
  syncPayload,
  zoteroFetch,
} from "./zotero";

vi.mock("@convex-dev/auth/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@convex-dev/auth/server")>()),
  getAuthUserId: async (ctx: unknown) =>
    (ctx as { auth?: { userId?: string } }).auth?.userId ?? null,
}));

/**
 * One member's Zotero key, and the settings row it feeds.
 *
 * Two kinds of thing are tested here and they are worth separating. The
 * transport is about a protocol: a header that must be a header, a redirect
 * that must not be followed, a refusal that must not carry a key into a log.
 * The rest is about a product promise: a member links their own library, and
 * nobody — not the PI, not the member themselves through a query — can read
 * the key back out of Margin.
 */

const KEY = "P9NiFoyLeZu2bZNvvuQPDWsd";
const SECOND_KEY = "Zx7QmT4rWbNc8VhJ2LpKd6Ye";

/** `GET /keys/current` for a read-only key, with the credential echoed. */
const READ_ONLY_BODY = {
  key: KEY,
  userID: 475425,
  username: "arahmani",
  access: {
    user: { library: true, files: true, notes: true, write: false },
    groups: { all: { library: true, write: false } },
  },
};

type Stub = { status: number; body?: unknown; headers?: Record<string, string> };

/** Replace global fetch with a queue of canned answers, and record the calls. */
function stubFetch(answers: Stub[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const queue = [...answers];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (next === undefined) throw new Error(`unexpected fetch: ${url}`);
    return new Response(
      next.body === undefined ? null : JSON.stringify(next.body),
      { status: next.status, headers: next.headers },
    );
  });
  return calls;
}

/** The `Zotero-API-Key` on one recorded call, if it carried one. */
function keyOn(init: RequestInit): string | null {
  return new Headers(init.headers).get("Zotero-API-Key");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function world() {
  const ctx = new FakeCtx();
  const seed = await seedLab(ctx);
  ctx.auth = { userId: seed.pi };
  ctx.register(internalApi.zotero.saveLink, saveLink);
  ctx.register(internalApi.zotero.callerIn, callerIn);
  ctx.register(internalApi.zotero.callerLinkId, callerLinkId);
  ctx.register(internalApi.zotero.syncPayload, syncPayload);
  return { ctx, seed };
}

/* --- the transport ---------------------------------------------------- */

describe("zoteroFetch", () => {
  it("presents the key as a header and never as a query parameter", async () => {
    const calls = stubFetch([{ status: 200, body: READ_ONLY_BODY }]);
    await zoteroFetch("https://api.zotero.org/keys/current", KEY);
    expect(calls[0]?.url).not.toContain(KEY);
    expect(keyOn(calls[0]?.init ?? {})).toBe(KEY);
    expect(new Headers(calls[0]?.init.headers).get("Zotero-API-Version")).toBe(
      "3",
    );
  });

  it("never lets a credentialed request follow a redirect", async () => {
    // The finding this rule exists for: `fetch` strips `Authorization` across
    // a cross-origin redirect and does NOT strip a custom header, so a
    // followed 302 hands a member's Zotero key to whatever answered it.
    // Asserted on the transport rather than on the download, because a rule
    // that lives at one call site has a second call site coming.
    const calls = stubFetch([{ status: 200, body: [] }]);
    await zoteroFetch("https://api.zotero.org/users/475425/items/top", KEY);
    expect(calls[0]?.init.redirect).toBe("manual");
  });

  it("waits out a 429 and asks once more", async () => {
    // On fake timers: the wait is real, and a suite that sits out every
    // backoff it asserts about is a suite people stop running.
    vi.useFakeTimers();
    try {
      const calls = stubFetch([
        { status: 429, headers: { "Retry-After": "1" } },
        { status: 200, body: [] },
      ]);
      const pending = zoteroFetch("https://api.zotero.org/keys/current", KEY);
      await vi.runAllTimersAsync();
      const response = await pending;
      expect(response.status).toBe(200);
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not re-ask anything else — the cursor is the retry", async () => {
    // A 503 ends the run with the cursor where it was, and the hourly sweep
    // picks the walk up from that offset. A second recovery mechanism inside
    // the run would be a second thing to get wrong for a case the first one
    // already covers.
    const calls = stubFetch([{ status: 503 }]);
    await expect(
      zoteroFetch("https://api.zotero.org/keys/current", KEY),
    ).rejects.toBeInstanceOf(ZoteroRefusal);
    expect(calls).toHaveLength(1);
  });

  it("keeps the key out of the refusal it throws", async () => {
    // A refusal is logged, and a log is forever. Zotero's own body is the
    // useful part and carries no secret; the key does.
    stubFetch([{ status: 403, body: { message: "Invalid key" } }]);
    const caught = await zoteroFetch(
      "https://api.zotero.org/keys/current",
      KEY,
    ).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ZoteroRefusal);
    expect(String(caught)).not.toContain(KEY);
    expect((caught as ZoteroRefusal).status).toBe(403);
  });

  it("treats a redirect as a refusal unless the caller asked for one", async () => {
    // `redirectIsAnAnswer` is the file download's option and nobody else's. A
    // `302` on any other request is a request the key must not follow and must
    // not be handed a `Location` for either — the default has to fail closed,
    // and a default is the kind of thing that quietly stops being one.
    stubFetch([
      { status: 302, headers: { location: "https://evil.example/collect" } },
    ]);
    await expect(
      zoteroFetch("https://api.zotero.org/keys/current", KEY),
    ).rejects.toBeInstanceOf(ZoteroRefusal);
  });

  it("asks conditionally when it has a version to be since", async () => {
    const calls = stubFetch([{ status: 304 }]);
    const response = await zoteroFetch(
      "https://api.zotero.org/users/475425/items/top",
      KEY,
      { ifModifiedSinceVersion: 8431 },
    );
    // A 304 is an answer, not a refusal: it is the cheap "nothing to do" the
    // hourly sweep is built on.
    expect(response.status).toBe(304);
    expect(
      new Headers(calls[0]?.init.headers).get("If-Modified-Since-Version"),
    ).toBe("8431");
  });
});

describe("permanentStatus", () => {
  it("reports the refusals only the member can fix", () => {
    // A revoked key, a key that never existed, a group they were removed from.
    expect(permanentStatus(new ZoteroRefusal("403 Forbidden", 403))).toBe(403);
    expect(permanentStatus(new ZoteroRefusal("404 Not found", 404))).toBe(404);
  });

  it("stays quiet about a bad minute", () => {
    expect(permanentStatus(new ZoteroRefusal("503", 503))).toBeNull();
    expect(permanentStatus(new ZoteroRefusal("429", 429))).toBeNull();
    expect(permanentStatus(new ZoteroRefusal("unreachable", null))).toBeNull();
    expect(permanentStatus(new TypeError("boom"))).toBeNull();
  });
});

/* --- connecting ------------------------------------------------------- */

describe("connect", () => {
  // `async` so the refusals below can be caught rather than only awaited:
  // `handlerOf` answers `unknown`, which has no `.catch` on it.
  const run = async (ctx: FakeCtx, labId: Id<"labs">, apiKey: string) =>
    await handlerOf(connect)(ctx, { labId, apiKey } as never);

  it("verifies the key, then stores it against this member and this lab", async () => {
    const { ctx, seed } = await world();
    const calls = stubFetch([{ status: 200, body: READ_ONLY_BODY }]);
    await run(ctx, seed.labId, KEY);

    expect(calls[0]?.url).toBe("https://api.zotero.org/keys/current");
    const [link] = ctx.db.all("zoteroLinks");
    expect(link?.userId).toBe(seed.pi);
    expect(link?.labId).toBe(seed.labId);
    expect(link?.apiKey).toBe(KEY);
    // The default scope is the member's own library, which is the one the key
    // was made for and the only one Margin can name without a second request.
    expect(link?.libraryType).toBe("user");
    expect(link?.libraryId).toBe("475425");
    expect(link?.connectedAt).toBeGreaterThan(0);
  });

  it("refuses a key that can write, in front of the person pasting it", async () => {
    // The better version of `slack.connect`'s wrong-paste refusal. A
    // write-scoped key turns the worst case from "somebody learns what this
    // person reads" into "somebody destroys a fifteen-year bibliography", and
    // Zotero's own key page has the checkbox right there.
    const { ctx, seed } = await world();
    stubFetch([
      {
        status: 200,
        body: {
          ...READ_ONLY_BODY,
          access: { user: { library: true, write: true } },
        },
      },
    ]);
    await expect(run(ctx, seed.labId, KEY)).rejects.toBeInstanceOf(ConvexError);
    expect(ctx.db.all("zoteroLinks")).toHaveLength(0);
  });

  it("refuses a key that has been granted nothing, and says which it is", async () => {
    // The failure `canRead` was added for. A key with an empty access block
    // cannot write, so a check that only asks `readOnly` waves it through; the
    // first sync then 403s and the member is told Zotero does not recognise
    // their key — which is false and unactionable. The key is fine. Its
    // permissions are empty, and only the sentence that says so is any use.
    const { ctx, seed } = await world();
    stubFetch([{ status: 200, body: { ...READ_ONLY_BODY, access: {} } }]);
    const caught = await run(ctx, seed.labId, KEY).catch(
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(ConvexError);
    const said = String((caught as ConvexError<string>).data);
    expect(said).toMatch(/permission/i);
    expect(said).not.toMatch(/recognise/i);
    expect(ctx.db.all("zoteroLinks")).toHaveLength(0);
  });

  it("refuses a paste that is not a key without spending a request", async () => {
    const { ctx, seed } = await world();
    const calls = stubFetch([]);
    await expect(
      run(ctx, seed.labId, "https://www.zotero.org/settings/keys"),
    ).rejects.toBeInstanceOf(ConvexError);
    expect(calls).toHaveLength(0);
  });

  it("refuses a key Zotero does not recognise, and says which it is", async () => {
    const { ctx, seed } = await world();
    stubFetch([{ status: 403, body: { message: "Invalid key" } }]);
    const caught = await run(ctx, seed.labId, KEY).catch(
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(ConvexError);
    expect(String((caught as ConvexError<string>).data)).toMatch(/key/i);
    // And the refusal a member reads never quotes the thing they pasted back.
    expect(String((caught as ConvexError<string>).data)).not.toContain(KEY);
  });

  it("refuses a member who is not in this lab", async () => {
    const { ctx, seed } = await world();
    ctx.auth = { userId: "users_999" };
    stubFetch([]);
    await expect(run(ctx, seed.labId, KEY)).rejects.toThrow();
  });

  it("replacing a key is a new identity and a cleared history", async () => {
    // A member who revoked one key and made another has a row whose `lastSync`
    // describes a credential that no longer exists. Keeping it would have the
    // settings page reporting a dead key against a live one.
    const { ctx, seed } = await world();
    stubFetch([{ status: 200, body: READ_ONLY_BODY }]);
    await run(ctx, seed.labId, KEY);
    const first = ctx.db.all("zoteroLinks")[0];
    await ctx.db.patch(first?._id ?? "", {
      lastSync: {
        at: 1,
        connectedAt: first?.connectedAt ?? 0,
        statusCode: 403,
        imported: 0,
        skipped: 0,
      },
      lastVersion: 8431,
      syncCursor: { targetVersion: 8431, start: 50, total: 400, imported: 12 },
    });

    stubFetch([{ status: 200, body: { ...READ_ONLY_BODY, key: SECOND_KEY } }]);
    await run(ctx, seed.labId, SECOND_KEY);

    const links = ctx.db.all("zoteroLinks");
    expect(links, "one member, one lab, one row").toHaveLength(1);
    expect(links[0]?.apiKey).toBe(SECOND_KEY);
    expect(links[0]?.lastSync).toBeUndefined();
    expect(links[0]?.syncCursor).toBeUndefined();
    expect(links[0]?.lastVersion).toBeUndefined();
  });

  it("files one ledger fact, carrying no key", async () => {
    const { ctx, seed } = await world();
    stubFetch([{ status: 200, body: READ_ONLY_BODY }]);
    await run(ctx, seed.labId, KEY);

    const events = ctx.db
      .all("events")
      .filter((e) => e.type === "zotero.link_changed");
    expect(events).toHaveLength(1);
    expect(events[0]?.connected).toBe(true);
    expect(events[0]?.actorId).toBe(seed.pi);
    expect(JSON.stringify(events[0])).not.toContain(KEY);
  });
});

/* --- the picker ------------------------------------------------------- */

describe("listLibraries", () => {
  /** `GET /users/<id>/groups` for one group the member belongs to. */
  const GROUPS_BODY = [
    { id: 234567, data: { id: 234567, name: "Rahmani Lab reading" } },
  ];

  type Libraries = { libraries: { type: string; id: string; name: string }[] };

  const list = async (ctx: FakeCtx, labId: Id<"labs">): Promise<Libraries> =>
    (await handlerOf(listLibraries)(ctx, { labId } as never)) as Libraries;

  /** One member, linked to their own library, exactly as `connect` leaves it. */
  async function linked() {
    const { ctx, seed } = await world();
    await ctx.db.insert("zoteroLinks", {
      userId: seed.pi,
      labId: seed.labId,
      apiKey: KEY,
      connectedAt: 1_000,
      libraryType: "user",
      libraryId: "475425",
    });
    return { ctx, seed };
  }

  it("asks about the member's own account, not the library in the row", async () => {
    const { ctx, seed } = await linked();
    const calls = stubFetch([
      { status: 200, body: READ_ONLY_BODY },
      { status: 200, body: GROUPS_BODY },
    ]);

    const answer = await list(ctx, seed.labId);
    expect(calls[0]?.url).toBe("https://api.zotero.org/keys/current");
    expect(calls[1]?.url).toContain("/users/475425/groups");
    expect(answer.libraries).toEqual([
      { type: "user", id: "475425", name: "My library" },
      { type: "group", id: "234567", name: "Rahmani Lab reading" },
    ]);
  });

  it("still offers the way back after the member has picked a group", async () => {
    // The bug this exists for. `libraryId` is the *scope*, and after a group is
    // chosen it is the group's id — so a picker built on it asks Zotero for
    // `/users/<groupId>/groups`, gets a 403 the key could never have satisfied,
    // and renders nothing: the member is stuck in the library they chose. Worse
    // still, "My library" would carry the group's id, and choosing it would
    // write a personal library that does not exist — every sync from then on a
    // 403, reported to the member as a revoked key.
    const { ctx, seed } = await linked();
    await handlerOf(chooseScope)(ctx, {
      labId: seed.labId,
      libraryType: "group",
      libraryId: "234567",
      libraryName: "Rahmani Lab reading",
    } as never);

    const calls = stubFetch([
      { status: 200, body: READ_ONLY_BODY },
      { status: 200, body: GROUPS_BODY },
    ]);
    const answer = await list(ctx, seed.labId);

    expect(calls[1]?.url).toContain("/users/475425/groups");
    expect(calls[1]?.url).not.toContain("/users/234567");
    expect(answer.libraries[0]).toEqual({
      type: "user",
      id: "475425",
      name: "My library",
    });
  });
});

/* --- scope, disconnect, status ---------------------------------------- */

describe("chooseScope", () => {
  const choose = (ctx: FakeCtx, args: Record<string, unknown>) =>
    handlerOf(chooseScope)(ctx, args as never);

  async function linked() {
    const { ctx, seed } = await world();
    await ctx.db.insert("zoteroLinks", {
      userId: seed.pi,
      labId: seed.labId,
      apiKey: KEY,
      connectedAt: 1_000,
      libraryType: "user",
      libraryId: "475425",
      lastVersion: 8431,
      syncCursor: { targetVersion: 8431, start: 75, total: 400, imported: 30 },
    });
    return { ctx, seed };
  }

  it("throws the version counter away when the library changes", async () => {
    // A `Last-Modified-Version` is a fact about one library. Carrying it to a
    // different one would have `?since=` silently skip everything older than a
    // number that means nothing there — a sync that imports two papers out of
    // four hundred and reports success.
    const { ctx, seed } = await linked();
    await choose(ctx, {
      labId: seed.labId,
      libraryType: "group",
      libraryId: "234567",
      libraryName: "Rahmani Lab reading",
    });
    const link = ctx.db.all("zoteroLinks")[0];
    expect(link?.libraryType).toBe("group");
    expect(link?.lastVersion).toBeUndefined();
    expect(link?.syncCursor).toBeUndefined();
  });

  it("throws it away when only the collection changes, too", async () => {
    // Narrowing the scope means items that were never in the walk are now in
    // it, and their versions are older than the mark. Same failure, same fix.
    const { ctx, seed } = await linked();
    await choose(ctx, {
      labId: seed.labId,
      libraryType: "user",
      libraryId: "475425",
      collectionKey: "C0LL3CTN",
      collectionName: "Thursday",
    });
    const link = ctx.db.all("zoteroLinks")[0];
    expect(link?.collectionKey).toBe("C0LL3CTN");
    expect(link?.lastVersion).toBeUndefined();
  });

  it("refuses a collection key that did not come from Zotero", async () => {
    // The picker sends keys it read out of `parseCollections`, but this is a
    // public mutation and that is a fact about the client. A stored key is
    // interpolated into a path, and the empty string builds
    // `/collections//items/top` — a request about a library nobody named.
    const { ctx, seed } = await linked();
    for (const collectionKey of ["", "../..", "a b", "C0LL3CTN/x"]) {
      await expect(
        choose(ctx, {
          labId: seed.labId,
          libraryType: "user",
          libraryId: "475425",
          collectionKey,
        }),
      ).rejects.toBeInstanceOf(ConvexError);
    }
    expect(ctx.db.all("zoteroLinks")[0]?.collectionKey).toBeUndefined();
  });

  it("refuses a library id that did not come from Zotero", async () => {
    // Same argument, one argument earlier: `parseKeyPermissions` and
    // `parseGroups` only ever produce digits, and the empty string builds
    // `/users//collections`. A guard on the collection key alone would leave
    // the id beside it unwatched.
    const { ctx, seed } = await linked();
    for (const libraryId of ["", "..", "Rahmani Lab", "475425/x"]) {
      await expect(
        choose(ctx, {
          labId: seed.labId,
          libraryType: "group",
          libraryId,
        }),
      ).rejects.toBeInstanceOf(ConvexError);
    }
    expect(ctx.db.all("zoteroLinks")[0]?.libraryType).toBe("user");
  });

  it("refuses when this member has no link to scope", async () => {
    const { ctx, seed } = await world();
    await expect(
      choose(ctx, {
        labId: seed.labId,
        libraryType: "user",
        libraryId: "475425",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("disconnect", () => {
  const run = (ctx: FakeCtx, labId: Id<"labs">) =>
    handlerOf(disconnect)(ctx, { labId } as never);

  it("removes the row rather than blanking it", async () => {
    const { ctx, seed } = await world();
    await ctx.db.insert("zoteroLinks", {
      userId: seed.pi,
      labId: seed.labId,
      apiKey: KEY,
      connectedAt: 1_000,
      libraryType: "user",
      libraryId: "475425",
    });
    await run(ctx, seed.labId);
    expect(ctx.db.all("zoteroLinks")).toHaveLength(0);
    expect(
      ctx.db.all("events").filter((e) => e.type === "zotero.link_changed"),
    ).toHaveLength(1);
  });

  it("leaves the lab's papers exactly where they are", async () => {
    // They are the lab's. A member unlinking their own account must not
    // silently strip a shelf everybody else has been annotating.
    const { ctx, seed } = await world();
    await ctx.db.patch(seed.paperId, { zoteroItemKey: "ABCD2345" });
    await ctx.db.insert("zoteroLinks", {
      userId: seed.pi,
      labId: seed.labId,
      apiKey: KEY,
      connectedAt: 1_000,
      libraryType: "user",
      libraryId: "475425",
    });
    await run(ctx, seed.labId);
    expect(await ctx.db.get(seed.paperId)).not.toBeNull();
  });

  it("is a no-op with no ledger fact when there was no link", async () => {
    const { ctx, seed } = await world();
    await run(ctx, seed.labId);
    expect(
      ctx.db.all("events").filter((e) => e.type === "zotero.link_changed"),
    ).toHaveLength(0);
  });
});

describe("status", () => {
  /** What the settings row is handed; the handler's own shape, minus the key. */
  type Status = {
    connected: boolean;
    libraryName: string | null;
    collectionName: string | null;
    lastSyncAt: number | null;
    lastSyncFailed: { at: number; statusCode: number } | null;
    progress: { checked: number; total: number; imported: number } | null;
    lastImported: number | null;
  };

  const read = async (ctx: FakeCtx, labId: Id<"labs">): Promise<Status> =>
    (await handlerOf(status)(ctx, { labId } as never)) as Status;

  it("says nothing at all to a member of no lab", async () => {
    const { ctx, seed } = await world();
    ctx.auth = { userId: "users_999" };
    expect(await read(ctx, seed.labId)).toMatchObject({ connected: false });
  });

  it("never carries the key, whatever else it says", async () => {
    const { ctx, seed } = await world();
    await ctx.db.insert("zoteroLinks", {
      userId: seed.pi,
      labId: seed.labId,
      apiKey: KEY,
      connectedAt: 1_000,
      libraryType: "group",
      libraryId: "234567",
      libraryName: "Rahmani Lab reading",
      collectionName: "Thursday",
      lastSyncAt: 2_000,
      lastSync: { at: 2_000, connectedAt: 1_000, imported: 12, skipped: 3 },
    });
    const answer = await read(ctx, seed.labId);
    expect(JSON.stringify(answer)).not.toContain(KEY);
    expect(answer).toMatchObject({
      connected: true,
      libraryName: "Rahmani Lab reading",
      collectionName: "Thursday",
      lastSyncAt: 2_000,
      lastSyncFailed: null,
    });
  });

  it("reports a refusal only while it describes the key in the row", async () => {
    // The same staleness rule `slack.status` applies at `convex/slack.ts:
    // 292-294`: a 403 against a key the member has already replaced says
    // nothing about the one that replaced it.
    const { ctx, seed } = await world();
    await ctx.db.insert("zoteroLinks", {
      userId: seed.pi,
      labId: seed.labId,
      apiKey: KEY,
      connectedAt: 5_000,
      libraryType: "user",
      libraryId: "475425",
      lastSync: {
        at: 2_000,
        connectedAt: 1_000,
        statusCode: 403,
        imported: 0,
        skipped: 0,
      },
    });
    expect((await read(ctx, seed.labId)).lastSyncFailed).toBeNull();
  });

  it("shows how far a walk has got, honestly", async () => {
    const { ctx, seed } = await world();
    await ctx.db.insert("zoteroLinks", {
      userId: seed.pi,
      labId: seed.labId,
      apiKey: KEY,
      connectedAt: 1_000,
      libraryType: "user",
      libraryId: "475425",
      syncCursor: { targetVersion: 8431, start: 75, total: 412, imported: 40 },
    });
    expect((await read(ctx, seed.labId)).progress).toEqual({
      checked: 75,
      total: 412,
      imported: 40,
    });
  });

  it("cannot see another member's link", async () => {
    // The product promise, asserted rather than commented. A Zotero library is
    // one person's reading, and the PI does not get to see whose is wired.
    const { ctx, seed } = await world();
    await ctx.db.insert("zoteroLinks", {
      userId: seed.member,
      labId: seed.labId,
      apiKey: KEY,
      connectedAt: 1_000,
      libraryType: "user",
      libraryId: "475425",
    });
    expect(await read(ctx, seed.labId)).toMatchObject({ connected: false });
  });
});
