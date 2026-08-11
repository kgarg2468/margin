import { describe, expect, it } from "vitest";
import {
  MAX_BACKOFF_MS,
  ZOTERO_API_ORIGIN,
  childrenUrl,
  collectionsUrl,
  fileUrl,
  groupsUrl,
  itemsUrl,
  keysCurrentUrl,
  libraryPrefix,
  normalizeApiKey,
  parseCollections,
  parseGroups,
  parseKeyPermissions,
  readSyncHeaders,
} from "./api";

/** A real-shaped Zotero key: 24 alphanumeric characters, no punctuation. */
const KEY = "P9NiFoyLeZu2bZNvvuQPDWsd";
const USER = { type: "user", id: "475425" } as const;
const GROUP = { type: "group", id: "234567" } as const;

describe("normalizeApiKey", () => {
  it("takes a key with the whitespace a paste brings", () => {
    expect(normalizeApiKey(`  ${KEY}\n`)).toBe(KEY);
  });

  it("refuses the settings URL people paste instead of the key", () => {
    // What actually happens: somebody copies the address bar of the page the
    // key is on. Refused here, in front of them, rather than as a 403 an hour
    // later in a sweep nobody is watching.
    expect(normalizeApiKey("https://www.zotero.org/settings/keys")).toBeNull();
  });

  it("refuses a key with anything but letters and digits in it", () => {
    expect(normalizeApiKey(`${KEY} extra`)).toBeNull();
    expect(normalizeApiKey("Bearer P9NiFoyLeZu2bZNvvuQPDWsd")).toBeNull();
    expect(normalizeApiKey("P9NiFoyLeZu2bZNvvuQPDW-d")).toBeNull();
  });

  it("refuses something far too short to be one", () => {
    expect(normalizeApiKey("abc123")).toBeNull();
    expect(normalizeApiKey("")).toBeNull();
    expect(normalizeApiKey("   ")).toBeNull();
  });
});

describe("libraryPrefix", () => {
  it("addresses a personal library by the userID, not the username", () => {
    expect(libraryPrefix(USER)).toBe("/users/475425");
  });

  it("addresses a group library by its group id", () => {
    expect(libraryPrefix(GROUP)).toBe("/groups/234567");
  });
});

describe("the URLs", () => {
  it("never carries a credential, in any of them", () => {
    // The property that matters most in this file. Zotero accepts `?key=` and
    // its own documentation says not to use it: a credential in a query string
    // is a credential in every access log on the path and in every `Link`
    // header the API echoes back. None of these builders can even be handed
    // one — but assert on the output too, because a signature is a promise and
    // a string is a fact.
    const urls = [
      keysCurrentUrl(),
      groupsUrl("475425"),
      collectionsUrl(USER),
      itemsUrl({ library: USER, start: 0, limit: 25 }),
      childrenUrl(USER, "ABCD2345"),
      fileUrl(USER, "EFGH6789"),
    ];
    for (const url of urls) {
      expect(url.startsWith(`${ZOTERO_API_ORIGIN}/`)).toBe(true);
      expect(url).not.toMatch(/[?&]key=/);
      expect(url).not.toContain(KEY);
    }
  });

  it("walks a whole library from /items/top", () => {
    const url = new URL(itemsUrl({ library: USER, start: 50, limit: 25 }));
    expect(url.pathname).toBe("/users/475425/items/top");
    expect(url.searchParams.get("start")).toBe("50");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("format")).toBe("json");
    // Ascending by date added: the walk is offset-paginated, and this is the
    // one ordering a library that is being added to does not shift underneath.
    expect(url.searchParams.get("sort")).toBe("dateAdded");
    expect(url.searchParams.get("direction")).toBe("asc");
    // Nothing about `since` when there is no previous version to be since.
    expect(url.searchParams.has("since")).toBe(false);
  });

  it("walks one collection when the member scoped it to one", () => {
    const url = new URL(
      itemsUrl({ library: GROUP, collectionKey: "C0LL3CTN", start: 0, limit: 25 }),
    );
    expect(url.pathname).toBe("/groups/234567/collections/C0LL3CTN/items/top");
  });

  it("asks only for the item types a journal club reads", () => {
    const url = new URL(itemsUrl({ library: USER, start: 0, limit: 25 }));
    const filter = url.searchParams.get("itemType") ?? "";
    expect(filter).toContain("journalArticle");
    expect(filter).toContain("preprint");
    expect(filter).toContain("conferencePaper");
    // Zotero's boolean-ish syntax for "any of these".
    expect(filter).toContain("||");
    // And not the noise: an attachment, a note and a web page are not papers.
    expect(filter).not.toContain("attachment");
    expect(filter).not.toContain("webpage");
  });

  it("carries the version it is asking since", () => {
    const url = new URL(itemsUrl({ library: USER, since: 8431, start: 0, limit: 25 }));
    expect(url.searchParams.get("since")).toBe("8431");
  });
});

