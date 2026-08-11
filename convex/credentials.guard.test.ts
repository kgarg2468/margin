import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { v, type ValidatorJSON } from "convex/values";
import { describe, expect, it } from "vitest";
import schema from "./schema";
import { FakeCtx, handlerOf, seedLab } from "./delegations.fixtures";
import { normalizeWebhookUrl, slackIsConfigured } from "./lib/slack";
import { permanentStatus, recordDeliveryOutcome, SlackRefusal } from "./slack";
import {
  composeBoundaryMessage,
  composeBriefMessage,
  composeSynthesisMessage,
  slackDate,
  type SlackBlock,
  type SlackMessage,
} from "../lib/slack/compose";

/**
 * THE THIRD THING THAT LEAVES THE BUILDING, AND EVERY CREDENTIAL THAT HOLDS
 * A DOOR OPEN.
 *
 * `convex/privacy.guard.test.ts` asserts the half of Margin's promise that
 * lives in the schema. `convex/email.guard.test.ts` asserts the half that
 * leaves in an envelope. This asserts the half that leaves through a webhook,
 * and — since B5 — the half a bearer key lets in.
 *
 * Two credentials, one rule. A Slack incoming-webhook URL lets anyone holding
 * it post into a lab's channel as the lab, forever, with no further
 * authentication. A Zotero API key is worse in the direction that matters: it
 * reads one person's entire personal library, which is a reading history, and
 * `convex/privacy.guard.test.ts` exists because Margin does not hold those.
 * Both are per-*product-surface* values rather than deployment variables,
 * which means both get out the same ordinary way — somebody adds one to a
 * query's returns because the settings page would be easier to write with it
 * there, and it is then in a browser's query cache, in a React devtools pane,
 * and in the memory of every machine that page was ever opened on.
 *
 * One file rather than two, because a rule that holds in two places holds in
 * one of them by the end of the year. So the pattern below is named for
 * credentials rather than for webhooks, and every assertion that enumerates
 * what it covers names both.
 *
 * So the promises, restated as assertions:
 *
 *   - No public function returns either credential, anywhere in the codebase.
 *     Checked by reading every public function's own returns validator out of
 *     Convex's introspection, not by grepping.
 *   - The webhook lives on `labs` and the API key on `zoteroLinks`, and
 *     nowhere else; the append-only ledger copies neither.
 *   - One module holds each transport, so these rules have one place to hold.
 *   - A composed message reaches for nothing remote, links only where it says
 *     it does, and sells nothing — the email constitution, in a channel.
 *   - A lab member's own words cannot become Slack markup on the way out.
 *
 * IF THIS FILE FAILS, YOU HAVE LEAKED A CREDENTIAL OR BROKEN A PRODUCT PROMISE.
 * The failure is the point. Do not relax an assertion to make it pass.
 */

/* -------------------------------------------------------------------------
 * Validator introspection — the same walk `privacy.guard.test.ts` does
 * ---------------------------------------------------------------------- */

type Json = unknown;

function isRecord(node: Json): node is Record<string, Json> {
  return typeof node === "object" && node !== null && !Array.isArray(node);
}

/** One field declared somewhere in a validator, with the type it was given. */
type DeclaredField = {
  /** `a.b.c` from the root of the validator. */
  path: string;
  /** The field's own type, in wire form. `null` when the shape had none. */
  fieldType: Json;
};

/** Every field declared anywhere under `node`, with its declared type. */
function declaredFields(node: Json, prefix: string[] = []): DeclaredField[] {
  if (Array.isArray(node)) {
    return node.flatMap((child) => declaredFields(child, prefix));
  }
  if (!isRecord(node)) return [];

  if (node.type === "object" && isRecord(node.value)) {
    return Object.entries(node.value).flatMap(([name, entry]) => {
      const path = [...prefix, name];
      const fieldType = isRecord(entry) ? ((entry.fieldType ?? null) as Json) : null;
      const nested = fieldType === null ? [] : declaredFields(fieldType, path);
      return [{ path: path.join("."), fieldType }, ...nested];
    });
  }

  return Object.entries(node)
    .filter(([key]) => key !== "type" && key !== "tableName")
    .flatMap(([, child]) => declaredFields(child, prefix));
}

/** Every field declared anywhere under `node`, as `a.b.c` paths. */
function fieldPaths(node: Json, prefix: string[] = []): string[] {
  return declaredFields(node, prefix).map((field) => field.path);
}

/**
 * Whether this field could be holding a URL at all.
 *
 * A credential is a string. A number, a boolean, an id or a literal cannot
 * carry one however it is named, and `v.any()` could carry anything — which is
 * why the first assertion in this file refuses to let one exist in a returns
 * validator in the first place.
 *
 * Only the field's *own* type is consulted. A container is not a leak: fields
 * inside it are walked separately and judged on their own names, so an object
 * called `lastDeliveryFailed` is not damning and a string called `webhookUrl`
 * inside it still would be.
 */
function admitsText(fieldType: Json): boolean {
  if (Array.isArray(fieldType)) return fieldType.some(admitsText);
  if (!isRecord(fieldType)) return false;
  if (fieldType.type === "string" || fieldType.type === "any") return true;
  if (fieldType.type === "union") {
    return admitsText((fieldType.value ?? null) as Json);
  }
  return false;
}

/** Every place in `node` a credential could be hiding under a plausible name. */
function credentialShaped(node: Json): string[] {
  return declaredFields(node)
    .filter(
      (field) =>
        CREDENTIAL_ISH.test(field.path.split(".").at(-1) ?? field.path) &&
        (field.fieldType === null || admitsText(field.fieldType)),
    )
    .map((field) => field.path);
}

