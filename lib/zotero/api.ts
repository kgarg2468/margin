/**
 * How to address the Zotero Web API, and what it says back.
 *
 * Everything in this file is a pure function, which is the point: the whole
 * of Margin's understanding of Zotero's protocol — which URL, which item
 * types, what a read-only key looks like, when to back off — is testable
 * against canned responses with no network anywhere. `convex/zotero.ts` is
 * then a thin thing that does `fetch` and holds a credential, and there is
 * one place to be wrong about the protocol rather than two.
 *
 * The one rule this file exists to make structural: **the key is a header.**
 * Zotero accepts `?key=` and its own documentation recommends against it, for
 * the reasons every credential in a query string has — an access log on every
 * hop, an echo in the `Link` headers the API returns, and an interpolation
 * into the first error message somebody writes. None of the builders below
 * takes a key, so none of them can put one in a URL.
 */

import { cleanReferenceText } from "../reference-import/normalize";

export const ZOTERO_API_ORIGIN = "https://api.zotero.org";

/** Sent as `Zotero-API-Version` on every request; v3 is current. */
export const ZOTERO_API_VERSION = "3";

/**
 * A pasted Zotero API key, or `null` if it is not one.
 *
 * Zotero issues 24 alphanumeric characters. The check is a little wider than
 * that on purpose — this is not the authority on Zotero's key format and a
 * length that shifts by a character should not lock members out of the
 * product. What it is for is catching the paste that is obviously not a key,
 * in front of the person who made it: the settings *URL* instead of the key,
 * a key with `Bearer ` still stuck to the front, half a selection with a
 * space in it. The real verification is `GET /keys/current`, which happens a
 * moment later and says something specific when it fails.
 *
 * Whitespace is trimmed because a key copied out of Zotero's own settings
 * page arrives with a newline on it more often than not, and refusing that
 * would be pedantry rather than safety.
 */
export function normalizeApiKey(raw: string): string | null {
  const trimmed = raw.trim();
  return /^[A-Za-z0-9]{16,64}$/.test(trimmed) ? trimmed : null;
}

/**
 * Which library. `"user"` carries a Zotero userID — **not** a username; the
 * two are different and only the first addresses anything.
 */
export type ZoteroLibrary = { type: "user" | "group"; id: string };

/**
 * One path segment, encoded so that it stays one path segment.
 *
 * Every id below is somebody else's string. A library id and a collection key
 * are typed or picked by a member; an item key and an attachment key are read
 * out of remote JSON. Interpolated raw, a `?` in any of them ends the path and
 * starts a query string — which is precisely how a set of builders that cannot
 * be *handed* a credential ends up *emitting* one, from a collection named
 * `A?key=SECRET`. A `#` truncates the rest of the URL into a fragment, and a
 * `/` re-targets the request at a path nobody asked for.
 *
 * `encodeURIComponent` is most of the fix: it escapes `?`, `#`, `/`, `%` and
 * whitespace, so a hostile segment lands inside the segment it was written
 * into and Zotero answers 404 to it instead of Margin answering something
 * worse. What it cannot fix is a segment that *is* `.` or `..` — the URL
 * parser resolves those before any encoding is visible to it (the WHATWG spec
 * reads `%2E` as a dot for exactly that check), and in the library-id
 * position the prefix itself is what a `..` walks out of. No representation
 * of a dot segment survives parsing, so the two of them — never a real
 * Zotero id, which are numbers and alphanumeric keys — are replaced outright:
 * still one segment, still a 404, never a traversal.
 */
function encodeSegment(segment: string): string {
  if (segment === "." || segment === "..") return "-";
  return encodeURIComponent(segment);
}

export function libraryPrefix(library: ZoteroLibrary): string {
  return library.type === "user"
    ? `/users/${encodeSegment(library.id)}`
    : `/groups/${encodeSegment(library.id)}`;
}

/**
 * The item types a journal club reads.
 *
 * A real Zotero library is mostly not these: attachments, notes, annotations,
 * web pages, blog posts and emails outnumber the papers in most of them. The
 * filter is applied server-side rather than after the fetch so the per-run cap
 * is spent on candidates rather than on furniture.
 *
 * `bookSection` and `book` are here because a lab that reads a chapter reads
 * a chapter; `report` and `thesis` because a methods club reads those and
 * nothing else in the product cares what kind of document a paper is.
 */
export const SCHOLARLY_ITEM_TYPES = [
  "journalArticle",
  "preprint",
  "conferencePaper",
  "bookSection",
  "thesis",
  "report",
  "book",
] as const;