describe("the URLs, built from segments nobody sanitised", () => {
  // The pin above proves the builders do not *add* a credential, on input that
  // is already well formed. This proves they cannot be made to grow one. Every
  // id in a Zotero URL is somebody else's string: a library id and a collection
  // key are typed or picked by a member, and an item key and an attachment key
  // are read straight out of remote JSON. Interpolated raw, a collection named
  // `A?key=SECRET` turns a builder that takes no key into one that emits one.
  const SEPARATORS = [
    "A?key=SECRET",
    "A#fragment",
    "1/../groups/9",
    "a b",
    "%2F",
    "A&key=SECRET",
  ];

  it("keeps a separator inside the segment it was written into", () => {
    for (const segment of SEPARATORS) {
      const escaped = encodeURIComponent(segment);

      expect(
        new URL(itemsUrl({ library: USER, collectionKey: segment, start: 0, limit: 25 }))
          .pathname,
      ).toBe(`/users/475425/collections/${escaped}/items/top`);
      expect(new URL(childrenUrl(USER, segment)).pathname).toBe(
        `/users/475425/items/${escaped}/children`,
      );
      expect(new URL(fileUrl(USER, segment)).pathname).toBe(
        `/users/475425/items/${escaped}/file`,
      );
      expect(new URL(collectionsUrl({ type: "group", id: segment })).pathname).toBe(
        `/groups/${escaped}/collections`,
      );
      expect(new URL(groupsUrl(segment)).pathname).toBe(`/users/${escaped}/groups`);
    }
  });

  it("still carries no credential, whatever a segment says", () => {
    // A dot segment is in the corpus on purpose: the URL parser resolves `.`
    // and `..` before any encoding is visible to it, so the property that
    // survives is not "the segment is preserved" but "the URL still addresses
    // the library it was built for, and still has no key on it".
    for (const segment of [...SEPARATORS, "..", ".", "?key=SECRET"]) {
      const urls = [
        itemsUrl({ library: USER, collectionKey: segment, start: 0, limit: 25 }),
        childrenUrl(USER, segment),
        fileUrl(USER, segment),
      ];
      for (const raw of urls) {
        // The text "SECRET" may well still be in there — escaped, as part of
        // an absurd collection key. What must never be there is a `key`
        // *parameter*, which is the thing an access log records and the API
        // would read as a credential.
        expect(raw).not.toMatch(/[?&]key=/);
        expect(new URL(raw).searchParams.has("key")).toBe(false);
        expect(new URL(raw).pathname.startsWith("/users/475425/")).toBe(true);
      }
    }
  });
});

describe("parseKeyPermissions", () => {
  /** What `GET /keys/current` actually answers, key and all. */
  const body = {
    key: KEY,
    userID: 475425,
    username: "arahmani",
    access: {
      user: { library: true, files: true, notes: true, write: false },
      groups: { all: { library: true, write: false } },
    },
  };

  it("reads the userID, which is not the username", () => {
    expect(parseKeyPermissions(body)?.userId).toBe("475425");
  });

  it("never carries the key back out of the response that echoes it", () => {
    // `/keys/current` answers with the credential in the body. Anything that
    // parsed the whole object and passed it around would put the key in every
    // caller's hands and, sooner or later, in a returns validator.
    expect(JSON.stringify(parseKeyPermissions(body))).not.toContain(KEY);
  });

  it("recognises a read-only key", () => {
    expect(parseKeyPermissions(body)?.readOnly).toBe(true);
  });

  it("recognises a key that can write to the personal library", () => {
    const writable = { ...body, access: { ...body.access, user: { library: true, write: true } } };
    expect(parseKeyPermissions(writable)?.readOnly).toBe(false);
  });

  it("recognises a key that can write to any group", () => {
    const writable = {
      ...body,
      access: { user: { library: true, write: false }, groups: { 234567: { library: true, write: true } } },
    };
    expect(parseKeyPermissions(writable)?.readOnly).toBe(false);
  });

  it("believes any truthy write, not only the boolean", () => {
    // `=== true` fails toward accepting the key. If Zotero ever answers a `1`
    // here, the safe reading is "it writes" — the cost of being wrong that way
    // is a refusal the member can fix, and the cost of being wrong the other
    // way is Margin holding a key that can delete a career's bibliography.
    const writable = { ...body, access: { user: { library: true, write: 1 } } };
    expect(parseKeyPermissions(writable)?.readOnly).toBe(false);
  });

  it("says a normal key can read", () => {
    expect(parseKeyPermissions(body)?.canRead).toBe(true);
  });

  it("says a key granted nothing cannot read, though it cannot write either", () => {
    // The case that needs its own field. A key with no access block is not
    // writable, so `readOnly` is true and a connect flow checking only that
    // waves it through — and the first sync 403s, and the member is told
    // Zotero does not recognise their key, which is false. The key is fine;
    // its permissions are empty. `canRead` is how the refusal says so.
    for (const empty of [{ userID: 475425 }, { userID: 475425, access: {} }]) {
      const read = parseKeyPermissions(empty);
      expect(read?.readOnly).toBe(true);
      expect(read?.canRead).toBe(false);
    }
  });

  it("says a key with the library switched off cannot read", () => {
    const narrowed = { ...body, access: { user: { library: false, files: true } } };
    expect(parseKeyPermissions(narrowed)?.canRead).toBe(false);
  });

  it("says a group-only key can read", () => {
    // A member whose key reaches no personal library but one shared group is
    // connectable, and the group is the whole point of connecting.
    const groupOnly = {
      ...body,
      access: { groups: { 234567: { library: true, write: false } } },
    };
    const read = parseKeyPermissions(groupOnly);
    expect(read?.canRead).toBe(true);
    expect(read?.readOnly).toBe(true);
  });

  it("refuses a body that is not a key description at all", () => {
    // A proxy's error page, an HTML login redirect, an empty 200 — all of them
    // parse as JSON often enough to matter, and none of them says anything
    // about a key.
    expect(parseKeyPermissions(null)).toBeNull();
    expect(parseKeyPermissions({})).toBeNull();
    expect(parseKeyPermissions({ userID: "not a number" })).toBeNull();
  });
});