/** Every `v.any()` under `node`, as paths — the places this file cannot see. */
function opaquePaths(node: Json, prefix: string[] = []): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((child) => opaquePaths(child, prefix));
  }
  if (!isRecord(node)) return [];
  if (node.type === "any") return [prefix.length === 0 ? "<returns>" : prefix.join(".")];

  if (node.type === "object" && isRecord(node.value)) {
    return Object.entries(node.value).flatMap(([name, entry]) =>
      isRecord(entry) ? opaquePaths((entry.fieldType ?? null) as Json, [...prefix, name]) : [],
    );
  }

  return Object.entries(node)
    .filter(([key]) => key !== "type" && key !== "tableName")
    .flatMap(([, child]) => opaquePaths(child, prefix));
}

function wireForm(validator: unknown): ValidatorJSON {
  const json = (validator as { json?: unknown }).json;
  if (!isRecord(json)) {
    throw new Error(
      "Convex validator has no `.json` wire form; this guard cannot introspect the schema and must not be assumed to pass.",
    );
  }
  return json as ValidatorJSON;
}

/**
 * The indexes a table declares, by name.
 *
 * Convex exposes these under a method whose name is a literal space followed
 * by `indexes` — awkward on purpose, because it is experimental API. So this
 * is one narrow accessor with a runtime assertion rather than a cast at every
 * call site, the same trade `handlerOf` makes in `delegations.fixtures.ts`: if
 * a future release renames it, the suite fails here, with a sentence, instead
 * of quietly asserting about an empty list.
 */
function indexNames(table: unknown): string[] {
  const read = (table as Record<string, unknown>)[" indexes"];
  if (typeof read !== "function") {
    throw new Error(
      "A Convex TableDefinition no longer exposes its indexes; this guard cannot see whether dedupe has an index and must not be assumed to pass.",
    );
  }
  return (read.call(table) as { indexDescriptor: string }[]).map(
    (index) => index.indexDescriptor,
  );
}

/**
 * One variant of the `events` union, as its field names and their types.
 *
 * Pulled out by the `type` literal rather than by position, so reordering the
 * union — or adding a variant above it — cannot quietly point an assertion at
 * somebody else's row shape.
 */
function eventVariant(typeName: string): Record<string, Json> {
  const events: Json = wireForm(schema.tables.events.validator);
  const members =
    isRecord(events) && Array.isArray(events.value) ? events.value : [];

  for (const member of members) {
    if (!isRecord(member) || !isRecord(member.value)) continue;
    const declared = member.value.type;
    if (!isRecord(declared)) continue;
    const literal = declared.fieldType;
    if (
      isRecord(literal) &&
      literal.type === "literal" &&
      literal.value === typeName
    ) {
      return Object.fromEntries(
        Object.entries(member.value).map(([name, entry]) => [
          name,
          isRecord(entry) ? ((entry.fieldType ?? null) as Json) : null,
        ]),
      );
    }
  }

  throw new Error(
    `No \`${typeName}\` variant in the events validator, so this guard is asserting about a shape that no longer exists.`,
  );
}

/**
 * What a field name has to look like to be a credential getting out.
 *
 * Matched on the field name rather than on its value, because a validator has
 * no values — and named broadly, because the leak this exists to catch is
 * somebody adding `slackUrl`, `deliveryUrl` or `zoteroApiKey` to a returns
 * shape while thinking about a settings form rather than about a credential.
 * The first version of this pattern promised `deliveryUrl` in that sentence
 * and did not match it; `hookUrl`, `channelUrl`, `postUrl` and
 * `slackDestination` walked past it too, and then a whole second credential
 * did. Being wrong about which names are suspicious is the one way this file
 * fails silently, so the pattern is deliberately over-eager and `admitsText`
 * does the narrowing — on the field's type, which cannot be talked into
 * anything.
 *
 * Two words are deliberately *not* here. Bare `key` would match
 * `papers.zoteroItemKey`, `zoteroLinks.collectionKey` and the `key` on a
 * brief section — opaque public identifiers, every one, and flagging them
 * would either get this pattern relaxed by the next person or force renames
 * that made the schema worse. Bare `zotero` would match the same item key for
 * the same non-reason. `apikey` matches `apiKey` and matches neither.
 */
const CREDENTIAL_ISH =
  /webhook|hook|slack|deliver|destination|endpoint|channel|post|apikey|zoterokey|token|secret|credential/i;

/**
 * The pattern, held to the names it claims to cover.
 *
 * A regex is the kind of thing that quietly stops matching what its comment
 * says it matches — which is precisely how the first version of it shipped.
 * This list is the review's own; `channel`/`post` are here because two of the
 * names on it still walked past the widened pattern until they were added,
 * and the key-and-token spellings are here because a Zotero key is a
 * credential this file did not cover at all until it was told to —
 * `zoteroKey` among them, the audit's third spelling, which walked past
 * the first widening too.
 */
const PLAUSIBLE_NAMES = [
  "webhookUrl",
  "slackUrl",
  "deliveryUrl",
  "hookUrl",
  "channelUrl",
  "destinationUrl",
  "postUrl",
  "slackDestination",
  "incomingWebhook",
  "apiKey",
  "zoteroApiKey",
  "zoteroKey",
  "accessToken",
  "clientSecret",
] as const;

const normalizeName = (name: string): string =>
  name.toLowerCase().replace(/[^a-z]/g, "");

/* -------------------------------------------------------------------------
 * 1. No public function hands the credential to a browser
 * ---------------------------------------------------------------------- */