function apiUrl(path: string): URL {
  return new URL(`${ZOTERO_API_ORIGIN}${path}`);
}

/** The call that says whether a key works and what it can see. */
export function keysCurrentUrl(): string {
  return apiUrl("/keys/current").toString();
}

/** The group libraries a userID can reach. */
export function groupsUrl(userId: string): string {
  const url = apiUrl(`/users/${encodeSegment(userId)}/groups`);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "100");
  return url.toString();
}

/** One library's collections, for the picker that scopes a sync. */
export function collectionsUrl(library: ZoteroLibrary): string {
  const url = apiUrl(`${libraryPrefix(library)}/collections`);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "100");
  return url.toString();
}

/**
 * One page of candidate items.
 *
 * `/items/top` rather than `/items`: the `top` variants exclude child
 * attachments and notes, which are most of a library and none of them papers.
 *
 * `sort=dateAdded&direction=asc` is load-bearing and not a preference. The
 * walk is offset-paginated across several runs — `start` advances, the library
 * keeps being used in between — and offset pagination over a set that is being
 * reordered underneath skips rows silently. Ascending by date added is the one
 * ordering a growing library does not disturb: new items append past the end
 * of the window instead of shifting it.
 */
export function itemsUrl(options: {
  library: ZoteroLibrary;
  collectionKey?: string;
  since?: number;
  start: number;
  limit: number;
}): string {
  const prefix = libraryPrefix(options.library);
  const path =
    options.collectionKey === undefined
      ? `${prefix}/items/top`
      : `${prefix}/collections/${encodeSegment(options.collectionKey)}/items/top`;
  const url = apiUrl(path);
  url.searchParams.set("format", "json");
  url.searchParams.set("itemType", SCHOLARLY_ITEM_TYPES.join(" || "));
  url.searchParams.set("sort", "dateAdded");
  url.searchParams.set("direction", "asc");
  url.searchParams.set("start", String(options.start));
  url.searchParams.set("limit", String(options.limit));
  if (options.since !== undefined) {
    url.searchParams.set("since", String(options.since));
  }
  return url.toString();
}

/** One item's attachments and notes. */
export function childrenUrl(library: ZoteroLibrary, itemKey: string): string {
  const url = apiUrl(
    `${libraryPrefix(library)}/items/${encodeSegment(itemKey)}/children`,
  );
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "50");
  return url.toString();
}

/**
 * The stored file behind one attachment.
 *
 * This is the address that answers `302` to a presigned Amazon URL rather than
 * bytes. The caller must not let `fetch` follow that redirect with the key
 * still on the request — see `convex/zotero.ts`, where that rule lives with
 * the credential it protects.
 */
export function fileUrl(
  library: ZoteroLibrary,
  attachmentKey: string,
): string {
  return apiUrl(
    `${libraryPrefix(library)}/items/${encodeSegment(attachmentKey)}/file`,
  ).toString();
}

/**
 * What a key is and what it may do — never what it is.
 *
 * `GET /keys/current` answers with the credential itself in the body, which is
 * the reason this function exists rather than the raw object being passed
 * around: something that carried the whole response would put the key in every
 * caller's hands and, eventually, in a returns validator.
 *
 * `readOnly` is false if the key can write **anywhere** — the personal library
 * or any group. Margin asks for a read-only key and refuses a writing one, so
 * that the worst case of a breach here is disclosure of what somebody reads
 * rather than the destruction of a fifteen-year bibliography.
 *
 * `canRead` is the other half of that question, and it is a separate field
 * because the two failures need different sentences. A key with no `access`
 * block at all — created and never granted anything, or narrowed to nothing
 * afterwards — is not writable, so `readOnly` is true and a connect flow that
 * only checks `!readOnly` waves it through. The first sync then 403s, and the
 * member is told Zotero does not recognise their key, which is false and
 * unactionable: the key is fine, its permissions are empty. Ask `canRead` at
 * the door and the refusal can say the true thing instead.
 */