describe("parseGroups", () => {
  it("takes the id and the name and leaves the rest", () => {
    const body = [
      { id: 234567, version: 12, data: { id: 234567, name: "Rahmani Lab reading", type: "PublicClosed" } },
      { id: 891011, version: 3, data: { id: 891011, name: "Methods club", type: "Private" } },
    ];
    expect(parseGroups(body)).toEqual([
      { id: "234567", name: "Rahmani Lab reading" },
      { id: "891011", name: "Methods club" },
    ]);
  });

  it("skips a malformed entry rather than failing the whole list", () => {
    // One unexpected row should cost a member one group in a picker, not the
    // ability to connect at all.
    expect(parseGroups([{ id: 1 }, { id: 2, data: { name: "Real" } }])).toEqual([
      { id: "2", name: "Real" },
    ]);
  });

  it("answers with nothing for a body that is not a list", () => {
    expect(parseGroups({ error: "nope" })).toEqual([]);
  });
});

describe("parseCollections", () => {
  it("takes the key and the name", () => {
    const body = [
      { key: "C0LL3CTN", version: 9, data: { key: "C0LL3CTN", name: "Thursday", parentCollection: false } },
    ];
    expect(parseCollections(body)).toEqual([{ key: "C0LL3CTN", name: "Thursday" }]);
  });

  it("answers with nothing for a body that is not a list", () => {
    expect(parseCollections("<html>")).toEqual([]);
  });
});

describe("readSyncHeaders", () => {
  const headers = (entries: Record<string, string>) => new Headers(entries);

  it("reads the library version and the result count", () => {
    const read = readSyncHeaders(
      headers({ "Last-Modified-Version": "8431", "Total-Results": "1274" }),
    );
    expect(read.lastModifiedVersion).toBe(8431);
    expect(read.totalResults).toBe(1274);
  });

  it("says null rather than zero when a header is absent", () => {
    // Zero is a real library version and a real result count. Conflating
    // "Zotero did not say" with "Zotero said none" is how a walk decides it
    // has finished before it started.
    const read = readSyncHeaders(headers({}));
    expect(read.lastModifiedVersion).toBeNull();
    expect(read.totalResults).toBeNull();
  });

  it("believes a Backoff, in seconds, converted to milliseconds", () => {
    expect(readSyncHeaders(headers({ Backoff: "3" })).backoffMs).toBe(3000);
  });

  it("refuses to believe a backoff longer than a run will wait", () => {
    // `null` above the ceiling rather than a clamped wait: a request told to
    // come back in ten minutes should end the run and let the cursor bring it
    // back next hour, not hold an action open pretending to sleep.
    expect(readSyncHeaders(headers({ Backoff: "600" })).backoffMs).toBeNull();
    expect(MAX_BACKOFF_MS).toBeLessThan(600_000);
  });

  it("ignores a backoff that is not a number", () => {
    expect(readSyncHeaders(headers({ Backoff: "soon" })).backoffMs).toBeNull();
    expect(readSyncHeaders(headers({ Backoff: "-5" })).backoffMs).toBeNull();
  });
});