/**
 * Every module under `convex/`, imported.
 *
 * Read off the directory rather than listed by hand, for the reason
 * `email.guard.test.ts` gives: a hard-coded list only constrains what is on it,
 * so the first leak in a module added next month — which is exactly the drift
 * this exists to catch — would sail past.
 */
const convexDir = fileURLToPath(new URL(".", import.meta.url));

const moduleNames = readdirSync(convexDir, { recursive: true })
  .map(String)
  .filter(
    (name) =>
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".fixtures.ts") &&
      !name.startsWith("_generated") &&
      name !== "schema.ts" &&
      name !== "auth.config.ts" &&
      name !== "tsconfig.json",
  )
  .sort();

const loaded = await Promise.all(
  moduleNames.map(async (name) => ({
    name,
    exports: (await import(
      /* @vite-ignore */ new URL(`./${name}`, import.meta.url).href
    )) as Record<string, unknown>,
  })),
);

/** One exported Convex function, with the bits this file needs. */
type Registered = {
  module: string;
  name: string;
  isPublic: boolean;
  kind: "query" | "mutation" | "action";
  returns: ValidatorJSON | null;
};

const registered: Registered[] = loaded.flatMap(({ name, exports }) =>
  Object.entries(exports).flatMap(([exported, value]) => {
    if (typeof value !== "function") return [];
    const fn = value as unknown as Record<string, unknown>;
    const kind =
      fn.isQuery === true
        ? "query"
        : fn.isMutation === true
          ? "mutation"
          : fn.isAction === true
            ? "action"
            : null;
    if (kind === null) return [];
    const exportReturns = fn.exportReturns;
    return [
      {
        module: name,
        name: `${name.replace(/\.ts$/, "")}.${exported}`,
        isPublic: fn.isPublic === true,
        kind,
        returns:
          typeof exportReturns === "function"
            ? (JSON.parse(
                (exportReturns as () => string)(),
              ) as ValidatorJSON)
            : null,
      } satisfies Registered,
    ];
  }),
);

const publicFunctions = registered.filter((fn) => fn.isPublic);