export type KeyPermissions = {
  userId: string;
  readOnly: boolean;
  /** Whether the key can read *any* library — false for a key granted nothing. */
  canRead: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Truthy rather than `=== true`, deliberately.
 *
 * Zotero answers JSON booleans today, but this decides whether Margin will
 * hold a key that can destroy a bibliography, and the safe reading of a `1`,
 * a `"true"` or anything else unexpected in a `write` field is "yes, it
 * writes." Strict equality fails the other way: it reads every one of those as
 * read-only and accepts the key.
 */
function canWrite(scope: unknown): boolean {
  return isRecord(scope) && Boolean(scope.write);
}

/**
 * `=== true` rather than truthy — the mirror of `canWrite`, because the safe
 * direction runs the other way here. For `write`, an unexpected value must
 * read as "it writes" so the key is refused; for `library`, an unexpected
 * value must read as "it grants nothing", because this gate exists so the
 * connect flow can refuse a no-read key with a true sentence. Believing a
 * `"false"` or a `1` accepts the key and hands the member the exact 403-later
 * failure `canRead` was added to prevent.
 */
function canRead(scope: unknown): boolean {
  return isRecord(scope) && scope.library === true;
}

export function parseKeyPermissions(body: unknown): KeyPermissions | null {
  if (!isRecord(body)) return null;
  const userId = body.userID;
  if (typeof userId !== "number" || !Number.isInteger(userId)) return null;

  const access = isRecord(body.access) ? body.access : {};
  const groups = isRecord(access.groups) ? Object.values(access.groups) : [];
  const writes = canWrite(access.user) || groups.some(canWrite);
  const reads = canRead(access.user) || groups.some(canRead);

  return { userId: String(userId), readOnly: !writes, canRead: reads };
}

export type ZoteroGroup = { id: string; name: string };

/**
 * The group libraries in a `/groups` response.
 *
 * A malformed entry is skipped rather than thrown on. One unexpected row in a
 * list of libraries should cost a member one option in a picker, not the
 * ability to connect at all — and Zotero is a fifteen-year-old API with
 * fifteen years of rows in it.
 */
export function parseGroups(body: unknown): ZoteroGroup[] {
  if (!Array.isArray(body)) return [];
  return body.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const data = isRecord(entry.data) ? entry.data : {};
    const id = entry.id ?? data.id;
    const name = data.name;
    if (typeof id !== "number" && typeof id !== "string") return [];
    if (typeof name !== "string" || name.length === 0) return [];
    return [{ id: String(id), name: cleanReferenceText(name) }];
  });
}

export type ZoteroCollection = { key: string; name: string };

/** The collections in a `/collections` response, same forgiveness. */
export function parseCollections(body: unknown): ZoteroCollection[] {
  if (!Array.isArray(body)) return [];
  return body.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const data = isRecord(entry.data) ? entry.data : {};
    const key = entry.key ?? data.key;
    const name = data.name;
    if (typeof key !== "string" || key.length === 0) return [];
    if (typeof name !== "string" || name.length === 0) return [];
    return [{ key, name: cleanReferenceText(name) }];
  });
}

/**
 * The longest pause this module will take inside one run.
 *
 * Above it, `readSyncHeaders` answers `null` and the run ends rather than
 * waiting. That is the right shape here in a way it would not be elsewhere:
 * the sync cursor is durable, so ending a run early costs nothing but time
 * that was going to be spent waiting anyway, and the next sweep picks the walk
 * up exactly where it stopped. An action holding itself open for ten minutes
 * to honour a backoff is an action the platform kills for its trouble.
 */
export const MAX_BACKOFF_MS = 30_000;

export type SyncHeaders = {
  /** The library's current version, or `null` if the response did not say. */
  lastModifiedVersion: number | null;
  /** How many objects match, or `null` if the response did not say. */
  totalResults: number | null;
  /** How long to wait before the next request, or `null` for "don't wait". */
  backoffMs: number | null;
};

function readInt(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * The three things a Zotero response says about syncing, out of its headers.
 *
 * `null` rather than `0` for an absent header, everywhere. Zero is a real
 * library version and a real result count, and conflating "Zotero did not say"
 * with "Zotero said none" is exactly how a walk concludes it has finished
 * before it has started.
 *
 * `Backoff` may appear on **any** response, including a successful one — it is
 * Zotero asking for room rather than refusing a request, which is why it is
 * read here alongside the other two rather than in the error path.
 */
export function readSyncHeaders(headers: Headers): SyncHeaders {
  const backoffSeconds = readInt(headers.get("backoff"));
  const backoffMs = backoffSeconds === null ? null : backoffSeconds * 1000;
  return {
    lastModifiedVersion: readInt(headers.get("last-modified-version")),
    totalResults: readInt(headers.get("total-results")),
    backoffMs:
      backoffMs === null || backoffMs > MAX_BACKOFF_MS ? null : backoffMs,
  };
}
