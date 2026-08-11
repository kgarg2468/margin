import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { pause, retryAfterMs } from "./auth";
import { getMembership, requireMembership, requireUserId } from "./lib/authz";
import { recordEvent } from "./lib/ledger";
import {
  ZOTERO_API_VERSION,
  collectionsUrl,
  groupsUrl,
  keysCurrentUrl,
  normalizeApiKey,
  parseCollections,
  parseGroups,
  parseKeyPermissions,
  type ZoteroLibrary,
} from "../lib/zotero/api";

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
 */
export async function zoteroFetch(
  url: string,
  apiKey: string,
  options: { ifModifiedSinceVersion?: number } = {},
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
    const detail = await response.text().catch(() => "");
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

/** The library a link points at, in the shape `lib/zotero/api.ts` addresses. */
export function libraryOf(link: Doc<"zoteroLinks">): ZoteroLibrary {
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
      lastVersion: undefined,
      syncCursor: undefined,
      lastSyncAt: undefined,
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
    const response = await zoteroFetch(groupsUrl(link.libraryId), link.apiKey);
    const groups = parseGroups(await bodyOf(response));
    return {
      libraries: [
        { type: "user" as const, id: link.libraryId, name: "My library" },
        ...groups.map((group) => ({
          type: "group" as const,
          id: group.id,
          name: group.name,
        })),
      ],
    };
  },
});

/** The collections in whichever library is currently chosen. */
export const listCollections = action({
  args: { labId: v.id("labs") },
  returns: v.object({
    collections: v.array(v.object({ key: v.string(), name: v.string() })),
  }),
  handler: async (ctx, args) => {
    const link = await callerLink(ctx, args.labId);
    const response = await zoteroFetch(
      collectionsUrl({ type: link.libraryType, id: link.libraryId }),
      link.apiKey,
    );
    return { collections: parseCollections(await bodyOf(response)) };
  },
});

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
 * that far, so it does not.
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
    await ctx.db.patch(link._id, {
      libraryType: args.libraryType,
      libraryId: args.libraryId,
      libraryName: args.libraryName,
      collectionKey: args.collectionKey,
      collectionName: args.collectionName,
      lastVersion: undefined,
      syncCursor: undefined,
      lastSync: undefined,
    });
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
      lastSyncAt: link.lastSyncAt ?? null,
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
