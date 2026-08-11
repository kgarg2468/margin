import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { pause, retryAfterMs } from "./auth";
import { getMembership, requireMembership, requireUserId } from "./lib/authz";
import { isPlausibleDoi, normalizeDoi } from "./lib/doi";
import { recordEvent } from "./lib/ledger";
import { nextRedirectHop } from "./lib/scholarly";
import { cleanAuthors, cleanTitle, pdfFromResponse } from "./papers";
import { referenceIdentity } from "../lib/reference-import/normalize";
import {
  ZOTERO_API_VERSION,
  childrenUrl,
  collectionsUrl,
  fileUrl,
  groupsUrl,
  itemsUrl,
  keysCurrentUrl,
  normalizeApiKey,
  parseCollections,
  parseGroups,
  parseKeyPermissions,
  readSyncHeaders,
  type ZoteroLibrary,
} from "../lib/zotero/api";
import {
  pickPdfAttachment,
  toReference,
  type ZoteroItem,
  type ZoteroReference,
} from "../lib/zotero/items";

/**
 * Zotero, one way: a member's library, read onto the lab's shelf.
 *
 * ## Why one direction
 *
 * `docs/STRATEGY.md:121` — *"Don't rebuild citation management — 'Keep Zotero'
 * is the pitch."* A two-way sync is a bid to become the citation manager,
 * which is a promise Margin would then have to keep against Word plugins, CSL
 * styles and four hundred item types. It is also asymmetric in what it costs
 * to get wrong: reading a library and getting it wrong leaves a duplicate row
 * Margin can delete, and writing to one and getting it wrong corrupts a PI's
 * fifteen-year bibliography. So the key Margin asks for is read-only, and
 * `connect` refuses a write-scoped one rather than merely not using the scope.
 *
 * ## Why the credential is one member's and the Slack webhook is the lab's
 *
 * A Zotero personal library is a reading history. `convex/privacy.guard.test.ts`
 * exists because Margin does not store those, and a lab-wide Zotero key would
 * hand every member the PI's. So the row is keyed `(userId, labId)`, nobody
 * can see or manage anybody else's, and `status` answers about the caller's
 * own link and nothing else. The *destination* is still the lab: papers land
 * on the lab's shelf and stay there when a link goes.
 *
 * ## The redirect
 *
 * A file download answers `302` to a presigned Amazon URL. The WHATWG fetch
 * spec strips `Authorization` on a cross-origin redirect and strips *nothing
 * else* — a custom key header rides along. So the naive spelling of a download
 * hands a member's key to a storage host, and the only reason nobody notices
 * is that it works. Every request this module makes therefore carries
 * `redirect: "manual"`, and the follow-up hop is re-issued with no credential
 * on it at all. That rule lives in `zoteroFetch` rather than at the download
 * site, because a rule at one call site has a second call site coming.
 */

/* -------------------------------------------------------------------------
 * The transport
 * ---------------------------------------------------------------------- */

/**
 * Zotero declining to answer a request.
 *
 * Carries the HTTP status separately from the message for the reason
 * `SlackRefusal` does (`convex/slack.ts:103-124`): the two have different
 * audiences. The message goes to the deployment log and is for whoever is
 * debugging; the status is the only part fit to show a member — the difference
 * between "Zotero was busy" and "that key has been revoked". `null` means the
 * request never got an answer at all.
 *
 * The response body is in the message and not in a field, deliberately, so
 * nothing can idly forward it to a client. The key is in neither.
 */
export class ZoteroRefusal extends Error {
  readonly status: number | null;

  constructor(why: string, status: number | null) {
    super(`Zotero refused a request: ${why}`);
    this.name = "ZoteroRefusal";
    this.status = status;
  }
}

/**
 * The statuses that mean *this key will not work again*, rather than *not just
 * now*.
 *
 * A revoked key answers `403`; a group the member was removed from, or a
 * library that no longer exists, `404`. Those are facts about the member's own
 * Zotero account and they are the only one who can fix them, which is what
 * earns them a line on the settings row. A `5xx`, a `429` that outlasted its
 * one retry, and a request that never got an answer are facts about a Tuesday.
 */
export function permanentStatus(caught: unknown): number | null {
  if (!(caught instanceof ZoteroRefusal)) return null;
  const { status } = caught;
  if (status === null || status === 429) return null;
  return status >= 400 && status < 500 ? status : null;
}

/** One re-ask, and only for the refusal that names a time to come back at. */
const READ_ATTEMPTS = 2;

/**
 * One request to Zotero, with the credential in a header and nowhere else.
 *
 * Three rules, all of them structural rather than remembered:
 *
 *   - **`redirect: "manual"`, always.** See the module header. A credentialed
 *     request must never follow a redirect, and the cheapest way to guarantee
 *     that is for the transport to refuse to.
 *   - **Only a `429` is re-asked.** `postToSlack` reaches the same rule from a
 *     different direction — it has no idempotency key, so a re-ask risks a
 *     duplicate post. A `GET` has no such hazard, but it does not need the
 *     retry either: the sync cursor is durable, so a run that ends on a `503`
 *     resumes from the same offset an hour later. A second recovery mechanism
 *     inside the run would be a second thing to get wrong for a case the first
 *     one already handles. `retryAfterMs` is imported rather than restated; it
 *     already reads both spellings of the header and already refuses to
 *     believe a delay longer than this is willing to wait.
 *   - **A `304` is an answer.** It is the cheap "nothing has changed" the
 *     hourly sweep is built on, and returning it as a response rather than
 *     raising is what lets a caller treat it as the no-op it is.
 *   - **A `3xx` is an answer too, but only when asked for.** One caller wants
 *     one: `/items/<key>/file` answers `302` to a presigned storage URL, and
 *     the hop after it has to be re-issued by hand with no credential on it,
 *     which means somebody has to be handed the `Location` rather than a
 *     refusal. Behind an option rather than on by default, so that every other
 *     request in the module still reads a redirect as a refusal — a `302` from
 *     `/keys/current` is not somewhere a key should be following anybody, and
 *     fail-closed is the only sane default for a request carrying one.
 *
 * The two ceilings that wait are different mechanisms, and they are meant to
 * disagree. This one is the **in-request** wait: one `429`, `retry-after`
 * honoured through `retryAfterMs`, capped at that function's `MAX_BACKOFF_MS`
 * of 8s (module-private to `convex/auth.ts`), and a longer directed delay is
 * declined outright — the cursor is a better answer than an action holding a
 * socket open. The other is the **between-page** wait: Zotero's `Backoff`
 * header, which arrives on successful responses too and asks for room before
 * the *next* page rather than a re-ask of this one. `readSyncHeaders` in
 * `lib/zotero/api.ts` reads that one and caps it at 30s, which is affordable
 * precisely because nothing is in flight while it is honoured. A single shared
 * ceiling would have to be the smaller of the two, and would then throw away
 * the room Zotero explicitly asked for.
 */
export async function zoteroFetch(
  url: string,
  apiKey: string,
  options: {
    ifModifiedSinceVersion?: number;
    /** Hand a `3xx` back instead of raising, for the download's second hop. */
    redirectIsAnAnswer?: boolean;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Zotero-API-Key": apiKey,
    "Zotero-API-Version": ZOTERO_API_VERSION,
  };
  if (options.ifModifiedSinceVersion !== undefined) {
    headers["If-Modified-Since-Version"] = String(
      options.ifModifiedSinceVersion,
    );
  }

  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    const lastAttempt = attempt === READ_ATTEMPTS - 1;

    let response: Response;
    try {
      response = await fetch(url, { headers, redirect: "manual" });
    } catch (caught) {
      throw new ZoteroRefusal(`unreachable (${String(caught)})`, null);
    }

    if (response.ok || response.status === 304) {
      return response;
    }

    if (
      options.redirectIsAnAnswer === true &&
      response.status >= 300 &&
      response.status < 400
    ) {
      return response;
    }

    if (response.status === 429 && !lastAttempt) {
      const wait = retryAfterMs(response, attempt);
      // `null` is Zotero asking for longer than this run will wait. Falling
      // through to the failure below is the point: the cursor holds.
      if (wait !== null) {
        await pause(wait);
        continue;
      }
    }

    // Zotero's own body — `Invalid key`, `Forbidden` — is genuinely the most
    // useful thing in the log and carries no secret. The key does, so it is
    // never logged and never put in an error.
    //
    // Which is a claim about a body Margin does not write, so it is enforced
    // rather than asserted. `GET /keys/current` echoes the credential in its
    // *successful* body, and an error page is free to reflect any of the
    // request back at us; either one reaching this line puts the key inside a
    // refusal, and every caller of this transport logs `String(caught)`. One
    // replacement here covers all of them.
    const body = await response.text().catch(() => "");
    const detail = apiKey.length === 0 ? body : body.replaceAll(apiKey, "[key]");
    throw new ZoteroRefusal(
      `${response.status} ${detail}`.trim().slice(0, 200),
      response.status,
    );
  }
  // Unreachable: the loop either returns or throws on its last attempt.
  throw new ZoteroRefusal("no attempts were made", null);
}