describe("no credential ever reaches a client", () => {
  it("found the functions it means to be checking", () => {
    // A walk that matched nothing would make every assertion below vacuous.
    expect(loaded.length).toBeGreaterThan(15);
    expect(moduleNames).toContain("slack.ts");
    expect(moduleNames).toContain("labs.ts");
    expect(publicFunctions.length).toBeGreaterThan(40);
    // And the introspection actually produced shapes, rather than nulls.
    const named = publicFunctions.map((fn) => fn.name);
    expect(named).toContain("slack.status");
    expect(named).toContain("labs.getLab");

    // Every public function Margin declares says what it returns, so the walk
    // below has a shape to walk. The three exceptions are not Margin's: they
    // are what `convexAuth()` registers on our behalf, and the library does
    // not declare a returns validator for them. Named rather than tolerated by
    // a fuzzy count, so a *fourth* undeclared function — which would be a
    // Margin function the leak check silently could not see into — fails here.
    const undeclared = publicFunctions
      .filter((fn) => fn.returns === null)
      .map((fn) => fn.name)
      .sort();
    expect(undeclared).toEqual([
      "auth.isAuthenticated",
      "auth.signIn",
      "auth.signOut",
    ]);

    // Declaring a returns validator is not enough; it has to be a validator
    // that says something. `v.any()` satisfies every check above — it is not
    // null, it parses, it has a type — while describing no fields at all, so a
    // webhook URL returned under one is invisible to the scan below and the
    // suite still goes green. A declared shape that admits anything is the
    // same hole as no declared shape, wearing a hat.
    const opaque = publicFunctions
      .flatMap((fn) => opaquePaths(fn.returns).map((path) => `${fn.name} → ${path}`))
      .sort();
    expect(
      opaque,
      "v.any() in a returns validator makes the leak scan below blind",
    ).toEqual([]);

    // And the walk that produced that empty list can see an `any` when there
    // is one — at the root and buried — so the assertion above is a fact about
    // Margin rather than a fact about a broken recursion.
    expect(opaquePaths(wireForm(v.any()))).toEqual(["<returns>"]);
    expect(
      opaquePaths(wireForm(v.object({ outer: v.object({ inner: v.any() }) }))),
    ).toEqual(["outer.inner"]);
    // The same shape with a real type in it is not flagged.
    expect(
      opaquePaths(wireForm(v.object({ outer: v.object({ inner: v.string() }) }))),
    ).toEqual([]);
  });

  it("recognises every name a credential would plausibly be given", () => {
    // The scan below is only as good as this pattern. Checked directly, so the
    // day it stops matching one of these it fails here — loudly, with the name
    // in the message — rather than by returning an empty offender list.
    const missed = PLAUSIBLE_NAMES.filter((name) => !CREDENTIAL_ISH.test(name));
    expect(missed).toEqual([]);
    // And it is not simply matching everything, which would pass the line
    // above while flagging half the schema. The last three are the names this
    // widening came closest to eating: opaque identifiers, not secrets.
    expect(
      ["title", "createdAt", "body", "quote", "zoteroItemKey", "collectionKey", "libraryId"]
        .filter((n) => CREDENTIAL_ISH.test(n)),
    ).toEqual([]);
  });

  it("declares no credential-shaped field in any public returns validator", () => {
    const offenders = publicFunctions.flatMap((fn) =>
      credentialShaped(fn.returns).map((path) => `${fn.name} → ${path}`),
    );

    expect(
      offenders,
      "A Slack webhook URL and a Zotero API key are credentials. Neither has any business in a query result, a browser cache, or a devtools pane — not even the PI's.",
    ).toEqual([]);
  });

  it("does put them in the internal queries that need them, so the check is real", () => {
    // The inverse assertion. If the walk could not see a credential field at
    // all, the one above would pass for the wrong reason forever. Named rather
    // than counted, so a payload that stopped carrying its credential — and
    // therefore stopped proving anything — fails here with its own name.
    const internalWithCredential = registered
      .filter((fn) => !fn.isPublic && credentialShaped(fn.returns).length > 0)
      .map((fn) => fn.name)
      .sort();

    expect(internalWithCredential).toContain("slack.boundaryPayload");
    expect(internalWithCredential).toContain("slack.briefPayload");
    expect(internalWithCredential).toContain("slack.synthesisPayload");
  });

  it("names zotero.syncPayload as the only Zotero carrier", () => {
    const internalWithCredential = registered
      .filter((fn) => !fn.isPublic && credentialShaped(fn.returns).length > 0)
      .map((fn) => fn.name)
      .sort();

    expect(internalWithCredential).toEqual([
      "slack.boundaryPayload",
      "slack.briefPayload",
      "slack.synthesisPayload",
      "zotero.syncPayload",
    ]);
  });

  it("tells every member whether their lab posts, without telling them where", () => {
    // The product half of the same rule: `connected` is a fact a member is
    // owed — their writing may be read by a channel — and the URL is not.
    const status = publicFunctions.find((fn) => fn.name === "slack.status");
    expect(fieldPaths(status?.returns).sort()).toEqual([
      "canManage",
      "connected",
      "lastDeliveryFailed",
      "lastDeliveryFailed.at",
      "lastDeliveryFailed.statusCode",
    ]);
    // The failure signal is a status code and a timestamp. Not Slack's response
    // body, which is a string this query has no reason to be able to carry.
    expect(credentialShaped(status?.returns ?? null)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
 * 2. And only the tables that must hold one, hold one
 * ---------------------------------------------------------------------- */

describe("where the credential is stored", () => {
  const tables = Object.entries(schema.tables).map(
    ([name, table]) => [name, wireForm(table.validator)] as const,
  );

  it("lives on the tables that hold a credential, and no others", () => {
    // Sorted so the assertion is about *where credentials live*, not about
    // declaration order — reordering `schema.ts` for readability must not
    // read as a credential regression.
    const holders = tables
      .flatMap(([table, validator]) =>
        credentialShaped(validator).length > 0 ? [table] : [],
      )
      .sort();
    // Anchored in both directions: they are here, and nothing else is. A
    // fourth holder would be a fourth lifetime to reason about and a fourth
    // read path to forget to gate. `labs` carries the lab's Slack webhook;
    // `zoteroLinks` carries one member's own read key, which is why it is not
    // on `labs` beside the other one — a shared key would let any member read
    // the PI's entire personal library.
    //
    // `authAccounts.secret` is the third, and it is on this list rather than
    // exempted from the walk because it is genuinely a credential and the
    // whole point of anchoring in both directions is that nothing gets to be
    // invisible here. It is not Margin's: `authTables` is spread in from
    // `@convex-dev/auth` (`convex/schema.ts:1`), the column holds a password
    // hash rather than a bearer token, and no Margin function reads it. It
    // appeared the day this pattern learned the word `secret`, which is the
    // widening working — the assertion above already proves no public returns
    // validator carries it either.
    expect(holders).toEqual(["authAccounts", "labs", "zoteroLinks"]);
    expect(fieldPaths(wireForm(schema.tables.labs.validator))).toContain(
      "slackWebhookUrl",
    );
    expect(fieldPaths(wireForm(schema.tables.zoteroLinks.validator))).toContain(
      "apiKey",
    );
  });

  it("is never copied into the append-only ledger", () => {
    // `events` rows are never updated and never deleted, so a credential in
    // one would outlive every disconnection — including the one a lab performs
    // *because* the credential leaked.
    const events = wireForm(schema.tables.events.validator);
    expect(credentialShaped(events)).toEqual([]);

    // Named directly for the variant that records a dead channel, because it
    // is the one written from a delivery path — the only place in the codebase
    // where a ledger write happens with the URL in scope.
    const failure = eventVariant("slack.delivery_failed");
    expect(
      Object.keys(failure).sort(),
      "the ledger row for a failed post carries a status code and which artifact it was, and nothing else",
    ).toEqual([
      "actorId",
      "artifact",
      "at",
      "deliveryAt",
      "labId",
      "paperId",
      "sessionId",
      "statusCode",
      "type",
    ]);
    // Nothing in it is a string, so there is no field a URL could be put in
    // without changing this schema and failing here.
    const stringy = Object.entries(failure)
      .filter(([, fieldType]) => admitsText(fieldType))
      .map(([name]) => name);
    expect(stringy).toEqual([]);
    // And prove the ledger does record the fact itself, so members can see in
    // the record when their margin started leaving the building.
    expect(fieldPaths(events)).toContain("connected");
  });

  it("records the switch without describing it as reading", () => {
    // The privacy constitution's own vocabulary check, applied to the variant
    // this branch adds: nothing here may be spelled as a view or a read.
    const names = Object.keys(schema.tables).map(normalizeName);
    expect(names).toContain("labs");
    expect(names.some((name) => name.includes("slack"))).toBe(false);
  });
});

describe("the Zotero link, specifically", () => {
  const zotero = wireForm(schema.tables.zoteroLinks.validator);

  it("holds the key and a non-secret identity for it", () => {
    const fields = fieldPaths(zotero);
    expect(fields).toContain("apiKey");
    // The `slackConnectedAt` role. A sync outcome scheduled from an action can
    // land after the member replaced their key, and without this the settings
    // row would report a dead key against a live one.
    expect(fields).toContain("connectedAt");
    // No `enabled` boolean. Absence of the row is the only "off" there is,
    // for the reason `labs.slackWebhookUrl` gives at length.
    expect(fields).not.toContain("enabled");
  });

  it("is one member's own link, not the lab's", () => {
    // The one genuine departure from the Slack precedent, asserted rather
    // than commented: a Zotero personal library is one person's, and a
    // lab-wide key would let any member read the PI's reading history —
    // exactly what `convex/privacy.guard.test.ts` exists to prevent by other
    // means. The destination is still the lab; the credential is not.
    const fields = fieldPaths(zotero);
    expect(fields).toContain("userId");
    expect(fields).toContain("labId");
  });

  it("carries no Zotero credential into the ledger", () => {
    const events = wireForm(schema.tables.events.validator);
    expect(credentialShaped(events)).toEqual([]);

    // The connect/disconnect fact, named directly. `connected` says which way
    // the switch moved, which is the whole fact; an `events` row is never
    // deleted, so a key in one would outlive every disconnection — including
    // the one a member performs *because* the key leaked.
    //
    // `paperId` and `sessionId` are `eventBase`'s, optional on every row in
    // the table because `by_paper_and_at` and `by_session_and_at` index them
    // (`convex/schema.ts:286-300`) — the same two the `slack.delivery_failed`
    // assertion above carries for the same reason. Neither is written here.
    const changed = eventVariant("zotero.link_changed");
    expect(Object.keys(changed).sort()).toEqual([
      "actorId",
      "at",
      "connected",
      "labId",
      "paperId",
      "sessionId",
      "type",
    ]);

    // And the sync fact carries counts, never content. Not a title, not an
    // item key, not a library name — a summary of how many rows arrived.
    const synced = eventVariant("zotero.synced");
    expect(Object.keys(synced).sort()).toEqual([
      "actorId",
      "at",
      "imported",
      "labId",
      "paperId",
      "sessionId",
      "skipped",
      "type",
    ]);
    const stringy = Object.entries(synced)
      .filter(([, fieldType]) => admitsText(fieldType))
      .map(([name]) => name);
    // `type` is a literal, not a string; nothing else in the row is text at
    // all, so there is no field a library's name could be put in without
    // changing this schema and failing here.
    expect(stringy).toEqual([]);
  });

  it("gives the item key an index, so dedupe is never a scan", () => {
    // The whole reason this field exists. Without an index, "have I already
    // imported this Zotero item?" is a full read of the lab's papers per
    // candidate — which is `createFromMetadata`'s shape (`convex/papers.ts:
    // 369-376`) and the second-riskiest thing in the B5 audit.
    const indexes = indexNames(schema.tables.papers);
    expect(indexes).toContain("by_lab_and_zotero_item");
    expect(indexes).toContain("by_lab_and_doi");
  });

  it("gives the cron sweep an index too", () => {
    // A sweep without an index is a full-table scan on a schedule.
    const indexes = indexNames(schema.tables.zoteroLinks);
    expect(indexes).toContain("by_user_and_lab");
    expect(indexes).toContain("by_due");
  });
});

/* -------------------------------------------------------------------------
 * 3. One module holds each transport
 * ---------------------------------------------------------------------- */

describe("the modules that hold a credential", () => {
  const sources = moduleNames.map((name) => ({
    name,
    // Comments are stripped so the prose explaining a rule cannot break it.
    code: readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, ""),
  }));

  it("found the sources it means to be checking", () => {
    expect(sources.length).toBeGreaterThan(15);
    expect(sources.find((s) => s.name === "slack.ts")?.code ?? "").toContain(
      "postToSlack",
    );
  });

  it("names Slack's host in exactly two places, and means both", () => {
    const naming = sources
      .flatMap(({ name, code }) => (code.includes("hooks.slack.com") ? [name] : []))
      .sort();
    // `lib/slack.ts` decides what a valid destination is; `slack.ts` says so to
    // the PI in the refusal copy when a paste is wrong. Nothing else has any
    // business knowing the host, and a third file naming it is a second
    // validator or a second transport.
    expect(naming).toEqual(["lib/slack.ts", "slack.ts"]);
  });

  it("routes every post through the one transport", () => {
    // A `fetch` to a lab-supplied URL belongs in exactly one function. A second
    // one would be a second place for the retry rule, the logging rule and the
    // "never put the URL in an error" rule to not hold.
    const posting = sources
      .flatMap(({ name, code }) =>
        code.includes("postToSlack(") ? [name] : [],
      )
      .sort();
    expect(posting).toEqual(["slack.ts"]);
  });

  it("keeps the credential out of anything that gets logged", () => {
    // Slack's refusal body is genuinely the most useful thing in a log and
    // carries no secret; the URL does. Nothing in the module interpolates it
    // into a `console` call.
    const slack = sources.find((source) => source.name === "slack.ts");
    const logged = [
      ...(slack?.code.matchAll(/console\.(?:error|warn|log)\(([\s\S]*?)\);/g) ??
        []),
    ].map((match) => match[1] ?? "");
    expect(logged.length).toBeGreaterThan(0);
    for (const call of logged) {
      expect(call).not.toMatch(/webhookUrl/i);
    }
  });

  it("names Zotero's host in exactly one place, and means it", () => {
    // `lib/zotero/api.ts` decides what a Zotero address is. No module under
    // `convex/` has any business building one, and a second one that did
    // would be a second place for the "never in a query parameter" rule to
    // not hold.
    const naming = sources
      .flatMap(({ name, code }) => (code.includes("api.zotero.org") ? [name] : []))
      .sort();
    expect(naming).toEqual([]);
  });

  it("routes every Zotero request through the one transport", () => {
    // A `fetch` carrying a member's API key belongs in exactly one function.
    // A second one would be a second place for the redirect rule, the retry
    // rule and the "never put the key in an error" rule to not hold.
    const carrying = sources
      .flatMap(({ name, code }) =>
        code.includes("Zotero-API-Key") ? [name] : [],
      )
      .sort();
    expect(carrying).toEqual(["zotero.ts"]);
  });

  it("never lets a credentialed request follow a redirect", () => {
    // The finding this whole rule exists for: `fetch` strips `Authorization`
    // across a cross-origin redirect and strips nothing else, so a followed
    // 302 from `/items/<key>/file` hands a member's key to Amazon. Every
    // `fetch` in the module that carries the key sets `redirect: "manual"`;
    // the one that does not carry it is the second hop, and it is named.
    const zotero = sources.find((source) => source.name === "zotero.ts")?.code ?? "";
    const fetches = [...zotero.matchAll(/\bfetch\(/g)];
    expect(fetches.length).toBeGreaterThan(0);
    const manual = [...zotero.matchAll(/redirect:\s*"manual"/g)];
    expect(manual.length).toBe(fetches.length);
  });

  it("keeps the Zotero key out of anything that gets logged", () => {
    const zotero = sources.find((source) => source.name === "zotero.ts");
    const logged = [
      ...(zotero?.code.matchAll(/console\.(?:error|warn|log)\(([\s\S]*?)\);/g) ?? []),
    ].map((match) => match[1] ?? "");
    expect(logged.length).toBeGreaterThan(0);
    for (const call of logged) {
      expect(call).not.toMatch(/apiKey/i);
    }
  });
});

/* -------------------------------------------------------------------------
 * 4. What a composed message may contain
 * ---------------------------------------------------------------------- */

const SITE = "https://margin.example.edu";
const SESSION_URL = `${SITE}/app/sessions/s1`;
const PAPER_URL = `${SITE}/app/library/p1/read`;

/**
 * A note whose author is trying to get something into the lab's channel.
 *
 * Every one of these strings is something a member can type into an annotation
 * and get carried, verbatim, into a brief line or a write-up — which is the
 * whole reason the composers escape rather than trust.
 */
const HOSTILE =
  "<https://evil.example|click here> & <!channel> <@U024BE7LH> ```rm -rf```";

const composed: { name: string; message: SlackMessage; url: string }[] = [
  {
    name: "brief",
    message: composeBriefMessage({
      paperTitle: `Attention & Ablation <all of it>`,
      when: slackDate(Date.UTC(2026, 7, 13, 16, 0, 0)),
      presenterName: "Ada <Lovelace>",
      approvedByName: "Ada & Grace",
      citationCount: 12,
      sections: [
        { heading: "Open questions", items: [HOSTILE], droppedCount: 0 },
      ],
      url: SESSION_URL,
    }),
    url: SESSION_URL,
  },
  {
    name: "boundary post",
    message: composeBoundaryMessage({
      paperTitle: "Attention & Ablation",
      when: slackDate(Date.UTC(2026, 7, 13, 16, 0, 0)),
      presenterName: "Ada <Lovelace>",
      lines: [HOSTILE],
      annotationCount: 41,
      url: PAPER_URL,
    }),
    url: PAPER_URL,
  },
  {
    name: "write-up",
    message: composeSynthesisMessage({
      paperTitle: "Attention & Ablation",
      when: slackDate(Date.UTC(2026, 7, 13, 16, 0, 0)),
      approvedByName: "Ada & Grace",
      markdown: `## What we settled\n\n- ${HOSTILE}`,
      citationCount: 18,
      revised: false,
      url: SESSION_URL,
    }),
    url: SESSION_URL,
  },
];

function textOf(block: SlackBlock): string {
  if (block.type === "divider") return "";
  if (block.type === "context") {
    return block.elements.map((element) => element.text).join("\n");
  }
  return block.text.text;
}

const wire = (message: SlackMessage): string => JSON.stringify(message);

describe("no message reaches for anything remote", () => {
  it.each(composed)("$name carries no image of any kind", ({ message }) => {
    // The email constitution's first rule, in a channel. A tracking pixel is
    // an `image` block, and so is a wordmark — the second is how the first
    // arrives, because a CDN's access log is an open-rate report nobody asked
    // for. Slack renders an `image_url` by fetching it *from the reader's
    // client*, which makes it exactly the beacon email has.
    const serialized = wire(message);
    expect(serialized).not.toMatch(/image_url/i);
    expect(serialized).not.toMatch(/icon_url/i);
    expect(serialized).not.toMatch(/"type"\s*:\s*"image"/i);
    expect(serialized).not.toMatch(/accessory/i);
    expect(serialized).not.toMatch(/thumb_url/i);
    expect(serialized).not.toMatch(/attachments/i);
  });

  it.each(composed)("$name links only where it says it does", ({
    message,
    url,
  }) => {
    // Every link in the document, in Slack's one link syntax. Exactly the one
    // the reader was offered — no second origin, and in particular nothing on
    // a redirector's domain with the real destination in a query string.
    const links = [
      ...wire(message).matchAll(/<(https?:\\?\/\\?\/[^|>]+)\|/g),
    ].map((match) => (match[1] ?? "").replace(/\\\//g, "/"));
    expect(new Set(links)).toEqual(new Set([url]));
  });

  it.each(composed)("$name quotes a member's URL without linking it", ({
    message,
  }) => {
    // The fixtures above all carry `HOSTILE`, so this is a property of the
    // composers rather than of the examples: a member's `<url|label>` arrives
    // as the characters they typed, and Slack renders it as text.
    const serialized = wire(message);
    expect(serialized).toContain("&lt;https://evil.example|click here&gt;");
    expect(serialized).not.toContain("<https://evil.example");
  });

  it.each(composed)("$name cannot be made to shout at a channel", ({
    message,
  }) => {
    // `<!channel>` and `<@U…>` are Slack's broadcast and mention commands, and
    // both are things a lab member can type into a note. Escaped, they are
    // words. Unescaped, one annotation could notify a whole workspace.
    const serialized = wire(message);
    expect(serialized).not.toContain("<!channel>");
    expect(serialized).not.toContain("<@U024BE7LH>");
    expect(serialized).toContain("&lt;!channel&gt;");
    // The one `<!…>` command in the document is the date Margin composed.
    const commands = [...serialized.matchAll(/<!([a-z]+)\^/g)].map(
      (match) => match[1],
    );
    expect(new Set(commands)).toEqual(new Set(["date"]));
  });
});

describe("no message monetizes", () => {
  const forbidden = [
    /\bupgrade\b/i,
    /\bpricing\b/i,
    /\bfree trial\b/i,
    /\bsubscription\b/i,
    /\bbilling\b/i,
    /\bper seat\b/i,
    /\bper user\/month\b/i,
  ];

  it.each(composed)("$name says nothing about money", ({ message }) => {
    const prose = [message.text, ...message.blocks.map(textOf)].join("\n");
    const offenders = forbidden.filter((pattern) => pattern.test(prose));
    expect(offenders.map(String)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
 * 5. What counts as a destination
 * ---------------------------------------------------------------------- */

describe("normalizeWebhookUrl", () => {
  const REAL = "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXX";

  it("takes a real incoming webhook, unchanged", () => {
    // The path is Slack's opaque secret. Normalizing any part of it — a case
    // fold, a stripped trailing slash — hands back a URL that no longer works.
    expect(normalizeWebhookUrl(REAL)).toBe(REAL);
    expect(normalizeWebhookUrl(`  ${REAL}\n`)).toBe(REAL);
  });

  it("takes the other shapes Slack issues", () => {
    const workflow =
      "https://hooks.slack.com/workflows/T000/A000/1234567890/abcdef";
    expect(normalizeWebhookUrl(workflow)).toBe(workflow);
    const trigger = "https://hooks.slack.com/triggers/T000/1234/abcdef";
    expect(normalizeWebhookUrl(trigger)).toBe(trigger);
  });

  it("refuses a host that merely contains Slack's", () => {
    // The reason this parses rather than matching a prefix. Both of these pass
    // `startsWith`-style thinking and neither is Slack.
    expect(
      normalizeWebhookUrl("https://hooks.slack.com.evil.example/services/x"),
    ).toBeNull();
    expect(
      normalizeWebhookUrl("https://evil.example/#https://hooks.slack.com/x"),
    ).toBeNull();
    expect(
      normalizeWebhookUrl("https://evil.example/https://hooks.slack.com/x"),
    ).toBeNull();
  });

  it("refuses plaintext, which is the credential on the wire", () => {
    expect(
      normalizeWebhookUrl("http://hooks.slack.com/services/T0/B0/X"),
    ).toBeNull();
  });

  it("refuses credentials in the authority", () => {
    expect(
      normalizeWebhookUrl("https://user:pass@hooks.slack.com/services/T0/B0/X"),
    ).toBeNull();
  });

  it("refuses a bare origin, which is what a half-copied paste looks like", () => {
    // Refused now, in front of the person who pasted it, rather than at the
    // T−2h boundary in a log nobody is reading.
    expect(normalizeWebhookUrl("https://hooks.slack.com")).toBeNull();
    expect(normalizeWebhookUrl("https://hooks.slack.com/")).toBeNull();
    expect(normalizeWebhookUrl("https://hooks.slack.com///")).toBeNull();
  });

  it("refuses what is not a URL at all", () => {
    expect(normalizeWebhookUrl("")).toBeNull();
    expect(normalizeWebhookUrl("   ")).toBeNull();
    expect(normalizeWebhookUrl("hooks.slack.com/services/T0/B0/X")).toBeNull();
    expect(normalizeWebhookUrl("javascript:alert(1)")).toBeNull();
    expect(
      normalizeWebhookUrl("file:///etc/passwd#hooks.slack.com"),
    ).toBeNull();
  });
});

describe("slackIsConfigured", () => {
  it("reads presence of the field as the whole answer", () => {
    expect(slackIsConfigured({ slackWebhookUrl: "https://x" })).toBe(true);
    expect(slackIsConfigured({})).toBe(false);
    expect(slackIsConfigured(null)).toBe(false);
  });

  it("treats a blank string as absent", () => {
    // The same reasoning `emailIsConfigured` applies to a deployment variable
    // saved empty: a value that is present but blank is not a value.
    expect(slackIsConfigured({ slackWebhookUrl: "" })).toBe(false);
  });
});

describe("which refusals a lab is told about", () => {
  // The rule that decides whether a settings page says "your channel may be
  // gone". Getting it wrong in either direction is a product failure: too
  // eager and the banner cries wolf every time Slack has a bad minute, too shy
  // and an archived channel swallows a lab's posts in silence forever.
  it("reports the refusals only the lab can fix", () => {
    expect(permanentStatus(new SlackRefusal("404 no_service", 404))).toBe(404);
    expect(permanentStatus(new SlackRefusal("403 invalid_token", 403))).toBe(403);
    expect(permanentStatus(new SlackRefusal("400 invalid_payload", 400))).toBe(400);
  });

  it("stays quiet about a bad minute", () => {
    // Slack overloaded, Slack rate-limiting past the retries, and a request
    // that never got an answer are all facts about a Tuesday.
    expect(permanentStatus(new SlackRefusal("503", 503))).toBeNull();
    expect(permanentStatus(new SlackRefusal("500", 500))).toBeNull();
    expect(permanentStatus(new SlackRefusal("429 rate limited", 429))).toBeNull();
    expect(permanentStatus(new SlackRefusal("unreachable", null))).toBeNull();
  });

  it("stays quiet about a failure that was ours", () => {
    // Anything that is not a refusal never reached Slack to be refused, so it
    // says nothing about the lab's channel.
    expect(permanentStatus(new TypeError("undefined is not a function"))).toBeNull();
    expect(permanentStatus("404")).toBeNull();
    expect(permanentStatus(null)).toBeNull();
  });
});

/* -------------------------------------------------------------------------
 * 5. A failure never outlives the thing it describes
 * ---------------------------------------------------------------------- */

/**
 * The outcome of a post is recorded by a mutation scheduled from an action,
 * and nothing orders those against each other or against a PI in the settings
 * page. So all three of these are reachable: a failure recorded after the
 * webhook it describes was replaced, a failure recorded after a later post
 * landed, and the same failure recorded twice.
 *
 * The first two would have the settings page telling a lab their channel may
 * be gone while their posts are arriving in it — a product lie assembled
 * entirely out of true facts, which is the kind that survives review. The
 * third would put two rows in an append-only ledger for one event.
 *
 * Driven against the real registered handler through the in-memory context in
 * `delegations.fixtures.ts`, because this is a transactional invariant and no
 * pure function can see it.
 */
describe("an outcome that arrives after the world moved", () => {
  const record = handlerOf(recordDeliveryOutcome);

  /** A lab with a webhook connected at `1_000`. */
  async function world() {
    const ctx = new FakeCtx();
    const seed = await seedLab(ctx);
    await ctx.db.patch(seed.labId, {
      slackWebhookUrl: "https://hooks.slack.com/services/T0/B0/first",
      slackConnectedAt: 1_000,
    });
    return { ctx, seed };
  }

  /** One failed post, with every coordinate it travels with. */
  const refusal = (over: Record<string, unknown> = {}) => ({
    artifact: "brief" as const,
    deliveryAt: 500,
    connectedAt: 1_000,
    attemptAt: 900,
    statusCode: 404,
    ...over,
  });

  const failures = (ctx: FakeCtx) =>
    ctx.db.all("events").filter((e) => e.type === "slack.delivery_failed");

  it("says nothing about a webhook the lab has already replaced", async () => {
    const { ctx, seed } = await world();
    // The PI pasted a new URL while the failure was still in the scheduler.
    await ctx.db.patch(seed.labId, {
      slackWebhookUrl: "https://hooks.slack.com/services/T0/B0/second",
      slackConnectedAt: 2_000,
    });

    await record(ctx, { sessionId: seed.sessionId, ...refusal() } as never);

    const lab = await ctx.db.get(seed.labId);
    expect(
      lab?.slackLastDelivery,
      "a 404 against the webhook that was thrown away says nothing about the one that replaced it",
    ).toBeUndefined();
  });

  it("says nothing once a later post has landed", async () => {
    const { ctx, seed } = await world();
    // The success was attempted after the failure, and recorded before it.
    await record(ctx, {
      sessionId: seed.sessionId,
      ...refusal({ deliveryAt: 1_500, attemptAt: 2_000, statusCode: null }),
    } as never);
    await record(ctx, { sessionId: seed.sessionId, ...refusal() } as never);

    const lab = await ctx.db.get(seed.labId);
    expect(
      lab?.slackLastDelivery?.statusCode,
      "posts are demonstrably arriving in that channel; the older refusal must not overwrite the proof",
    ).toBeUndefined();
  });

  it("clears the mark when a later post lands", async () => {
    const { ctx, seed } = await world();
    await record(ctx, { sessionId: seed.sessionId, ...refusal() } as never);
    expect((await ctx.db.get(seed.labId))?.slackLastDelivery?.statusCode).toBe(
      404,
    );

    // The lab fixed the channel; the banner should leave on its own.
    await record(ctx, {
      sessionId: seed.sessionId,
      ...refusal({ deliveryAt: 1_500, attemptAt: 2_000, statusCode: null }),
    } as never);
    expect(
      (await ctx.db.get(seed.labId))?.slackLastDelivery?.statusCode,
    ).toBeUndefined();
  });

  it("files one ledger event for one failed delivery, however often it is told", async () => {
    const { ctx, seed } = await world();
    // The same delivery, twice — a retried mutation, a re-run action.
    await record(ctx, { sessionId: seed.sessionId, ...refusal() } as never);
    await record(ctx, {
      sessionId: seed.sessionId,
      ...refusal({ attemptAt: 950 }),
    } as never);

    expect(failures(ctx)).toHaveLength(1);
  });

  it("keeps two genuinely distinct failures distinct", async () => {
    const { ctx, seed } = await world();
    // Two approvals of the same artifact, both failing. Two things happened,
    // and a ledger that collapsed them would be under-reporting.
    await record(ctx, { sessionId: seed.sessionId, ...refusal() } as never);
    await record(ctx, {
      sessionId: seed.sessionId,
      ...refusal({ deliveryAt: 700, attemptAt: 1_100 }),
    } as never);

    expect(failures(ctx)).toHaveLength(2);
  });

  it("carries the status code and the artifact into the ledger, and nothing else", async () => {
    const { ctx, seed } = await world();
    await record(ctx, { sessionId: seed.sessionId, ...refusal() } as never);

    const row = failures(ctx)[0];
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).not.toContain("hooks.slack.com");
  });
});