/**
 * A response's JSON, or `null` if it was not any.
 *
 * Zotero answers a proxy error or a maintenance page with HTML often enough
 * that a bare `.json()` is a crash rather than a refusal, and the parsers in
 * `lib/zotero/api.ts` are all written to take `unknown` for exactly this.
 */
async function bodyOf(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------
 * The link
 * ---------------------------------------------------------------------- */

/** This member's link to this lab, or `null`. The only read of the row. */
async function linkFor(
  ctx: QueryCtx | MutationCtx,
  labId: Id<"labs">,
  userId: Id<"users">,
): Promise<Doc<"zoteroLinks"> | null> {
  return await ctx.db
    .query("zoteroLinks")
    .withIndex("by_user_and_lab", (q) =>
      q.eq("userId", userId).eq("labId", labId),
    )
    .unique();
}

/**
 * The library a link points at, in the shape `lib/zotero/api.ts` addresses.
 *
 * Structural rather than `Doc<"zoteroLinks">` because the two callers hold
 * different things — a picker holds `syncPayload`'s answer, a run holds its
 * own copy of the scope — and neither is a document. What they share is the
 * pair of fields, which is exactly what this asks for.
 */
export function libraryOf(link: {
  libraryType: "user" | "group";
  libraryId: string;
}): ZoteroLibrary {
  return { type: link.libraryType, id: link.libraryId };
}

/**
 * The caller's link, credential and all, for an action that needs to fetch.
 *
 * Two round trips rather than one because an action has no database: the id
 * comes from a membership-checked query, and the payload from the one internal
 * query allowed to carry a key. Refuses with a sentence rather than a null so
 * that a picker opened against an unlinked lab says something.
 */
async function callerLink(
  ctx: { runQuery: (ref: never, args: never) => Promise<unknown> },
  labId: Id<"labs">,
) {
  // The references are cast rather than typed: both name functions in this
  // module, and letting `runQuery` infer their shapes would make the module's
  // own types depend on themselves. `slack.ts` avoids the cycle by never
  // calling into itself; a picker has to.
  const linkId = (await ctx.runQuery(internal.zotero.callerLinkId as never, {
    labId,
  } as never)) as Id<"zoteroLinks"> | null;
  if (linkId === null) {
    throw new ConvexError(
      "There's no Zotero library linked here yet. Paste a key first.",
    );
  }
  const payload = (await ctx.runQuery(internal.zotero.syncPayload as never, {
    linkId,
  } as never)) as {
    apiKey: string;
    libraryType: "user" | "group";
    libraryId: string;
  } | null;
  if (payload === null) {
    throw new ConvexError("That Zotero link has gone. Link it again.");
  }
  return payload;
}

/** The caller's link id, membership-checked. Carries nothing secret. */
export const callerLinkId = internalQuery({
  args: { labId: v.id("labs") },
  returns: v.union(v.null(), v.id("zoteroLinks")),
  handler: async (ctx, args) => {
    const membership = await requireMembership(ctx, args.labId);
    const link = await linkFor(ctx, args.labId, membership.userId);
    return link?._id ?? null;
  },
});

/**
 * Everything a sync run needs, credential included.
 *
 * The one function in this module that carries the key anywhere, and an
 * `internalQuery` for that reason — the analogue of `slack.briefPayload`.
 * `convex/credentials.guard.test.ts` names it explicitly in the inverse
 * assertion, so a second function that carried the key would fail the suite
 * with its own name in the message.
 */
export const syncPayload = internalQuery({
  args: { linkId: v.id("zoteroLinks") },
  returns: v.union(
    v.null(),
    v.object({
      apiKey: v.string(),
      connectedAt: v.number(),
      labId: v.id("labs"),
      userId: v.id("users"),
      libraryType: v.union(v.literal("user"), v.literal("group")),
      libraryId: v.string(),
      collectionKey: v.optional(v.string()),
      lastVersion: v.optional(v.number()),
      syncCursor: v.optional(
        v.object({
          targetVersion: v.number(),
          start: v.number(),
          total: v.number(),
          imported: v.number(),
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.linkId);
    if (link === null) return null;
    return {
      apiKey: link.apiKey,
      connectedAt: link.connectedAt,
      labId: link.labId,
      userId: link.userId,
      libraryType: link.libraryType,
      libraryId: link.libraryId,
      collectionKey: link.collectionKey,
      lastVersion: link.lastVersion,
      syncCursor: link.syncCursor,
    };
  },
});

/**
 * Write the link the action just verified.
 *
 * Separate from `connect` because `connect` is an action and an action cannot
 * write. Replacing an existing link keeps one row — one member, one lab, one
 * library — and throws away everything the old key knew: `lastVersion` and
 * `syncCursor` describe a walk made with a credential that may not even be
 * pointed at the same library, and `lastSync` would have the settings row
 * reporting a dead key against a live one.
 */
export const saveLink = internalMutation({
  args: {
    labId: v.id("labs"),
    userId: v.id("users"),
    apiKey: v.string(),
    libraryId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await linkFor(ctx, args.labId, args.userId);
    const fields = {
      apiKey: args.apiKey,
      connectedAt: Date.now(),
      libraryType: "user" as const,
      libraryId: args.libraryId,
      libraryName: undefined,
      collectionKey: undefined,
      collectionName: undefined,
      scopeAcceptedAt: undefined,
      lastVersion: undefined,
      syncCursor: undefined,
      // Stamped, not cleared, and this is the one field here that is not
      // simply forgetting the old key. `connect` points a fresh link at the
      // member's *whole personal library* — it is the only scope nameable
      // without a second round trip — and the sweep takes anything that has
      // never been looked at first. Left absent, the next hourly tick can walk
      // twenty-five papers out of a decade of half-read PDFs onto the lab's
      // shelf before the member has finished choosing a collection, and
      // unlinking does not take them back off. So the clock starts now: an
      // hour is longer than choosing a scope takes, and Sync now is untouched
      // for the member who genuinely wants their whole library.
      lastSyncAt: Date.now(),
      lastSync: undefined,
    };

    if (existing === null) {
      await ctx.db.insert("zoteroLinks", {
        userId: args.userId,
        labId: args.labId,
        ...fields,
      });
    } else {
      await ctx.db.patch(existing._id, fields);
    }

    await recordEvent(ctx, {
      labId: args.labId,
      actorId: args.userId,
      type: "zotero.link_changed",
      connected: true,
    });
    return null;
  },
});

/**
 * Link this member's Zotero account to this lab.
 *
 * Three refusals before anything is stored, all written for the person holding
 * a string they thought was right:
 *
 *   - The paste is not a key at all — most often the settings *URL*, because
 *     that is what the address bar holds when you are looking at the page the
 *     key is on. Refused without spending a request.
 *   - The key works but can write. Refused with the sentence that tells them
 *     which checkbox to clear, because a read-only key is the whole reason the
 *     worst case here is disclosure rather than destruction.
 *   - The key works and may read nothing. That one is not a typo and not a
 *     revocation, so neither of the other two sentences is true about it: the
 *     key exists, Zotero recognises it, and its access block is empty. Said
 *     plainly here rather than discovered as a `403` on the first sweep, where
 *     the only sentence available would be the false one.
 *
 * The library defaults to the member's own, which is what the key was made for
 * and the only one nameable without a second round trip. `chooseScope` moves
 * it, and the settings row offers a group and a collection once the key is in.
 */
export const connect = action({
  args: { labId: v.id("labs"), apiKey: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const apiKey = normalizeApiKey(args.apiKey);
    if (apiKey === null) {
      throw new ConvexError(
        "That doesn't look like a Zotero API key. It's the 24-character code on the key's own page — not the address of the page, and not the word before it.",
      );
    }

    // Membership before the network: an action that asks Zotero on behalf of
    // somebody who is not in this lab has already done the thing.
    const userId: Id<"users"> = await ctx.runQuery(internal.zotero.callerIn, {
      labId: args.labId,
    });

    let response: Response;
    try {
      response = await zoteroFetch(keysCurrentUrl(), apiKey);
    } catch (caught) {
      const status = caught instanceof ZoteroRefusal ? caught.status : null;
      console.error(`Could not verify a Zotero key: ${String(caught)}`);
      throw new ConvexError(
        status === 403 || status === 404
          ? "Zotero doesn't recognise that key. It may have been deleted — make a new one and paste that."
          : "Zotero didn't answer just now. Try again in a minute; nothing has been saved.",
      );
    }

    const permissions = parseKeyPermissions(await bodyOf(response));
    if (permissions === null) {
      throw new ConvexError(
        "Zotero answered something Margin couldn't read. Try again in a minute; nothing has been saved.",
      );
    }
    if (!permissions.readOnly) {
      throw new ConvexError(
        "That key can change your library, and Margin only ever reads. On the key's page in Zotero, clear the write permissions — or make a new read-only key — and paste that one.",
      );
    }
    if (!permissions.canRead) {
      throw new ConvexError(
        "That key works, but its permissions are empty — it can't read any library yet. On the key's page in Zotero, allow read access to your own library or a group, then paste it again.",
      );
    }

    await ctx.runMutation(internal.zotero.saveLink, {
      labId: args.labId,
      userId,
      apiKey,
      libraryId: permissions.userId,
    });
    return null;
  },
});

/** The membership gate an action has no database to run itself. */
export const callerIn = internalQuery({
  args: { labId: v.id("labs") },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    const membership = await requireMembership(ctx, args.labId);
    return membership.userId;
  },
});

/* -------------------------------------------------------------------------
 * Choosing what to sync
 * ---------------------------------------------------------------------- */

/**
 * The libraries this key can reach: the member's own, plus their groups.
 *
 * An action because it is a network call, public because a picker needs it,
 * and it returns names and ids — never the key that fetched them.
 *
 * **`/keys/current` is asked again rather than `link.libraryId` being reused.**
 * The two are the same string only until the member picks a group: after that,
 * `libraryId` is the group's id, and a picker built on it asks Zotero for
 * `/users/<groupId>/groups` — which the key cannot read, so the picker 403s and
 * the member can never leave the library they chose. The same mistake would put
 * the group's id on the "My library" entry, and choosing it would write a
 * personal library that does not exist: every sync from then on answers `403`,
 * and `permanentStatus` reports a revoked key to somebody whose key is fine.
 * `libraryId` is the *scope*. The member's Zotero userID is a property of the
 * credential, so it is read from the credential.
 */
export const listLibraries = action({
  args: { labId: v.id("labs") },
  returns: v.object({
    libraries: v.array(
      v.object({
        type: v.union(v.literal("user"), v.literal("group")),
        id: v.string(),
        name: v.string(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const link = await callerLink(ctx, args.labId);
    try {
      const identity = parseKeyPermissions(
        await bodyOf(await zoteroFetch(keysCurrentUrl(), link.apiKey)),
      );
      if (identity === null) {
        throw new ConvexError(
          "Zotero answered something Margin couldn't read. Try again in a minute.",
        );
      }
      const response = await zoteroFetch(
        groupsUrl(identity.userId),
        link.apiKey,
      );
      const groups = parseGroups(await bodyOf(response));
      return {
        libraries: [
          { type: "user" as const, id: identity.userId, name: "My library" },
          ...groups.map((group) => ({
            type: "group" as const,
            id: group.id,
            name: group.name,
          })),
        ],
      };
    } catch (caught) {
      throw pickerRefusal(caught);
    }
  },
});

/**
 * What a picker says when Zotero declines, rather than what it would say.
 *
 * A `ZoteroRefusal` is an ordinary `Error`, and Convex redacts one of those on
 * its way to a client — so a picker that let it through rendered the client's
 * own fallback, "Could not reach Zotero", next to a settings row already
 * saying, correctly, that the key was refused. Two sentences about one event
 * and the wrong one is the specific one. `connect` has caught this since it
 * was written; the pickers are the same door and had not.
 *
 * `permanentStatus` is what makes the honest version possible: 403 and 404 are
 * the member's to fix and earn the sentence that asks for a new key, and
 * everything else is a bad minute at api.zotero.org and gets told as one.
 */
function pickerRefusal(caught: unknown): unknown {
  if (!(caught instanceof ZoteroRefusal)) return caught;
  console.error(`A Zotero picker was refused: ${String(caught)}`);
  const status = permanentStatus(caught);
  return new ConvexError(
    status === 403 || status === 404
      ? "Zotero turned that key down — it may have been deleted, or it may not reach that library any more. Paste a new key."
      : "Zotero didn't answer just now. Try again in a minute; nothing has been changed.",
  );
}

/** The collections in whichever library is currently chosen. */
export const listCollections = action({
  args: { labId: v.id("labs") },
  returns: v.object({
    collections: v.array(v.object({ key: v.string(), name: v.string() })),
  }),
  handler: async (ctx, args) => {
    const link = await callerLink(ctx, args.labId);
    try {
      const response = await zoteroFetch(
        collectionsUrl(libraryOf(link)),
        link.apiKey,
      );
      return { collections: parseCollections(await bodyOf(response)) };
    } catch (caught) {
      throw pickerRefusal(caught);
    }
  },
});

/**
 * What Zotero issues as a collection key: eight uppercase alphanumerics.
 *
 * Wider than that on purpose, and for the reason `normalizeApiKey` gives —
 * this is not the authority on Zotero's key format, and a length that shifts
 * by a character should not lock a member out of their own collection.
 */
const COLLECTION_KEY = /^[A-Za-z0-9]{4,32}$/;

/**
 * What addresses a Zotero library: a numeric id, for users and groups both.
 * `parseKeyPermissions` and `parseGroups` only ever produce digits, so
 * anything else — the empty string that builds `/users//collections`, a name
 * where an id belongs — never came from the picker.
 */
const LIBRARY_ID = /^[0-9]{1,16}$/;

/**
 * Point the link at a library, and optionally at one collection in it.
 *
 * **The version counter is thrown away on every change.** A
 * `Last-Modified-Version` is a fact about one library: carried to a different
 * one it means nothing, and `?since=` would silently skip everything with a
 * lower version — a sync that imports two papers out of four hundred and
 * reports success. Narrowing to a collection has the same shape for the same
 * reason: items that were never in the walk are now in it, and their versions
 * are older than the mark. So both reset `lastVersion` and `syncCursor`, and
 * the next run walks the new scope from the beginning.
 *
 * `collectionKey` is one the picker read back out of `listCollections`, which
 * is to say out of `parseCollections` — nothing in the product ever types one.
 * The reason that matters is `encodeSegment` in `lib/zotero/api.ts`: a key is
 * interpolated into a path, and the one shape no encoding survives is a dot
 * segment. A stored key that never came from Zotero is the only way one gets
 * that far, so the shape is checked here as well: this is a public mutation and
 * "the picker only sends real keys" is a fact about the client. It also
 * disposes of the empty string, which is not a dot segment but builds
 * `/collections//items/top` and asks about a library nobody named.
 */
export const chooseScope = mutation({
  args: {
    labId: v.id("labs"),
    libraryType: v.union(v.literal("user"), v.literal("group")),
    libraryId: v.string(),
    libraryName: v.optional(v.string()),
    collectionKey: v.optional(v.string()),
    collectionName: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const membership = await requireMembership(ctx, args.labId);
    const link = await linkFor(ctx, args.labId, membership.userId);
    if (link === null) {
      throw new ConvexError(
        "There's no Zotero library linked here yet. Paste a key first.",
      );
    }
    if (!LIBRARY_ID.test(args.libraryId)) {
      throw new ConvexError(
        "That isn't a Zotero library. Pick one from the list.",
      );
    }
    if (
      args.collectionKey !== undefined &&
      !COLLECTION_KEY.test(args.collectionKey)
    ) {
      throw new ConvexError(
        "That isn't a Zotero collection. Pick one from the list.",
      );
    }
    await ctx.db.patch(link._id, {
      libraryType: args.libraryType,
      libraryId: args.libraryId,
      libraryName: args.libraryName,
      collectionKey: args.collectionKey,
      collectionName: args.collectionName,
      // Picking a scope is accepting one. `acceptScope` exists for the member
      // who accepts the default without touching anything; this is the same
      // fact arriving the other way, and recording it here means a member who
      // narrowed their scope and then closed the tab is not asked again.
      scopeAcceptedAt: Date.now(),
      lastVersion: undefined,
      syncCursor: undefined,
      lastSync: undefined,
    });
    return null;
  },
});

/**
 * "This scope is the one I want" — the answer Done gives.
 *
 * Without a durable record of it there is nowhere to put the answer, and the
 * picker's own visibility test would be "has this member named a library",
 * which is false for everybody who is happy with the default: they press Done,
 * and the panel opens itself again on the next visit, and on the one after
 * that, spending two requests to `api.zotero.org` each time to re-offer a
 * question they have already answered. The panel's own doc argues against
 * exactly that ("a settings page nobody came here to change should not spend
 * a request"), so the answer is stored rather than inferred.
 *
 * A timestamp rather than a boolean, for the reason `connectedAt` is one: when
 * somebody accepted a scope is a fact worth having if a later question is ever
 * asked about which scope they accepted. Nothing reads it as a time yet.
 */
export const acceptScope = mutation({
  args: { labId: v.id("labs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const membership = await requireMembership(ctx, args.labId);
    const link = await linkFor(ctx, args.labId, membership.userId);
    // Nothing to accept, and nothing to say about it: the settings row already
    // renders the unlinked state, and a member who unlinked in another tab
    // does not need this to raise.
    if (link === null) return null;
    await ctx.db.patch(link._id, { scopeAcceptedAt: Date.now() });
    return null;
  },
});

/**
 * Unlink. The row goes; the papers stay.
 *
 * They are the lab's — annotated, in collections, cited in write-ups — and a
 * member unlinking their own account must not silently strip a shelf everyone
 * else has been working on. The confirm copy in the settings row says so in
 * as many words.
 *
 * Idempotent, and writes no ledger fact when there was nothing to unlink,
 * because nothing about the lab changed.
 */
export const disconnect = mutation({
  args: { labId: v.id("labs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const membership = await requireMembership(ctx, args.labId);
    const link = await linkFor(ctx, args.labId, membership.userId);
    if (link === null) {
      return null;
    }
    await ctx.db.delete(link._id);
    await recordEvent(ctx, {
      labId: args.labId,
      actorId: membership.userId,
      type: "zotero.link_changed",
      connected: false,
    });
    return null;
  },
});

/**
 * Whether *you* have a library wired here, and how the last run went.
 *
 * Answers about the caller's own link and nothing else — not whose else is
 * wired, not how many are. That is the difference between this and
 * `slack.status`, which tells every member the lab posts to a channel because
 * their writing leaves the building when it does. Nothing leaves the building
 * here: a Zotero link brings papers *in*, and which papers one member keeps in
 * their own reference manager is the reading history
 * `convex/privacy.guard.test.ts` exists to keep Margin out of.
 *
 * What nobody gets is the key. It is not in this validator, it is not in any
 * other public function in the codebase, and `convex/credentials.guard.test.ts`
 * asserts that by walking every returns validator rather than by trusting this
 * sentence.
 *
 * Answers `connected: false` rather than throwing for a non-member, the same
 * posture `slack.status` takes: a surface that renders nothing is the correct
 * reading of "you are not in this lab".
 */
export const status = query({
  args: { labId: v.id("labs") },
  returns: v.object({
    connected: v.boolean(),
    libraryName: v.union(v.null(), v.string()),
    collectionName: v.union(v.null(), v.string()),
    /** Whether this member has said which part of their library they meant. */
    scopeAccepted: v.boolean(),
    lastSyncAt: v.union(v.null(), v.number()),
    /** The last refusal, if the key is currently being refused. */
    lastSyncFailed: v.union(
      v.null(),
      v.object({ at: v.number(), statusCode: v.number() }),
    ),
    /** How far a multi-run walk has got, or `null` when none is in flight. */
    progress: v.union(
      v.null(),
      v.object({
        checked: v.number(),
        total: v.number(),
        imported: v.number(),
      }),
    ),
    /** Papers the last completed run put on the shelf. */
    lastImported: v.union(v.null(), v.number()),
  }),
  handler: async (ctx, args) => {
    const nothing = {
      connected: false,
      libraryName: null,
      collectionName: null,
      scopeAccepted: false,
      lastSyncAt: null,
      lastSyncFailed: null,
      progress: null,
      lastImported: null,
    };
    const userId = await requireUserId(ctx);
    const membership = await getMembership(ctx, args.labId, userId);
    if (membership === null) return nothing;
    const link = await linkFor(ctx, args.labId, userId);
    if (link === null) return nothing;

    const last = link.lastSync;
    // Shown only when the record is a refusal *and* it describes the key the
    // member has now. The mutation that writes it already refuses to record an
    // outcome against a replaced credential; this is the same rule applied
    // again at the read, so a row that somehow got there anyway still cannot
    // tell somebody their live key is dead.
    const stale = last === undefined || last.connectedAt !== link.connectedAt;

    return {
      connected: true,
      libraryName: link.libraryName ?? null,
      collectionName: link.collectionName ?? null,
      scopeAccepted: link.scopeAcceptedAt !== undefined,
      // Off `lastSync`, not off `lastSyncAt`, because those two stopped being
      // the same question when `saveLink` started stamping the clock at connect
      // time to keep a brand-new link out of the very next sweep. `lastSyncAt`
      // is now "when the sweep should next consider this row"; `lastSync` is
      // written only by a run that actually looked. Read the other way, a
      // member who has just pasted a key is told Margin checked their library
      // moments ago, having never asked Zotero anything.
      lastSyncAt: link.lastSync === undefined ? null : (link.lastSyncAt ?? null),
      lastSyncFailed:
        stale || last.statusCode === undefined
          ? null
          : { at: last.at, statusCode: last.statusCode },
      progress:
        link.syncCursor === undefined
          ? null
          : {
              checked: link.syncCursor.start,
              total: link.syncCursor.total,
              imported: link.syncCursor.imported,
            },
      lastImported: stale ? null : last.imported,
    };
  },
});

/* -------------------------------------------------------------------------
 * The sync
 * ---------------------------------------------------------------------- */

/**
 * How many Zotero items one run may walk.
 *
 * The cap that makes this feature honest, and it is set by the *expensive*
 * part rather than by the page. Twenty-five items is up to twenty-five
 * `/children` requests and up to twenty-five PDF downloads, each of them
 * allowed to be 60 MB, against an API that asks for no more than four
 * concurrent requests. Zotero's own page maximum is a hundred, which would be
 * a hundred downloads inside one action — the shape that gets killed halfway
 * through with a cursor that never advanced and nothing to show for it.
 *
 * It is a *rate*, not a ceiling. `syncCursor` persists where the walk got to,
 * and the hourly sweep continues it, so a four-thousand-item collection fills
 * over an afternoon instead of failing at once. A member who wants it faster
 * presses Sync now again, which is exactly what the button says it does.
 */
export const SYNC_PAGE_ITEMS = 25;

/**
 * How much of the lab's shelf the title-identity fallback compares against.
 *
 * The same two hundred `listPapers` reads, and deliberately the same two
 * hundred: both reads below are `.order("desc")` for that reason, because
 * `by_lab` ascending would compare against the *oldest* two hundred papers —
 * the exact set the member cannot see on the shelf — while the duplicates this
 * fallback exists to catch are the recent ones, last week's `.bib` paste
 * against this morning's sync. Matching the order is what makes the sentence
 * below true rather than merely reassuring.
 *
 * Read **once per run** into a map rather than once per candidate —
 * `createFromMetadata` does the latter (`convex/papers.ts:369-376`) and at 25
 * candidates against a full shelf that is five thousand document reads for one
 * page of items.
 *
 * The honest limitation, written down rather than hidden: past two hundred
 * papers this fallback starts missing duplicates that have no DOI and no
 * Zotero key in common. So does the library page itself, which cannot list
 * them (`convex/papers.ts:570-578`), and the two ceilings should be lifted
 * together — `convex/schema.ts:1150-1165` names the 201st paper as the signal
 * for exactly that.
 */
const IDENTITY_SCAN_LIMIT = 200;

/** How many links one hourly sweep will set going. */
const MAX_SWEEP_LINKS = 20;

/** A link is due for another look an hour after the last one finished. */
const SYNC_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The DOI on a Zotero item, in the one form `by_lab_and_doi` is a key for.
 *
 * Zotero holds whatever the publisher's metadata said, and that is routinely
 * `https://doi.org/10.1038/Nature12373` rather than `10.1038/nature12373`.
 * `papers.doi` is stored normalized precisely so that one DOI is one paper per
 * lab however it arrived, and a raw write splits that key where nobody can see
 * it: the second copy is filed under a string the first copy's lookup will
 * never produce, so both the dedupe *and* the duplicate are invisible.
 * `isPlausibleDoi` then drops what is not a DOI at all, which is what a `DOI:`
 * line in a free-text `extra` field turns out to be about as often as not.
 */
function syncDoi(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const doi = normalizeDoi(raw);
  return isPlausibleDoi(doi) ? doi : undefined;
}

/**
 * One page of Zotero rows, as candidates Margin can file.
 *
 * The only place a candidate is made, which is what lets everything
 * downstream — the preflight query, the committing mutation — take the DOI as
 * already normalized rather than each remembering to.
 */
function candidatesIn(items: unknown[]): ZoteroReference[] {
  return items.flatMap((raw) => {
    const entry = toReference(raw as ZoteroItem);
    return entry === null ? [] : [{ ...entry, doi: syncDoi(entry.doi) }];
  });
}

/**
 * One item, mapped and ready to be filed. `doi` arrives through `syncDoi`.
 */
const zoteroCandidate = v.object({
  zoteroItemKey: v.string(),
  title: v.string(),
  authors: v.array(v.string()),
  year: v.optional(v.number()),
  venue: v.optional(v.string()),
  abstract: v.optional(v.string()),
  doi: v.optional(v.string()),
  url: v.optional(v.string()),
});

/**
 * Which of these candidates the lab does not already have.
 *
 * Run before any file is downloaded, which is the whole reason it is a
 * separate query: a re-walk over a collection Margin has already imported is
 * the common case, and spending twenty-five PDF downloads to discover that is
 * the difference between a cheap hourly poll and an expensive one. The same
 * `findByDoi` → fetch → `insertFromDoi` shape `convex/papers.ts` already uses,
 * for the same reason.
 *
 * Three passes, cheapest first, and none of them a scan:
 *
 *   1. `by_lab_and_zotero_item` — this exact item, already here.
 *   2. `by_lab_and_doi` — this paper, from somewhere else.
 *   3. `referenceIdentity` against one bounded read of the shelf — the same
 *      key `createFromMetadata` uses, so a `.bib` paste and a Zotero sync
 *      collapse onto one row.
 *
 * A miss here costs a download and nothing else: `commitPage` asks all three
 * questions again with the answers that matter, because it is the one holding
 * the transaction.
 */
export const newAmong = internalQuery({
  args: { labId: v.id("labs"), candidates: v.array(zoteroCandidate) },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const shelf = await ctx.db
      .query("papers")
      .withIndex("by_lab", (q) => q.eq("labId", args.labId))
      .order("desc")
      .take(IDENTITY_SCAN_LIMIT);
    const identities = new Set(
      shelf.map((paper) => referenceIdentity(paper.title, paper.year)),
    );

    const fresh: string[] = [];
    for (const candidate of args.candidates) {
      const byKey = await ctx.db
        .query("papers")
        .withIndex("by_lab_and_zotero_item", (q) =>
          q.eq("labId", args.labId).eq("zoteroItemKey", candidate.zoteroItemKey),
        )
        .first();
      if (byKey !== null) continue;

      const doi = candidate.doi;
      if (doi !== undefined) {
        const byDoi = await ctx.db
          .query("papers")
          .withIndex("by_lab_and_doi", (q) =>
            q.eq("labId", args.labId).eq("doi", doi),
          )
          .first();
        if (byDoi !== null) continue;
      }

      if (identities.has(referenceIdentity(candidate.title, candidate.year))) {
        continue;
      }
      fresh.push(candidate.zoteroItemKey);
    }
    return fresh;
  },
});

/**
 * File one page of items, and move the cursor.
 *
 * One transaction for the whole page rather than one per item: the dedupe map
 * is read once, the cursor moves once, and a page either lands or does not.
 *
 * ## Nothing here can assume it is on time
 *
 * `connectedAt` travels with the run for the reason `slack.recordDeliveryOutcome`
 * documents at length (`convex/slack.ts:392-433`): these writes are scheduled
 * from an action and race the member in the settings page. A run that read a
 * library with a key the member has since revoked must not write papers under
 * it, must not advance a cursor belonging to a walk that no longer exists, and
 * must not leave the blobs it fetched sitting in storage with nothing pointing
 * at them.
 *
 * The dedupe is re-checked here even though `newAmong` just ran, for the
 * reason `insertFromDoi` re-checks (`convex/papers.ts:850-868`): two members
 * can be syncing overlapping libraries at once, and the gap between the query
 * and this mutation is a real interval.
 *
 * ## Four ways a page can arrive too late, and one answer to all of them
 *
 * The run that assembled this page held a key, a scope and an offset, and any
 * of the three can have moved while it was fetching — the member in the
 * settings page, the hourly sweep, a second tab. Each mismatch is checked
 * below and each one discards the whole page, storage included, because a page
 * is only meaningful against the state it was read from:
 *
 *   - the link is **gone** (unlinked mid-run),
 *   - the **key** was replaced (`connectedAt`),
 *   - the **scope** was re-pointed (`chooseScope`, which leaves `connectedAt`
 *     alone — so a run against the old library would otherwise file its papers
 *     here *and* install its own `targetVersion` as the new scope's cursor),
 *   - the **walk** moved on, which is what `fetchedFrom` is for.
 */
export const commitPage = internalMutation({
  args: {
    linkId: v.id("zoteroLinks"),
    connectedAt: v.number(),
    /** The scope the run read, so a re-pointed link refuses the old library's page. */
    libraryType: v.union(v.literal("user"), v.literal("group")),
    libraryId: v.string(),
    collectionKey: v.optional(v.string()),
    /**
     * The walk's whole state as this run read it. The commit applies to that
     * state and to no other.
     *
     * A token rather than arithmetic, and the difference is a bug that was
     * here: comparing `link.syncCursor?.start ?? 0` against a fetched offset
     * reads "no walk in progress" and "walk sitting at offset zero" as the same
     * answer, and they are opposites. A run that read page one of a fresh walk
     * is holding a page from *before* any walk existed; if another run finishes
     * the entire library while it downloads, the first run's commit is accepted
     * against the cleared cursor and installs `{ start: 25 }` on top of a
     * completed walk. The next run then asks `?since=<the finished version>
     * &start=25` — twenty-five items into a *changed-items* set that is almost
     * always shorter than that — and everything in it is stepped over, with
     * `lastVersion` closing the gap behind it.
     *
     * Both halves are compared exactly, `undefined` included: absent `start`
     * means "there was no walk", absent `lastVersion` means "this library had
     * never been walked", and either one turning into a number is a fact that
     * happened after this page was read.
     */
    fetchedFrom: v.object({
      start: v.optional(v.number()),
      lastVersion: v.optional(v.number()),
    }),
    entries: v.array(
      v.object({
        ...zoteroCandidate.fields,
        storageId: v.optional(v.id("_storage")),
      }),
    ),
    /** How many items the page held, imported or not — what `start` advances by. */
    walked: v.number(),
    targetVersion: v.number(),
    /** `Total-Results`, for the progress line. Never what closes a walk. */
    total: v.number(),
    /** True when Zotero gave back a short page: there is no more to walk. */
    exhausted: v.boolean(),
  },
  returns: v.object({ imported: v.number(), skipped: v.number(), done: v.boolean() }),
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.linkId);
    const nothing = { imported: 0, skipped: 0, done: true };

    /** Throw the page away, and the files it fetched with it. */
    const discard = async () => {
      // A blob with nothing pointing at it is a file nobody will ever find
      // again and nothing will ever collect.
      for (const entry of args.entries) {
        if (entry.storageId !== undefined) {
          await ctx.storage.delete(entry.storageId);
        }
      }
      return nothing;
    };

    if (link === null) return await discard();
    if (link.connectedAt !== args.connectedAt) return await discard();
    if (
      link.libraryType !== args.libraryType ||
      link.libraryId !== args.libraryId ||
      link.collectionKey !== args.collectionKey
    ) {
      return await discard();
    }
    if (
      link.syncCursor?.start !== args.fetchedFrom.start ||
      link.lastVersion !== args.fetchedFrom.lastVersion
    ) {
      return await discard();
    }

    const shelf = await ctx.db
      .query("papers")
      .withIndex("by_lab", (q) => q.eq("labId", link.labId))
      .order("desc")
      .take(IDENTITY_SCAN_LIMIT);
    const byIdentity = new Map(
      shelf.map((paper) => [referenceIdentity(paper.title, paper.year), paper]),
    );
    /**
     * Identities filed by this page, which the shelf map does not know about.
     *
     * A Zotero collection can hold the same paper twice — a duplicate the
     * member never noticed — and both copies can land on one page. A set
     * rather than adding rows to `byIdentity` because the only question asked
     * of it is membership, and a map of half-real documents is a shape
     * somebody will later read a field off.
     */
    const filedThisPage = new Set<string>();

    let imported = 0;
    let skipped = 0;

    for (const entry of args.entries) {
      const title = cleanTitle(entry.title);
      const authors = cleanAuthors(entry.authors);
      // Through `syncDoi` again on the writing side, where the dedupe key is
      // actually minted: `zoteroCandidate` says its DOIs are normalized, and
      // this is the one function that would be storing a raw one if that ever
      // stopped being true.
      const doi = syncDoi(entry.doi);

      const byKey = await ctx.db
        .query("papers")
        .withIndex("by_lab_and_zotero_item", (q) =>
          q.eq("labId", link.labId).eq("zoteroItemKey", entry.zoteroItemKey),
        )
        .first();
      if (byKey !== null) {
        // The member fixed something upstream. Patch the metadata rather than
        // adding a near-duplicate; leave the file alone, because a PDF on the
        // shelf has a text layer and annotations anchored to it and swapping
        // that out is `attachPdf`'s job, not a background sync's.
        //
        // Every field falls back to what the row already holds, because
        // `db.patch` reads an `undefined` as *delete this field* and a Zotero
        // item is routinely thinner than the paper Margin has: a `.bib` import
        // or a DOI walk fills in a venue and an abstract that the member's own
        // Zotero row never had. Without the fallbacks, claiming a paper for a
        // Zotero item strips it — and `chooseScope` resets `lastVersion`, so
        // every scope change re-walks and re-strips the same rows.
        await ctx.db.patch(byKey._id, {
          title,
          authors: authors ?? byKey.authors,
          year: entry.year ?? byKey.year,
          venue: entry.venue ?? byKey.venue,
          abstract: entry.abstract ?? byKey.abstract,
          doi: await keptDoi(ctx, link.labId, byKey, doi),
        });
        if (entry.storageId !== undefined) await ctx.storage.delete(entry.storageId);
        skipped += 1;
        continue;
      }

      const byDoi =
        doi === undefined
          ? null
          : await ctx.db
              .query("papers")
              .withIndex("by_lab_and_doi", (q) =>
                q.eq("labId", link.labId).eq("doi", doi),
              )
              .first();
      const identity = referenceIdentity(title, entry.year);
      if (byDoi === null && filedThisPage.has(identity)) {
        // The second copy of a paper that was duplicated upstream.
        if (entry.storageId !== undefined) await ctx.storage.delete(entry.storageId);
        skipped += 1;
        continue;
      }
      const byIdentityMatch = byDoi ?? byIdentity.get(identity) ?? null;

      if (byIdentityMatch !== null) {
        // Same paper, arrived another way. Claim it for this Zotero item so a
        // later edit upstream finds this row instead of making a second one.
        if (byIdentityMatch.zoteroItemKey === undefined) {
          await ctx.db.patch(byIdentityMatch._id, {
            zoteroItemKey: entry.zoteroItemKey,
          });
        }
        if (entry.storageId !== undefined) await ctx.storage.delete(entry.storageId);
        skipped += 1;
        continue;
      }

      const paperId = await ctx.db.insert("papers", {
        labId: link.labId,
        title,
        authors,
        year: entry.year,
        venue: entry.venue,
        abstract: entry.abstract,
        doi,
        sourceUrl: entry.url,
        storageId: entry.storageId,
        zoteroItemKey: entry.zoteroItemKey,
        // A fetched PDF has no text layer: nothing has run pdf.js over it yet.
        // `pending` is that gap, and the reader closes it on first open —
        // exactly as it does for a DOI-fetched open-access copy.
        ingestStatus: entry.storageId === undefined ? "needs-pdf" : "pending",
        addedBy: link.userId,
      });
      await recordEvent(ctx, {
        labId: link.labId,
        type: "paper.added",
        actorId: link.userId,
        paperId,
        title,
      });
      filedThisPage.add(identity);
      imported += 1;
    }

    const start = (args.fetchedFrom.start ?? 0) + args.walked;
    const walkedImported = (link.syncCursor?.imported ?? 0) + imported;
    /**
     * A short page, and nothing else, ends a walk.
     *
     * `start >= total` was the other half of this and it is gone, because
     * `total` is `Total-Results` and Zotero does not always send one. Absent,
     * the only honest fallback is the page in hand — and a *full* first page
     * with no header then reads as "25 items, 25 walked, finished", which
     * closes the walk and moves `lastVersion` past everything it never
     * fetched. What the arithmetic bought was one saved request at the end of
     * a walk whose length divides evenly; what it cost was the rest of the
     * library. A short page is Zotero's own answer to "is there more", it
     * needs no header, and the extra empty page at the end is an hourly
     * request nobody notices.
     */
    const done = args.exhausted;
    const at = Date.now();

    await ctx.db.patch(link._id, {
      // `lastVersion` moves only when the walk finishes, and moves to the
      // version the walk *started* at. Anything edited during a multi-run walk
      // has a higher version and is seen by the next one; the cost is
      // re-reading a handful of items, and the alternative is losing an edit
      // made while Margin was three pages in.
      lastVersion: done ? args.targetVersion : link.lastVersion,
      syncCursor: done
        ? undefined
        : {
            targetVersion: args.targetVersion,
            start,
            // Display only, and never below what has actually been walked: a
            // progress line reading "50 of about 25" is a worse answer than a
            // rough one.
            total: Math.max(args.total, start),
            imported: walkedImported,
          },
      lastSyncAt: at,
      lastSync: { at, connectedAt: args.connectedAt, imported, skipped },
    });

    // Only when something arrived. The hourly sweep asks every linked library
    // whether anything changed, and for most members on most hours the answer
    // is no — a row per poll would be an append-only table growing to record
    // that nothing happened.
    if (imported > 0) {
      await recordEvent(ctx, {
        labId: link.labId,
        actorId: link.userId,
        type: "zotero.synced",
        imported,
        skipped,
      });
    }

    return { imported, skipped, done };
  },
});

/**
 * Which DOI a claimed row keeps when the member corrects one upstream.
 *
 * `by_lab_and_doi` is a dedupe key, which is a promise that one DOI is one
 * paper per lab — and a correction is the one edit that can break it from
 * outside: the member fixes a typo in Zotero, the corrected DOI is the one
 * another row on the shelf has held since a `.bib` import, and writing it here
 * would leave two rows under it. From then on the lookups that dedupe against
 * that DOI find whichever row Convex hands back first, which is a fact about
 * an index rather than about the lab.
 *
 * The existing row wins, because it was here first and the sync is the guest.
 * The Zotero item keeps its own row and its own key; what it does not get is
 * somebody else's identifier.
 */
async function keptDoi(
  ctx: MutationCtx,
  labId: Id<"labs">,
  paper: Doc<"papers">,
  doi: string | undefined,
): Promise<string | undefined> {
  if (doi === undefined || doi === paper.doi) return paper.doi;
  const owner = await ctx.db
    .query("papers")
    .withIndex("by_lab_and_doi", (q) => q.eq("labId", labId).eq("doi", doi))
    .first();
  return owner === null || owner._id === paper._id ? doi : paper.doi;
}

/** Record that a run looked and found nothing, or was refused. */
export const markSwept = internalMutation({
  args: {
    linkId: v.id("zoteroLinks"),
    connectedAt: v.number(),
    statusCode: v.union(v.number(), v.null()),
    /**
     * Also send the walk in progress back to its first page.
     *
     * Offset pagination is only stable while the set underneath does not get
     * shorter, and `syncLink` calls this when `Total-Results` says it did: rows
     * have been pulled below the read head, where the walk would step over them
     * and `lastVersion` would then close the gap behind it. Re-reading pages
     * Margin has already seen is cheap, because they dedupe to nothing.
     *
     * The cursor is rewound rather than cleared, so the settings row keeps a
     * progress line to show — "0 of 400" is a walk starting again, where an
     * absent cursor is a walk that never happened. `targetVersion` stays where
     * it was: it is the mark this walk will commit at the end, and lowering it
     * loses nothing while raising it would claim ground the walk never covered.
     */
    restartWalk: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.linkId);
    if (link === null || link.connectedAt !== args.connectedAt) return null;
    const at = Date.now();
    await ctx.db.patch(link._id, {
      lastSyncAt: at,
      syncCursor:
        args.restartWalk === true && link.syncCursor !== undefined
          ? { ...link.syncCursor, start: 0, imported: 0 }
          : link.syncCursor,
      lastSync: {
        at,
        connectedAt: args.connectedAt,
        // Absent, not zero: absent is how "it worked" is spelled, and a status
        // of nothing is not a status.
        statusCode: args.statusCode ?? undefined,
        imported: 0,
        skipped: 0,
      },
    });
    return null;
  },
});

/** A repository that accepts the connection and then stops talking. */
const FILE_FETCH_TIMEOUT_MS = 20_000;

/**
 * The bytes behind one Zotero attachment, or `null`.
 *
 * Two hops, and the whole reason this function exists rather than a `fetch`:
 *
 *   1. `<prefix>/items/<key>/file` **with** the key, `redirect: "manual"`, and
 *      a `302` expected rather than bytes.
 *   2. Wherever `Location` points, **without** the key and without any Zotero
 *      header at all.
 *
 * `fetch` following that redirect by itself strips `Authorization` and strips
 * nothing else, so a custom `Zotero-API-Key` rides along to a presigned Amazon
 * URL — a member's credential handed to a storage host, in a request that
 * works perfectly and therefore never gets looked at.
 *
 * `nextRedirectHop` is imported rather than restated: it already resolves a
 * relative `Location`, already requires https, and already refuses a hop onto
 * a machine rather than a public site — which matters here for the same reason
 * it matters on the pasted-link path, since the destination is chosen by
 * somebody else's `302`.
 *
 * `null` for every failure, and the caller files the paper `needs-pdf`. A
 * paper with no readable copy is still worth having, and the library already
 * says so honestly.
 */
async function downloadAttachment(
  library: ZoteroLibrary,
  attachmentKey: string,
  apiKey: string,
): Promise<Blob | null> {
  try {
    const first = await zoteroFetch(fileUrl(library, attachmentKey), apiKey, {
      redirectIsAnAnswer: true,
    });
    // Zotero can answer bytes directly for a small file; both shapes are fine.
    if (first.status < 300 || first.status >= 400) {
      return await pdfFromResponse(first);
    }
    const target = nextRedirectHop(
      fileUrl(library, attachmentKey),
      first.headers.get("location"),
    );
    if (target === null) return null;

    // No credential on this one. That is the entire point of the two hops.
    const second = await fetch(target, {
      headers: { Accept: "application/pdf" },
      redirect: "manual",
      signal: AbortSignal.timeout(FILE_FETCH_TIMEOUT_MS),
    });
    return await pdfFromResponse(second);
  } catch {
    return null;
  }
}

/**
 * The file for one item, if it has one Zotero is holding.
 *
 * Two requests at worst and often none: `pickPdfAttachment` reads `linkMode`,
 * `contentType` and `md5` off the children listing, so a snapshot, a linked
 * file and a WebDAV-stored PDF are all refused before a download is spent.
 *
 * A `Backoff` on these responses is deliberately not read, where the item page
 * honours one. These requests are serial, bounded at twenty-five of each per
 * run, and followed by a mutation that has to happen — pausing between two of
 * them holds an action open in the middle of a page whose files are already
 * half-fetched. The page's own backoff is honoured after the commit instead,
 * which is where a pause costs nothing and the cursor is already durable.
 */
async function fetchPdfFor(
  ctx: { storage: { store: (blob: Blob) => Promise<Id<"_storage">> } },
  library: ZoteroLibrary,
  itemKey: string,
  apiKey: string,
): Promise<Id<"_storage"> | undefined> {
  try {
    const response = await zoteroFetch(childrenUrl(library, itemKey), apiKey);
    const children = await bodyOf(response);
    const attachment = pickPdfAttachment(
      Array.isArray(children) ? (children as Parameters<typeof pickPdfAttachment>[0]) : [],
    );
    if (attachment === null) return undefined;
    const pdf = await downloadAttachment(library, attachment.key, apiKey);
    return pdf === null ? undefined : await ctx.storage.store(pdf);
  } catch (caught) {
    // A paper with no file is still worth having, and the library says so.
    console.error(`Could not fetch a Zotero attachment: ${String(caught)}`);
    return undefined;
  }
}

/**
 * One bounded run against one link.
 *
 * The whole shape, in order: read the link (and its key) once, ask for one
 * page — conditionally when there is nothing in flight and a version to be
 * since — map the items, ask which are new *before* spending a download, fetch
 * the files for those, and hand the page to one mutation that dedupes again,
 * files, and moves the cursor.
 *
 * Failures are logged and swallowed rather than thrown. A refused run leaves
 * the cursor exactly where it was and the sweep tries again in an hour; an
 * `internalAction` that threw would show up as a failed function every hour
 * for every member with a revoked key, without anything useful happening as a
 * result. The settings row is where a member finds out, off `lastSync`.
 */
export const syncLink = internalAction({
  args: { linkId: v.id("zoteroLinks") },
  returns: v.object({ imported: v.number(), skipped: v.number(), done: v.boolean() }),
  handler: async (ctx, args): Promise<{ imported: number; skipped: number; done: boolean }> => {
    const nothing = { imported: 0, skipped: 0, done: true };
    const payload = await ctx.runQuery(internal.zotero.syncPayload, {
      linkId: args.linkId,
    });
    if (payload === null) return nothing;

    const library = libraryOf(payload);
    const cursor = payload.syncCursor;
    const start = cursor?.start ?? 0;

    let response: Response;
    try {
      response = await zoteroFetch(
        itemsUrl({
          library,
          collectionKey: payload.collectionKey,
          since: payload.lastVersion,
          start,
          limit: SYNC_PAGE_ITEMS,
        }),
        payload.apiKey,
        // Conditional only at the top of a walk. Mid-walk the library has
        // moved by definition — this run is what is moving it — and a `304`
        // there would strand the cursor.
        cursor === undefined && payload.lastVersion !== undefined
          ? { ifModifiedSinceVersion: payload.lastVersion }
          : {},
      );
    } catch (caught) {
      console.error(`A Zotero sync was refused: ${String(caught)}`);
      await ctx.runMutation(internal.zotero.markSwept, {
        linkId: args.linkId,
        connectedAt: payload.connectedAt,
        statusCode: permanentStatus(caught),
      });
      return nothing;
    }

    if (response.status === 304) {
      // The cheap hourly no-op: nothing in this library has changed since the
      // last completed walk, so one small request is the entire cost.
      await ctx.runMutation(internal.zotero.markSwept, {
        linkId: args.linkId,
        connectedAt: payload.connectedAt,
        statusCode: null,
      });
      return nothing;
    }

    const headers = readSyncHeaders(response.headers);

    if (
      cursor !== undefined &&
      headers.totalResults !== null &&
      headers.totalResults < cursor.total
    ) {
      /*
       * The result set this walk is paging through got *shorter*, which is the
       * one change offset pagination cannot survive.
       *
       * This used to ask a much bigger question — whether the library's
       * `Last-Modified-Version` had risen above the walk's mark — and that
       * question starved active libraries dead. One page a run against an
       * hourly sweep means a thousand-item library is a forty-hour walk, and
       * *any* edit in any of those forty hours bumps the version: a member who
       * touches Zotero more than once an hour would never once get past their
       * first twenty-five papers, and every restart looked like a clean no-op
       * from the outside.
       *
       * The narrower question is also the correct one. The walk pages a set
       * ordered by `dateAdded asc` — the `?since=` set, once there is a mark —
       * and only one kind of change to it can lose an item:
       *
       *   - an item *joining* the set (added, or edited so that it now matches
       *     `?since=`) at a position before the current offset pushes its
       *     neighbours to *higher* offsets, so the walk re-reads a row it has
       *     already filed. The dedupe absorbs that; the cost is a wasted read.
       *   - an item *leaving* the set (deleted, or removed from the collection)
       *     pulls its neighbours to *lower* offsets, under the read head. Those
       *     rows are never fetched, and `lastVersion` closes over them at the
       *     end of the walk, so `?since=` excludes them from every walk after.
       *
       * `Total-Results` shrinking is exactly the second case and nothing else,
       * which is why an edit — the common thing, the thing that was starving
       * the walk — no longer restarts anything. The walk always advances.
       *
       * The restart keeps the cursor rather than dropping it: `start` goes back
       * to zero where the settings row can see it, so a member watching reads
       * "0 of 400" and not a progress line that vanished. `targetVersion` is
       * deliberately left at the *old*, lower mark — anything changed since is
       * above it and will be caught by the next walk regardless.
       */
      console.warn(
        `A Zotero walk restarted: ${cursor.total} results became ${headers.totalResults}.`,
      );
      await ctx.runMutation(internal.zotero.markSwept, {
        linkId: args.linkId,
        connectedAt: payload.connectedAt,
        statusCode: null,
        restartWalk: true,
      });
      return nothing;
    }

    const body = await bodyOf(response);
    if (!Array.isArray(body)) {
      // A `200` Margin could not read is a refusal, not an empty page, and the
      // difference is the whole walk. Zotero answers a proxy error or a
      // maintenance page with HTML often enough that `bodyOf` exists for it —
      // and read as an empty page, that HTML is a *short* page, which closes
      // the walk and moves `lastVersion` to the version it started at. The
      // three thousand items it never looked at all have versions below that
      // mark, so `?since=` excludes them from every future walk and they are
      // gone until somebody edits each one in Zotero by hand. Ending the run
      // here leaves the cursor exactly where it was, which is what an hour
      // from now is for.
      console.error("A Zotero page came back as something other than a list.");
      await ctx.runMutation(internal.zotero.markSwept, {
        linkId: args.linkId,
        connectedAt: payload.connectedAt,
        statusCode: null,
      });
      return nothing;
    }
    // What Zotero was asked for, whatever it sent. `limit=25` is a request,
    // and a page that ignores it — a proxy, a future API, something hostile —
    // would otherwise buy 100 `/children` requests and 100 downloads inside
    // one action, which is the exact shape `SYNC_PAGE_ITEMS` exists to refuse.
    // The offset arithmetic stays honest because it counts what was kept, and
    // so does `exhausted`: a page sliced down to 25 is not a short page.
    const items = body.slice(0, SYNC_PAGE_ITEMS);
    const targetVersion =
      cursor?.targetVersion ?? headers.lastModifiedVersion ?? payload.lastVersion ?? 0;
    const total = cursor?.total ?? headers.totalResults ?? items.length;

    const candidates = candidatesIn(items);

    const fresh = new Set(
      await ctx.runQuery(internal.zotero.newAmong, {
        labId: payload.labId,
        candidates,
      }),
    );

    const entries: (ZoteroReference & { storageId?: Id<"_storage"> })[] = [];
    for (const candidate of candidates) {
      if (!fresh.has(candidate.zoteroItemKey)) {
        entries.push(candidate);
        continue;
      }
      entries.push({
        ...candidate,
        storageId: await fetchPdfFor(ctx, library, candidate.zoteroItemKey, payload.apiKey),
      });
    }

    const outcome = await ctx.runMutation(internal.zotero.commitPage, {
      linkId: args.linkId,
      connectedAt: payload.connectedAt,
      // Everything this page was read against travels with it, and the
      // mutation refuses the page if any of it has moved since.
      libraryType: payload.libraryType,
      libraryId: payload.libraryId,
      collectionKey: payload.collectionKey,
      fetchedFrom: {
        start: cursor?.start,
        lastVersion: payload.lastVersion,
      },
      entries,
      walked: items.length,
      targetVersion,
      total,
      // A short page is Zotero saying there is no more, whatever
      // `Total-Results` claimed when the walk started — libraries shrink too.
      exhausted: items.length < SYNC_PAGE_ITEMS,
    });
    if (headers.backoffMs !== null) {
      // Zotero asking for room. Honoured before this action returns rather
      // than remembered, because the next request is most often the next run
      // and there is nowhere durable to remember it that is worth a field.
      await pause(headers.backoffMs);
    }
    return outcome;
  },
});

/**
 * Sync now. One run, one page, and an honest answer about whether it finished.
 *
 * Public and member-triggered. `done: false` is what the button turns into
 * "…and there's more — press again, or leave it to the hourly check", which is
 * the sentence that keeps the cap from reading as a bug.
 */
export const syncNow = action({
  args: { labId: v.id("labs") },
  returns: v.object({ imported: v.number(), skipped: v.number(), done: v.boolean() }),
  handler: async (ctx, args): Promise<{ imported: number; skipped: number; done: boolean }> => {
    const linkId: Id<"zoteroLinks"> | null = await ctx.runQuery(
      internal.zotero.callerLinkId,
      { labId: args.labId },
    );
    if (linkId === null) {
      throw new ConvexError(
        "There's no Zotero library linked here yet. Paste a key first.",
      );
    }
    return await ctx.runAction(internal.zotero.syncLink, { linkId });
  },
});

/* -------------------------------------------------------------------------
 * The hourly sweep
 * ---------------------------------------------------------------------- */

/** The links that have not been looked at in an hour, most overdue first. */
export const dueLinks = internalQuery({
  args: {},
  returns: v.array(v.id("zoteroLinks")),
  handler: async (ctx) => {
    const due = await ctx.db
      .query("zoteroLinks")
      .withIndex("by_due", (q) => q.lte("lastSyncAt", Date.now() - SYNC_INTERVAL_MS))
      .take(MAX_SWEEP_LINKS);
    return due.map((link) => link._id);
  },
});

/**
 * The cron's entry point: look at everything overdue, an hour at a time.
 *
 * Fanned out with `runAfter(0, …)` rather than run inline — the pattern
 * `convex/digests.ts:450` uses — so one member's slow library does not hold up
 * everybody else's, and a run that fails takes only itself down.
 *
 * Bounded at `MAX_SWEEP_LINKS` per tick for the reason every read in this
 * codebase is bounded: an unbounded sweep is a table scan on a schedule, and
 * an hour later it is a larger one. A deployment with more overdue links than
 * that catches up over the following hours, in `lastSyncAt` order, which is
 * the fair order.
 */
export const sweep = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const linkIds = await ctx.runQuery(internal.zotero.dueLinks, {});
    for (const linkId of linkIds) {
      await ctx.scheduler.runAfter(0, internal.zotero.syncLink, { linkId });
    }
    return null;
  },
});
