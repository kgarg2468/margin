# B5 — Native Zotero Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A lab member links their own read-only Zotero key, picks one library and one collection, and the papers in it arrive on the lab's shelf — a bounded page at a time, manually or hourly, with the credential never leaving the server and the progress never overstated.

**Architecture:** One-way, Zotero → Margin. All pure rules (URL building, key shape, item mapping, attachment selection, header reading) live in `lib/zotero/` with vitest coverage against canned API fixtures and no network. `convex/zotero.ts` holds the only transport (`zoteroFetch`) and the Convex functions; the credential lives on one new `zoteroLinks` table, keyed `(userId, labId)`, and is carried by exactly one internal query. Sync is **resumable and bounded**: every run walks at most 25 items from a persisted `{ targetVersion, start, total, imported }` cursor, so no run is unbounded and no cron tick does unbounded work. Ground truth for every line number and current behaviour: `.superpowers/sdd/b5-zotero/audit.md` — the audit is accurate as of branch cut (`6b86273`) and each task restates what it needs from it.

**Tech Stack:** Next.js App Router, Convex (actions/mutations/queries + first `crons.ts`), Zotero Web API v3, Base UI, Tailwind semantic tokens, vitest (node env, `lib/**/*.test.ts` + `convex/**/*.test.ts`, no DOM harness).

## Global Constraints

- **No pricing, monetization, billing, upgrade or seat-count content anywhere** — not in copy, not in comments, not in a placeholder. The guard suites assert this for outbound artifacts and the rule holds for every surface this plan touches.
- **The Zotero API key is a bearer credential and is server-only.** No public query, mutation or action declares it in its returns validator. It lives on `zoteroLinks` and nowhere else. It is never written into the `events` ledger, never interpolated into a `console.*` call, never put in a URL query parameter, and never forwarded across a redirect.
- **`connectedAt` is the credential's non-secret identity** — the `labs.slackConnectedAt` role (`convex/schema.ts:993-1007`). It is what travels with a scheduled outcome so a late one can be recognised as describing a key the member has since replaced.
- **Absence of the row is the only representation of "disconnected".** No `enabled` boolean — two sources of truth for one question fail as a member who believes their library has stopped syncing and has not (`convex/schema.ts:986-991`).
- **Every sync run is bounded.** `SYNC_PAGE_ITEMS = 25` items maximum per run, cursor persisted, next run continues. No code path may `.collect()` a lab's papers per candidate item.
- Every public Convex function declares a real returns validator, never `v.any()` — `convex/credentials.guard.test.ts` fails on import otherwise.
- Ledger writes go through `recordEvent` in `convex/lib/ledger.ts` (eslint-enforced); events are appended, never patched or deleted.
- `useQuery` from `convex-helpers/react/cache/hooks`, never `convex/react` (eslint-enforced); `useMutation`/`useAction` from `convex/react`.
- All UI classes from `lib/ui.ts`; buttons carry `pressable` (via the shared button classes); colour through semantic tokens only; chrome sans, content serif.
- Human-readable refusals are `ConvexError`; the client renders them via `readableError` into `<p role="alert" className={errorClass}>`.
- Comments carry reasoning, not restatement. Schema fields get prose doc comments explaining the decision (`convex/schema.ts:969-1047` is the standard to meet).
- TDD: the failing test is written and *run* before the implementation, every task.
- Commits end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## Excluded from this version, deliberately

Say so if asked; do not build them. **Two-way sync (Margin → Zotero)** — contradicts `docs/STRATEGY.md:121` ("Don't rebuild citation management — 'Keep Zotero' is the pitch") and converts a disclosure risk into destruction of a PI's bibliography. **Annotation sync in either direction** — Zotero anchors to its own renderer's coordinates, Margin to pdf.js text-layer offsets in `paperPages`; there is no lossless mapping and a lossy one mis-anchors a lab's reasoning. **Group-library write-back.** **Mirroring Zotero collections into Margin `collections`** — a Margin collection is a reading order with a hard cap, a Zotero collection is a filing tree; a Zotero collection is used as a *selection filter at connect time* and never mirrored as rows. **Zotero tags → `papers.tags`** — that field is the lab's shelf marks, capped at 12; one member's personal vocabulary flooding it is a regression. **WebDAV-stored attachments** — not served by `api.zotero.org`; detected and skipped, the paper lands `needs-pdf`. **Real-time/webhook sync** — Zotero has no push; "live" means hourly and the copy says hourly. **More than one linked library per member per lab.**

## The two ceilings this plan stands on, stated once

1. `listPapers` reads the lab's library under one bounded `take(200)` and the schema says so out loud (`convex/schema.ts:1119-1122`). A typical Zotero library is 1,000–10,000 items. That is why the connect flow steers members at **one collection**, why the copy says so, and why the identity-dedupe map in Task 4 is read under the same `take(200)`. Lifting that ceiling is A3/library work, not B5's — but B5's caps are only defensible while it stands, so the two lanes must be flagged to each other.
2. `createFromMetadata` dedupes DOI-less records with a full `by_lab` `.collect()` per candidate (`convex/papers.ts:369-376`). At 25 items × 200 papers that is 5,000 document reads per run and it grows with the shelf. Task 4's `commitPage` reads the lab's papers **once** per run and dedupes an in-memory map. Do not copy `createFromMetadata`'s shape.

---

### Task 1: Schema, the credential constitution, and one generalized credential guard

**Files:**
- Modify: `convex/schema.ts` (new `zoteroLinks` table after `savedFilters` ~:1214-1232; `papers.zoteroItemKey` + index ~:1091-1147; two new `events` variants beside `slack.delivery_changed` ~:357-361)
- Rename: `convex/slack.guard.test.ts` → `convex/credentials.guard.test.ts` (`git mv`)
- Modify: `convex/credentials.guard.test.ts` (generalize the name pattern and the three assertions that name what it covers)

**Interfaces:**
- Produces, for every later task: the `zoteroLinks` table shape, the `papers.zoteroItemKey` field and its `by_lab_and_zotero_item` index, and the `zotero.link_changed` / `zotero.synced` event variants. Task 3 writes the row, Task 4 advances the cursor, Task 5 reads the status off it.
- No runtime code ships in this task. It ends with a green suite and no feature.

**Why the guard is generalized rather than duplicated.** `WEBHOOK_ISH = /webhook|hook|slack|deliver|destination|endpoint|channel|post/i` (`convex/slack.guard.test.ts:209-210`) matches none of `apiKey`, `zoteroApiKey`, `accessToken`. The existing guard therefore gives a Zotero key **zero** protection and would pass green with the key sitting in a public query's returns. A second file on the same skeleton would be a second place for the rule to drift — which is the argument the file itself makes at `:521-531`. So the pattern widens, the file takes the name of what it now guards, and the two assertions that enumerate what it covers are updated deliberately, in this commit, with the reason.

**The one word not in the pattern.** Bare `key` is excluded on purpose: `papers.zoteroItemKey`, `zoteroLinks.collectionKey` and the `key` on brief/synthesis sections (`convex/schema.ts:1797`, `:1852`) are opaque public identifiers, not secrets, and a pattern that flagged them would either be relaxed by the next person or would force a rename that made the schema worse. `apikey` matches `apiKey` and does not match `zoteroItemKey`. Likewise bare `zotero` is excluded — it *would* match `zoteroItemKey`.

- [ ] **Step 1: Rename the guard, so the failing test lands in the file that will own it**

```bash
git mv convex/slack.guard.test.ts convex/credentials.guard.test.ts
```

Then rewrite the file header (`:18-50`) so it says what it now guards. Replace the opening line and the promises list; keep the closing sentence verbatim:

```ts
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
```

- [ ] **Step 2: Widen the pattern and its self-check**

Replace `WEBHOOK_ISH` (`:195-210`), `PLAUSIBLE_NAMES` (`:212-230`) and the helper `webhookShaped` (`:119-128`) with:

```ts
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
  /webhook|hook|slack|deliver|destination|endpoint|channel|post|apikey|token|secret|credential/i;

/**
 * The pattern, held to the names it claims to cover.
 *
 * A regex is the kind of thing that quietly stops matching what its comment
 * says it matches — which is precisely how the first version of it shipped.
 * This list is the review's own; `channel`/`post` are here because two of the
 * names on it still walked past the widened pattern until they were added,
 * and the last four are here because a Zotero key is a credential this file
 * did not cover at all until it was told to.
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
  "accessToken",
  "clientSecret",
] as const;

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
```

Rename every call site of `webhookShaped` to `credentialShaped` (`:381-382`, `:395`, `:419`, `:433-434`, `:450`).

- [ ] **Step 3: Update the three assertions that enumerate what is covered**

In `"recognises every name a webhook would plausibly be given"` (`:369-378`), rename the test to `"recognises every name a credential would plausibly be given"`, swap `WEBHOOK_ISH` → `CREDENTIAL_ISH`, and extend the negative check so the widening is proved not to have swallowed the schema:

```ts
    // And it is not simply matching everything, which would pass the line
    // above while flagging half the schema. The last three are the names this
    // widening came closest to eating: opaque identifiers, not secrets.
    expect(
      ["title", "createdAt", "body", "quote", "zoteroItemKey", "collectionKey", "libraryId"]
        .filter((n) => CREDENTIAL_ISH.test(n)),
    ).toEqual([]);
```

In `"does put it in the internal queries that need it, so the check is real"` (`:391-404`), rename to `"does put them in the internal queries that need them, so the check is real"` and extend the expectation — Task 3 creates `zotero.syncPayload`, so this assertion is what forces it to be the *only* Zotero function carrying the key:

```ts
    expect(internalWithCredential).toEqual([
      "slack.boundaryPayload",
      "slack.briefPayload",
      "slack.synthesisPayload",
      "zotero.syncPayload",
    ]);
```

> Until Task 3 lands, `zotero.syncPayload` does not exist and this assertion fails. That is correct and intended — it is the one assertion in this file that is red between tasks. Mark it `it.skip` at the end of Step 3 with the comment below, and Task 3's first step is to un-skip it.
>
> ```ts
>   // Un-skipped by B5 Task 3, which creates `zotero.syncPayload`. Skipped and
>   // not deleted so that the inverse check — the one that proves this whole
>   // walk is not blind — cannot be forgotten on the way.
>   it.skip("does put them in the internal queries that need them, so the check is real", () => {
> ```

In `"lives on labs, and only on labs"` (`:432-443`), rewrite:

```ts
  it("lives on the two tables that hold a credential, and no others", () => {
    const holders = tables.flatMap(([table, validator]) =>
      credentialShaped(validator).length > 0 ? [table] : [],
    );
    // Anchored in both directions: they are here, and nothing else is. A
    // third holder would be a third lifetime to reason about and a third read
    // path to forget to gate. `labs` carries the lab's Slack webhook;
    // `zoteroLinks` carries one member's own read key, which is why it is not
    // on `labs` beside the other one — a shared key would let any member read
    // the PI's entire personal library.
    expect(holders).toEqual(["labs", "zoteroLinks"]);
    expect(fieldPaths(wireForm(schema.tables.labs.validator))).toContain(
      "slackWebhookUrl",
    );
    expect(fieldPaths(wireForm(schema.tables.zoteroLinks.validator))).toContain(
      "apiKey",
    );
  });
```

(The order `["labs", "zoteroLinks"]` is `Object.entries(schema.tables)` order, i.e. declaration order: `labs` at `convex/schema.ts:957`, `zoteroLinks` inserted after `savedFilters` at `:1214`.)

- [ ] **Step 4: Add the new assertions this task is actually for**

Append a describe block at the end of the "where the credential is stored" section (after `:488`):

```ts
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
    const changed = eventVariant("zotero.link_changed");
    expect(Object.keys(changed).sort()).toEqual([
      "actorId",
      "at",
      "connected",
      "labId",
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
```

`indexNames` is a new accessor; put it beside `wireForm` (`:149-157`), which makes the same bargain for the same reason:

```ts
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
```
```

- [ ] **Step 5: Run it, and watch it fail for the right reason**

Run: `npx vitest run convex/credentials.guard.test.ts`
Expected: FAIL — `schema.tables.zoteroLinks` is `undefined`, and `eventVariant("zotero.link_changed")` throws `No \`zotero.link_changed\` variant in the events validator`.

- [ ] **Step 6: Add the two event variants**

In `convex/schema.ts`, immediately after the `slack.delivery_failed` variant (which ends around `:375`), add:

```ts
  /**
   * A member linked their own Zotero library to this lab, or unlinked it.
   *
   * The lab's counterpart to `slack.delivery_changed`, and filed for the same
   * reason: papers arriving on the shelf from somewhere outside Margin is a
   * collective fact, and the record should say when that started and whose
   * decision it was. `actorId` is the member themselves — this is the one
   * integration nobody can turn on for anybody else.
   *
   * The key is not carried, and could not be. It is a bearer credential that
   * reads a person's whole personal library, and `events` rows are never
   * deleted, so a copy here would outlive every disconnection. `connected`
   * says which way the switch moved, which is the whole fact.
   */
  v.object({
    ...eventBase,
    type: v.literal("zotero.link_changed"),
    connected: v.boolean(),
  }),
  /**
   * A sync run put papers on the shelf.
   *
   * Counts, never content — not a title, not an item key, not the name of the
   * library they came from. What the ledger is for here is the answer to "why
   * are there forty papers I didn't add", and a number plus an actor answers
   * it; the papers themselves each file their own `paper.added` with the
   * member as actor, which is where the titles live.
   *
   * **Only filed when `imported > 0`.** The hourly sweep asks every linked
   * library whether anything changed, and for most members on most hours the
   * answer is no. A row per poll would be an append-only table growing at
   * one row per member per hour to record that nothing happened, which is not
   * a fact about the lab — it is a fact about the scheduler.
   */
  v.object({
    ...eventBase,
    type: v.literal("zotero.synced"),
    /** Papers newly on the shelf. */
    imported: v.number(),
    /** Items this run recognised as already here. */
    skipped: v.number(),
  }),
```

- [ ] **Step 7: Add `papers.zoteroItemKey` and its index**

In the `papers` table (`convex/schema.ts:1091-1147`), after `tags` and before the closing `})`:

```ts
    /**
     * Which Zotero item this paper came from, for the member who synced it.
     *
     * The identity dedupe key, and the only way a *metadata edit* in Zotero
     * can find the row it should patch rather than inserting a near-duplicate:
     * a member fixing a typo'd title upstream would otherwise get a second
     * paper in Margin, with the lab's annotations still on the first one.
     *
     * Opaque and not a secret — it names an item in a library, the way a DOI
     * names a paper, and it is safe to hold beside one. It is deliberately
     * *not* qualified by which library it came from: two members syncing the
     * same paper from two different Zotero libraries produce two different
     * item keys, and the DOI and title-identity passes below are what collapse
     * those into one row. Collisions across libraries are not a concern —
     * Zotero item keys are eight random base-32 characters.
     */
    zoteroItemKey: v.optional(v.string()),
```

And beside `.index("by_lab_and_doi", ["labId", "doi"])`:

```ts
    /**
     * "Have I already imported this Zotero item into this lab?" — asked once
     * per candidate on every sync run. Without it the question is a read of
     * the lab's whole library per item, which is the shape
     * `createFromMetadata` has and the one a sync run at 25 items a go cannot
     * afford to inherit.
     */
    .index("by_lab_and_zotero_item", ["labId", "zoteroItemKey"])
```

- [ ] **Step 8: Add the `zoteroLinks` table**

In `convex/schema.ts`, immediately after `savedFilters` (which closes around `:1232`) and before `sessions`:

```ts
  /**
   * One member's Zotero library, wired to one lab. Read-only, one direction.
   *
   * ## Why this is per-member and the Slack webhook is per-lab
   *
   * `labs.slackWebhookUrl` is the lab's, because a channel is the lab's and a
   * PI deciding the lab posts to it is a decision about the lab. A Zotero
   * personal library is one person's, and it is a *reading history* — which
   * of the two things `convex/privacy.guard.test.ts` exists to keep Margin
   * out of. A single lab-wide key would let any member read the PI's entire
   * library, so the key is keyed `(userId, labId)` and nobody can see or
   * manage anybody else's. `savedFilters` above is the schema precedent for
   * exactly that shape, and for the same reason: some things in a lab are one
   * person's working life rather than lab property.
   *
   * The *destination* is still the lab. Papers land on the lab's shelf, file
   * a `paper.added` with this member as actor, and stay there when the link
   * goes — exactly as a `.bib` paste does today. Unlinking removes the way in,
   * not the papers, and the confirm copy says so.
   *
   * ## One library, one counter
   *
   * One row is one library. Two would be two version counters, two rate-limit
   * budgets, and a settings row that can be half-broken — and there is no
   * question a second library answers that a group library does not.
   */
  zoteroLinks: defineTable({
    userId: v.id("users"),
    labId: v.id("labs"),
    /**
     * The member's Zotero API key. A bearer credential, held under the same
     * constitution as `labs.slackWebhookUrl` and one clause stricter.
     *
     * It never leaves the server. `convex/zotero.ts` holds the only reads, and
     * the only function that hands it anywhere is `zotero.syncPayload`, an
     * `internalQuery` — no public function returns it, not even to the member
     * who pasted it, because a key in a query result is a key in the browser's
     * cache and in every dev tools pane that cache is ever opened in.
     * `convex/credentials.guard.test.ts` asserts that structurally, by walking
     * every returns validator in the codebase rather than by trusting this
     * paragraph.
     *
     * The stricter clause is about redirects. Zotero answers a file download
     * with a `302` to a presigned Amazon URL, and `fetch` following a redirect
     * strips `Authorization` but **not** a custom `Zotero-API-Key` header — so
     * the obvious spelling of a download hands a member's key to a third-party
     * host. Every request this module makes therefore sets
     * `redirect: "manual"`, and the second hop is re-issued with no credential
     * on it at all.
     *
     * Margin asks for a **read-only** key and verifies it: `GET /keys/current`
     * reports the key's scopes and a write-scoped one is refused at connect
     * time, in front of the person pasting it. The worst case of a breach is
     * then disclosure of what somebody reads, not the destruction of a
     * fifteen-year bibliography.
     *
     * Absent is impossible — the row is deleted rather than blanked, so
     * "linked" and "not linked" have one representation between them.
     */
    apiKey: v.string(),
    /**
     * When the key above was pasted — the credential's non-secret identity.
     *
     * The `labs.slackConnectedAt` role, for the same reason and against the
     * same race. A sync outcome is written by a mutation the action scheduled,
     * and nothing orders that against a member in the settings page: a failure
     * from a key replaced two seconds ago would otherwise have the row
     * reporting a dead key against a live one. This is what travels with a run
     * instead of the key. It is safe to hand around precisely because it is
     * not the secret — it says *which* key, never what it was.
     */
    connectedAt: v.number(),
    /**
     * Which library. `"user"` carries the member's Zotero userID, `"group"` a
     * groupID; together with the type it builds the `/users/<id>` or
     * `/groups/<id>` prefix every request hangs off.
     *
     * A string rather than a number because it is an opaque path segment as
     * far as Margin is concerned, and parsing it into an integer only to
     * print it back would be an opportunity to be wrong about a library
     * nobody can then reach.
     */
    libraryType: v.union(v.literal("user"), v.literal("group")),
    libraryId: v.string(),
    /**
     * The library's display name, for the settings row. Display only, never
     * matched on: a member who renames a group library in Zotero has not
     * changed which library this is, and code that believed otherwise would
     * silently start syncing nothing.
     */
    libraryName: v.optional(v.string()),
    /**
     * One Zotero collection, when the member picked one. This is the cap.
     *
     * `listPapers` reads the lab's library under one bounded `take(200)` and
     * says so at `papers.tags` above. A real Zotero library is 1,000–10,000
     * items, so syncing a whole one detonates the library page on its first
     * run — the shelf would hold papers the shelf cannot list. Scoping to one
     * collection is what makes the first version honest rather than
     * impressive, and the connect copy says why in those words.
     *
     * Absent means the whole library, which is allowed for the member who
     * genuinely keeps a small one. The per-run cap and the progress line hold
     * either way.
     */
    collectionKey: v.optional(v.string()),
    /** The collection's display name, for the settings row. Display only. */
    collectionName: v.optional(v.string()),
    /**
     * Zotero's `Last-Modified-Version` as of the last **completed** walk.
     * Absent means this library has never been fully walked.
     *
     * The whole incremental story is this number. `?since=<lastVersion>`
     * returns only what changed after it, and `If-Modified-Since-Version:
     * <lastVersion>` gets a bare `304` when nothing has — which is what makes
     * the hourly sweep cost one small request per link per hour instead of a
     * library walk.
     *
     * It advances only when a walk finishes, and it advances to the version
     * the walk *started* at rather than to whatever the library says now. A
     * walk spans several runs, and anything edited during it has a version
     * above that mark, so the next walk sees it again. The cost is re-reading
     * a handful of items; the alternative is silently losing an edit that
     * happened while Margin was three pages into the previous walk.
     */
    lastVersion: v.optional(v.number()),
    /**
     * Where the walk in progress has got to, or absent when there is none.
     *
     * This field is the bounded-sync guarantee made durable. Every run — a
     * member pressing Sync now, or the hourly sweep — imports at most
     * `SYNC_PAGE_ITEMS` items and writes back where it stopped, so no single
     * run is unbounded however large the library is, and a member who links a
     * 4,000-item collection gets a shelf that fills over the afternoon instead
     * of an action the platform kills halfway through.
     *
     * `targetVersion` pins the walk: it is the library version the walk began
     * at, held fixed across every continuation so the `?since=` window does
     * not move under the offset. `start` is the Zotero `start` offset of the
     * next page. `total` is `Total-Results` from the first page — approximate
     * by the time the last page is fetched, and shown to members with an
     * "about" in front of it for exactly that reason. `imported` counts the
     * papers this walk has actually added, which is not the same as `start`:
     * `start` counts items looked at, and most of them on a re-walk are
     * already here.
     */
    syncCursor: v.optional(
      v.object({
        targetVersion: v.number(),
        start: v.number(),
        total: v.number(),
        imported: v.number(),
      }),
    ),
    /**
     * When a run last finished, whatever it found. Drives the sweep's `by_due`
     * ordering and the "last checked" line in settings.
     *
     * Named for the sync and not for the member: this records that Margin
     * asked Zotero a question, not that anybody read anything. The privacy
     * guard's field patterns (`convex/privacy.guard.test.ts:169-193`) forbid
     * `lastReadAt` and its family, and rightly — this is the other thing.
     */
    lastSyncAt: v.optional(v.number()),
    /**
     * How the most recent run went. The `labs.slackLastDelivery` role.
     *
     * A key can die without anybody touching this row — revoked at
     * zotero.org, or a group the member left — and Zotero then answers `403`
     * forever while the settings row still says "linked", because it is. This
     * is what lets the row say the true thing instead.
     *
     * `statusCode` present means refused, absent means it worked.
     * `connectedAt` says which key did the asking, so an outcome naming a key
     * the member has since replaced is recognised and dropped. A derived,
     * self-healing summary of facts the ledger holds permanently — not a
     * second source of truth — so that reading it costs one document get on a
     * page every member loads.
     */
    lastSync: v.optional(
      v.object({
        at: v.number(),
        connectedAt: v.number(),
        statusCode: v.optional(v.number()),
        imported: v.number(),
        skipped: v.number(),
      }),
    ),
  })
    .index("by_user_and_lab", ["userId", "labId"])
    /** Every link in a lab — for the lab-wide reads a future digest might want. */
    .index("by_lab", ["labId"])
    /**
     * The hourly sweep's index. A cron that found its work by scanning this
     * table would be a full-table scan on a schedule, which is the argument
     * `papers.by_pdf_storage` makes for itself and the same answer.
     *
     * Ordered by `lastSyncAt` ascending, so the sweep takes the most overdue
     * links first and a library that is mid-walk keeps its place in the queue.
     * A row that has never synced sorts first, because Convex orders an absent
     * indexed field before every present one — which is the behaviour wanted:
     * a member who linked their library thirty seconds ago should be first.
     */
    .index("by_due", ["lastSyncAt"]),
```

- [ ] **Step 9: Run the guard, then the whole suite**

Run: `npx vitest run convex/credentials.guard.test.ts`
Expected: PASS, with one skipped test (`does put them in the internal queries that need them`).

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS. `convex/privacy.guard.test.ts` must stay green — `zoteroLinks` matches none of its forbidden table patterns and `lastSyncAt`/`lastVersion`/`connectedAt` match none of its forbidden field patterns. If `privacy.guard.test.ts` fails, stop and report: it means a name in the new table reads as attention-tracking and must be renamed, not the guard relaxed.

- [ ] **Step 10: Commit**

```bash
git add convex/schema.ts convex/credentials.guard.test.ts
git commit -m "$(cat <<'EOF'
Zotero: a table for the key, and one guard for both credentials

The Slack guard's name pattern matched no spelling of an API key, so it
would have gone green with a Zotero bearer token sitting in a public
query's returns. Widened, renamed for what it now covers, and taught the
two tables that are allowed to hold a credential.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `lib/zotero/` — the whole client, as pure functions

**Files:**
- Create: `lib/zotero/api.ts` (addresses, key shape, item-type filter, permission parsing, response headers, the redirect rule)
- Create: `lib/zotero/items.ts` (Zotero item → `ReferenceEntry`, DOI out of `extra`, creators → authors, attachment selection)
- Test: `lib/zotero/api.test.ts`
- Test: `lib/zotero/items.test.ts`

**Interfaces:**
- Consumes: `cleanReferenceText`, `normalizeAuthor`, `readYear` from `lib/reference-import/normalize.ts` (`:2`, `:20`, `:69`) and the `ReferenceEntry` type from `lib/reference-import/types.ts:4`. Reused rather than restated so a paper imported from a `.bib` last month and synced from Zotero today produce the same title, the same author spelling and the same `referenceIdentity`.
- Produces, consumed by Tasks 3–5:
  - `ZOTERO_API_ORIGIN: string`, `ZOTERO_API_VERSION: "3"`, `SCHOLARLY_ITEM_TYPES: readonly string[]`
  - `normalizeApiKey(raw: string): string | null`
  - `type ZoteroLibrary = { type: "user" | "group"; id: string }`
  - `libraryPrefix(library: ZoteroLibrary): string`
  - `keysCurrentUrl(): string`
  - `groupsUrl(userId: string): string`
  - `collectionsUrl(library: ZoteroLibrary): string`
  - `itemsUrl(o: { library: ZoteroLibrary; collectionKey?: string; since?: number; start: number; limit: number }): string`
  - `childrenUrl(library: ZoteroLibrary, itemKey: string): string`
  - `fileUrl(library: ZoteroLibrary, attachmentKey: string): string`
  - `type KeyPermissions = { userId: string; readOnly: boolean }`; `parseKeyPermissions(body: unknown): KeyPermissions | null`
  - `type ZoteroGroup = { id: string; name: string }`; `parseGroups(body: unknown): ZoteroGroup[]`
  - `type ZoteroCollection = { key: string; name: string }`; `parseCollections(body: unknown): ZoteroCollection[]`
  - `type SyncHeaders = { lastModifiedVersion: number | null; totalResults: number | null; backoffMs: number | null }`; `readSyncHeaders(headers: Headers): SyncHeaders`
  - `MAX_BACKOFF_MS: number`
  - `type ZoteroItem`, `type ZoteroReference = ReferenceEntry & { zoteroItemKey: string }`, `toReference(item: ZoteroItem): ZoteroReference | null`
  - `doiFromExtra(extra: string | undefined): string | undefined`
  - `type ZoteroAttachment`, `pickPdfAttachment(children: readonly ZoteroAttachment[]): ZoteroAttachment | null`

**Design settled here, so no later task re-litigates it:**

- **The key is a header, never a query parameter.** Zotero accepts `?key=`, and its own docs say not to. A credential in a query string is a credential in every access log on the path, in the `Link` headers the API echoes back, and in any error a URL gets interpolated into. So `itemsUrl` and friends build a URL with no credential in it at all, and a test asserts that directly — a URL builder that *could* take the key is a URL builder somebody will pass it to.
- **`sort=dateAdded&direction=asc`, on every item page.** The walk is offset-paginated (`start`/`limit`), and offset pagination over a set that is being reordered underneath you skips rows. Sorting by date added ascending is the one ordering a growing library does not disturb: new items append to the end of the window rather than shifting it.
- **`/items/top`, not `/items`.** The `top` variants exclude child attachments and notes, which are the bulk of a real library and none of them papers.
- **A WebDAV attachment is recognised before it is downloaded.** An attachment whose file Zotero itself stores carries an `md5` in its item data; one a member syncs through their own WebDAV does not, and `api.zotero.org` has nothing to serve for it. `pickPdfAttachment` refuses those, so the paper lands `needs-pdf` honestly instead of spending a request to be told nothing.

- [ ] **Step 1: Write the failing tests for `lib/zotero/api.ts`**

```ts
// lib/zotero/api.test.ts
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
```

- [ ] **Step 2: Run them** — `npx vitest run lib/zotero/api.test.ts` — FAIL, module missing.

- [ ] **Step 3: Implement `lib/zotero/api.ts`**

```ts
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

import {
  cleanReferenceText,
} from "../reference-import/normalize";

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

export function libraryPrefix(library: ZoteroLibrary): string {
  return library.type === "user"
    ? `/users/${library.id}`
    : `/groups/${library.id}`;
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
  const url = apiUrl(`/users/${userId}/groups`);
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
      : `${prefix}/collections/${options.collectionKey}/items/top`;
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
export function childrenUrl(
  library: ZoteroLibrary,
  itemKey: string,
): string {
  const url = apiUrl(`${libraryPrefix(library)}/items/${itemKey}/children`);
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
    `${libraryPrefix(library)}/items/${attachmentKey}/file`,
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
 */
export type KeyPermissions = { userId: string; readOnly: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canWrite(scope: unknown): boolean {
  return isRecord(scope) && scope.write === true;
}

export function parseKeyPermissions(body: unknown): KeyPermissions | null {
  if (!isRecord(body)) return null;
  const userId = body.userID;
  if (typeof userId !== "number" || !Number.isInteger(userId)) return null;

  const access = isRecord(body.access) ? body.access : {};
  const groups = isRecord(access.groups) ? Object.values(access.groups) : [];
  const writes = canWrite(access.user) || groups.some(canWrite);

  return { userId: String(userId), readOnly: !writes };
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
  const backoffMs =
    backoffSeconds === null ? null : backoffSeconds * 1000;
  return {
    lastModifiedVersion: readInt(headers.get("last-modified-version")),
    totalResults: readInt(headers.get("total-results")),
    backoffMs:
      backoffMs === null || backoffMs > MAX_BACKOFF_MS ? null : backoffMs,
  };
}
```

- [ ] **Step 4: Run them** — `npx vitest run lib/zotero/api.test.ts` — PASS.

- [ ] **Step 5: Write the failing tests for `lib/zotero/items.ts`**

```ts
// lib/zotero/items.test.ts
import { describe, expect, it } from "vitest";
import { referenceIdentity } from "../reference-import/normalize";
import { doiFromExtra, pickPdfAttachment, toReference } from "./items";
import type { ZoteroAttachment, ZoteroItem } from "./items";

/** A journal article as `/items/top` actually returns one. */
const article: ZoteroItem = {
  key: "ABCD2345",
  version: 8412,
  data: {
    key: "ABCD2345",
    itemType: "journalArticle",
    title: "Cold-chain   effects on\nassay reproducibility",
    creators: [
      { creatorType: "author", firstName: "Ana", lastName: "Ruiz" },
      { creatorType: "author", firstName: "Ben", lastName: "Okafor" },
      { creatorType: "editor", firstName: "Cara", lastName: "Silva" },
    ],
    abstractNote: "  We find that a 4 °C step explains the gap.  ",
    publicationTitle: "Journal of Reproducible Assays",
    date: "2024-03-15",
    DOI: "10.1038/nature12373",
    url: "https://example.org/paper",
  },
};

describe("toReference", () => {
  it("produces the same shape a .bib import produces", () => {
    const entry = toReference(article);
    expect(entry).toEqual({
      zoteroItemKey: "ABCD2345",
      title: "Cold-chain effects on assay reproducibility",
      authors: ["Ana Ruiz", "Ben Okafor"],
      year: 2024,
      venue: "Journal of Reproducible Assays",
      doi: "10.1038/nature12373",
      abstract: "We find that a 4 °C step explains the gap.",
      url: "https://example.org/paper",
    });
  });

  it("collapses to the same identity a .bib import would produce", () => {
    // The reason `normalize.ts` is imported rather than restated: a paper
    // pasted from a citation export last month and synced from Zotero today
    // has to land on one row, and `referenceIdentity` is what decides that.
    const entry = toReference(article);
    expect(referenceIdentity(entry?.title ?? "", entry?.year)).toBe(
      referenceIdentity("Cold-chain effects on assay reproducibility", 2024),
    );
  });

  it("keeps only authors when there are any, and everyone when there are not", () => {
    // An edited volume has editors and no authors. Dropping the editors would
    // leave the row with nobody's name on it, which is worse than the wrong
    // kind of name.
    const edited = {
      ...article,
      data: {
        ...article.data,
        creators: [{ creatorType: "editor", firstName: "Cara", lastName: "Silva" }],
      },
    };
    expect(toReference(edited)?.authors).toEqual(["Cara Silva"]);
  });

  it("takes a one-field creator as the whole name", () => {
    // Zotero stores institutional authors as a single `name`.
    const institutional = {
      ...article,
      data: {
        ...article.data,
        creators: [{ creatorType: "author", name: "The GTEx Consortium" }],
      },
    };
    expect(toReference(institutional)?.authors).toEqual(["The GTEx Consortium"]);
  });

  it("sniffs a year out of Zotero's free-text date field", () => {
    // `date` is not a date. Zotero stores what the user typed.
    for (const date of ["2024-03-15", "March 2024", "2024", "15/03/2024"]) {
      expect(toReference({ ...article, data: { ...article.data, date } })?.year).toBe(2024);
    }
    expect(toReference({ ...article, data: { ...article.data, date: "in press" } })?.year).toBeUndefined();
  });

  it("finds the DOI a preprint hides in its extra field", () => {
    // `preprint` and `conferencePaper` have no `DOI` field of their own, so
    // Zotero's convention is a `DOI:` line in `extra` — and that DOI is what
    // makes the difference between an indexed dedupe and a title guess.
    const preprint: ZoteroItem = {
      key: "WXYZ8901",
      version: 8413,
      data: {
        key: "WXYZ8901",
        itemType: "preprint",
        title: "Attention is all you need",
        creators: [{ creatorType: "author", firstName: "Ada", lastName: "Vaswani" }],
        date: "2017",
        extra: "arXiv:1706.03762\nDOI: 10.48550/arXiv.1706.03762\nciting: 100000",
      },
    };
    expect(toReference(preprint)?.doi).toBe("10.48550/arXiv.1706.03762");
  });

  it("takes the proceedings title as the venue for a conference paper", () => {
    const paper = {
      ...article,
      data: {
        ...article.data,
        itemType: "conferencePaper",
        publicationTitle: undefined,
        proceedingsTitle: "NeurIPS 2017",
      },
    };
    expect(toReference(paper)?.venue).toBe("NeurIPS 2017");
  });

  it("refuses an item with no title, which is not a paper", () => {
    const untitled = { ...article, data: { ...article.data, title: "   " } };
    expect(toReference(untitled)).toBeNull();
  });

  it("refuses an item type a journal club does not read", () => {
    // The server-side `itemType` filter should mean this never arrives. It is
    // checked again here because "should" is not a guarantee about somebody
    // else's API, and a web page on the lab's shelf is a bug that looks like a
    // feature nobody asked for.
    const page = { ...article, data: { ...article.data, itemType: "webpage" } };
    expect(toReference(page)).toBeNull();
  });

  it("leaves out the fields Zotero left empty", () => {
    const bare: ZoteroItem = {
      key: "BARE0001",
      version: 1,
      data: { key: "BARE0001", itemType: "journalArticle", title: "A title" },
    };
    expect(toReference(bare)).toEqual({
      zoteroItemKey: "BARE0001",
      title: "A title",
      authors: [],
    });
  });
});

describe("doiFromExtra", () => {
  it("reads a DOI: line whatever its case and spacing", () => {
    expect(doiFromExtra("doi:10.1000/xyz")).toBe("10.1000/xyz");
    expect(doiFromExtra("Citation Key: x\nDOI:   10.1000/xyz")).toBe("10.1000/xyz");
  });

  it("says nothing when there is no DOI line", () => {
    expect(doiFromExtra("arXiv:1706.03762")).toBeUndefined();
    expect(doiFromExtra(undefined)).toBeUndefined();
    expect(doiFromExtra("")).toBeUndefined();
  });
});

describe("pickPdfAttachment", () => {
  const stored: ZoteroAttachment = {
    key: "PDF00001",
    data: {
      key: "PDF00001",
      itemType: "attachment",
      linkMode: "imported_url",
      contentType: "application/pdf",
      filename: "ruiz-2024.pdf",
      md5: "9f86d081884c7d659a2feaa0c55ad015",
    },
  };

  it("takes a PDF Zotero itself is storing", () => {
    expect(pickPdfAttachment([stored])?.key).toBe("PDF00001");
  });

  it("passes over a link, which has no bytes behind it", () => {
    // `linked_file` points at a path on one person's laptop and `linked_url`
    // at a page. Neither is a file `api.zotero.org` can serve.
    const linked = { ...stored, data: { ...stored.data, linkMode: "linked_file" } };
    const url = { ...stored, data: { ...stored.data, linkMode: "linked_url" } };
    expect(pickPdfAttachment([linked, url])).toBeNull();
  });

  it("passes over an attachment that is not a PDF", () => {
    const snapshot = {
      ...stored,
      data: { ...stored.data, contentType: "text/html", filename: "page.html" },
    };
    expect(pickPdfAttachment([snapshot])).toBeNull();
  });

  it("passes over a WebDAV-stored file before spending a request on it", () => {
    // A file the member syncs through their own WebDAV is not on Zotero's
    // servers, and `/file` has nothing to answer with. The absent `md5` is the
    // signal, and reading it here means the paper lands `needs-pdf` honestly
    // instead of costing a download that was always going to fail.
    const webdav = { ...stored, data: { ...stored.data, md5: undefined } };
    expect(pickPdfAttachment([webdav])).toBeNull();
  });

  it("takes the first storable PDF when an item has several attachments", () => {
    // The common shape: a snapshot, a supplement, and the paper.
    const snapshot = {
      ...stored,
      key: "SNAP0001",
      data: { ...stored.data, key: "SNAP0001", contentType: "text/html" },
    };
    const second = { ...stored, key: "PDF00002", data: { ...stored.data, key: "PDF00002" } };
    expect(pickPdfAttachment([snapshot, stored, second])?.key).toBe("PDF00001");
  });

  it("takes nothing from an item with no children at all", () => {
    expect(pickPdfAttachment([])).toBeNull();
  });
});
```

- [ ] **Step 6: Run them** — `npx vitest run lib/zotero/items.test.ts` — FAIL, module missing.

- [ ] **Step 7: Implement `lib/zotero/items.ts`**

```ts
/**
 * A Zotero item, read as the thing Margin already knows how to put on a shelf.
 *
 * The output is `ReferenceEntry` — the exact shape `lib/reference-import/`
 * produces from a `.bib` or a `.ris` (`lib/reference-import/types.ts:4`) —
 * plus the Zotero item key, which is the identity that lets a later edit
 * upstream find the row it should patch.
 *
 * `cleanReferenceText`, `normalizeAuthor` and `readYear` are imported rather
 * than restated, and that is the whole design. A paper pasted from a citation
 * export last month and synced from Zotero today has to collapse onto one row,
 * and `referenceIdentity(title, year)` is what decides it — so the title has
 * to be cleaned by the same function and the year sniffed by the same one, or
 * the two paths produce two rows that a member can see are the same paper.
 */

import {
  cleanReferenceText,
  normalizeAuthor,
  readYear,
} from "../reference-import/normalize";
import type { ReferenceEntry } from "../reference-import/types";
import { SCHOLARLY_ITEM_TYPES } from "./api";

export type ZoteroCreator = {
  creatorType?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
};

export type ZoteroItem = {
  key: string;
  version: number;
  data: {
    key: string;
    itemType: string;
    title?: string;
    creators?: ZoteroCreator[];
    abstractNote?: string;
    /** `journalArticle`'s venue. */
    publicationTitle?: string;
    /** `conferencePaper`'s venue. */
    proceedingsTitle?: string;
    /** `bookSection`'s venue. */
    bookTitle?: string;
    /** Free text. Zotero stores what the member typed, not a date. */
    date?: string;
    /** Capitalised, and only on the item types that have the field. */
    DOI?: string;
    url?: string;
    /** Where a DOI hides on a preprint, among whatever else is in there. */
    extra?: string;
  };
};

export type ZoteroAttachment = {
  key: string;
  data: {
    key: string;
    itemType: string;
    linkMode?: string;
    contentType?: string;
    filename?: string;
    /** Present when Zotero is storing the file. Absent means WebDAV. */
    md5?: string;
  };
};

/** A Zotero item, in the shape every other import path in Margin speaks. */
export type ZoteroReference = ReferenceEntry & { zoteroItemKey: string };

const SCHOLARLY = new Set<string>(SCHOLARLY_ITEM_TYPES);

/**
 * The DOI a preprint keeps in `extra`.
 *
 * `preprint` and `conferencePaper` have no `DOI` field in Zotero's schema, and
 * the convention every reference manager has settled on is a `DOI:` line in
 * the free-text `extra` field alongside whatever else the member put there.
 * Worth reading, because a DOI is the difference between an indexed dedupe
 * against `by_lab_and_doi` and a guess made from a title.
 */
export function doiFromExtra(extra: string | undefined): string | undefined {
  const match = extra?.match(/^\s*DOI:\s*(\S+)\s*$/im);
  return match?.[1];
}

/** Authors if there are any, everybody named otherwise. */
function creatorNames(creators: ZoteroCreator[] | undefined): string[] {
  const all = creators ?? [];
  const authors = all.filter((creator) => creator.creatorType === "author");
  // An edited volume has editors and no authors. Dropping them would leave the
  // row with nobody's name on it, which is worse than the wrong kind of name.
  const chosen = authors.length > 0 ? authors : all;
  return chosen
    .map((creator) =>
      creator.name !== undefined
        ? // Institutional authors are one field, and `normalizeAuthor`'s
          // "Last, First" flip would mangle "Silva, Hospital of".
          cleanReferenceText(creator.name)
        : normalizeAuthor(
            [creator.lastName, creator.firstName]
              .filter((part) => part !== undefined && part.length > 0)
              .join(", "),
          ),
    )
    .filter((name) => name.length > 0);
}

function firstText(...candidates: (string | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const cleaned = cleanReferenceText(candidate);
    if (cleaned.length > 0) return cleaned;
  }
  return undefined;
}

/**
 * One Zotero item as a reference, or `null` if it is not one.
 *
 * The item-type check duplicates the `itemType` filter `itemsUrl` puts on the
 * request, deliberately. "The server filtered it" is a claim about somebody
 * else's API, and a web page arriving on a lab's shelf is a bug that looks
 * like a feature nobody asked for. A title check for the same reason: an item
 * with no title is not a paper, it is a stub somebody made and abandoned, and
 * `cleanTitle` in `convex/papers.ts:145` would throw on it at the door.
 */
export function toReference(item: ZoteroItem): ZoteroReference | null {
  const data = item.data;
  if (!SCHOLARLY.has(data.itemType)) return null;

  const title = firstText(data.title);
  if (title === undefined) return null;

  return {
    zoteroItemKey: item.key,
    title,
    authors: creatorNames(data.creators),
    year: readYear(data.date),
    venue: firstText(data.publicationTitle, data.proceedingsTitle, data.bookTitle),
    doi: firstText(data.DOI) ?? doiFromExtra(data.extra),
    abstract: firstText(data.abstractNote),
    url: firstText(data.url),
  };
}

/**
 * The one attachment worth downloading, or `null`.
 *
 * Three refusals, all of them made from the item's own metadata so that a
 * request is never spent finding out:
 *
 *   - **Link modes.** Only `imported_file` and `imported_url` have bytes
 *     behind them. `linked_file` points at a path on one person's laptop and
 *     `linked_url` at a page.
 *   - **Content type.** Zotero records it, so the PDF/not-PDF decision costs
 *     nothing here and a download otherwise.
 *   - **WebDAV.** A member who syncs their files through their own WebDAV has
 *     files Zotero's servers have never seen; `/file` fails or answers an
 *     `ETag` that matches nothing. The signal is a missing `md5` — present
 *     exactly when Zotero is holding the file — and reading it means the paper
 *     lands `needs-pdf` honestly instead of after a request that was always
 *     going to fail. Building a WebDAV client is explicitly out of scope.
 *
 * First match wins. An item with a snapshot, a supplement and the paper is the
 * common shape, and Zotero orders children with the primary attachment first
 * often enough that "first storable PDF" is the right guess — and when it is
 * wrong the cost is one supplementary PDF on the shelf instead of the paper,
 * which a member can replace with the dropzone that already exists.
 */
export function pickPdfAttachment(
  children: readonly ZoteroAttachment[],
): ZoteroAttachment | null {
  return (
    children.find(
      (child) =>
        child.data.itemType === "attachment" &&
        (child.data.linkMode === "imported_file" ||
          child.data.linkMode === "imported_url") &&
        child.data.contentType === "application/pdf" &&
        typeof child.data.md5 === "string" &&
        child.data.md5.length > 0,
    ) ?? null
  );
}
```

- [ ] **Step 8: Run the whole suite and typecheck** — `npx vitest run && npx tsc --noEmit && npx eslint lib/zotero` — PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/zotero
git commit -m "$(cat <<'EOF'
Zotero: the protocol, as functions with no network in them

Which URL, which item types, what a read-only key looks like, when to
back off, and which attachment has bytes behind it — all of it tested
against canned responses, so convex/zotero.ts is left holding a fetch and
a credential and nothing to be wrong about.

Titles and years go through lib/reference-import/normalize so a paper
pasted from a .bib and the same paper synced from Zotero land on one row.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `convex/zotero.ts` — the transport, connect, scope, disconnect, status

**Files:**
- Create: `convex/zotero.ts`
- Test: `convex/zotero.test.ts`
- Modify: `convex/credentials.guard.test.ts` (un-skip the inverse assertion from Task 1 Step 3; add the transport assertions)

**Interfaces:**
- Consumes: everything Task 2 produces from `lib/zotero/api`; `requireMembership`, `requireUserId`, `getMembership` from `convex/lib/authz.ts` (`:17`, `:28`, `:42`); `recordEvent` from `convex/lib/ledger.ts:29`; `pause` and `retryAfterMs` from `convex/auth.ts` (`:348`); the `zoteroLinks` table and `zotero.link_changed` event from Task 1.
- Produces, consumed by Tasks 4 and 5:
  - `class ZoteroRefusal extends Error { readonly status: number | null }`
  - `zoteroFetch(url: string, apiKey: string, options?: { ifModifiedSinceVersion?: number }): Promise<Response>`
  - `permanentStatus(caught: unknown): number | null`
  - `internal.zotero.syncPayload` — `internalQuery({ linkId })` returning the link **including `apiKey`**; the one function in the module that carries it
  - `internal.zotero.saveLink` — `internalMutation`
  - `api.zotero.connect` — `action({ labId, apiKey }) → null`
  - `api.zotero.listLibraries` — `action({ labId }) → { libraries: [{ type, id, name }] }`
  - `api.zotero.listCollections` — `action({ labId }) → { collections: [{ key, name }] }`
  - `api.zotero.chooseScope` — `mutation({ labId, libraryType, libraryId, libraryName, collectionKey?, collectionName? }) → null`
  - `api.zotero.disconnect` — `mutation({ labId }) → null`
  - `api.zotero.status` — `query({ labId })` returning the shape Task 5 renders
  - `linkFor(ctx, labId, userId)` — module-private helper reading `by_user_and_lab`

**Design settled here:**

- **Only a `429` is re-asked.** The same rule `postToSlack` follows (`convex/slack.ts:149-183`), reached by a different argument. Slack's reason is that a webhook has no idempotency key, so re-asking after an ambiguous answer risks a duplicate post. A `GET` has no such hazard — but it does not need the retry either, because **the cursor is the retry**. A run that ends on a `503` leaves `syncCursor` exactly where it was, and the sweep an hour later picks the walk up from that offset. Building a second recovery mechanism inside the run would be a second thing to get wrong for a case the first one already covers. So: `429` waits out its `Retry-After` and re-asks once; everything else raises `ZoteroRefusal` and ends the run.
- **`redirect: "manual"` on every credentialed request, without exception.** Not only on the file download. `fetch` strips `Authorization` across a cross-origin redirect and does **not** strip a custom `Zotero-API-Key` header, so any credentialed request that follows a redirect can hand a member's key to whatever answered `302`. Making it the transport's rule rather than one call site's means there is no second call site to forget.
- **`status` is a query and returns no key.** The credential is not in its validator, so `convex/credentials.guard.test.ts` will fail the day somebody adds it.
- **`disconnect` deletes the row.** Not a blanked field: "linked" and "not linked" then have one representation between them, and `linkFor` has one question to answer.

- [ ] **Step 1: Write the failing tests**

```ts
// convex/zotero.test.ts
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "./_generated/dataModel";
import { FakeCtx, handlerOf, seedLab } from "./delegations.fixtures";
import {
  ZoteroRefusal,
  chooseScope,
  connect,
  disconnect,
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
  return { ctx, seed };
}

/* --- the transport ---------------------------------------------------- */

describe("zoteroFetch", () => {
  it("presents the key as a header and never as a query parameter", async () => {
    const calls = stubFetch([{ status: 200, body: READ_ONLY_BODY }]);
    await zoteroFetch("https://api.zotero.org/keys/current", KEY);
    expect(calls[0]?.url).not.toContain(KEY);
    expect(keyOn(calls[0]?.init ?? {})).toBe(KEY);
    expect(new Headers(calls[0]?.init.headers).get("Zotero-API-Version")).toBe("3");
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
    const calls = stubFetch([
      { status: 429, headers: { "Retry-After": "1" } },
      { status: 200, body: [] },
    ]);
    const response = await zoteroFetch("https://api.zotero.org/keys/current", KEY);
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
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
    const caught = await zoteroFetch("https://api.zotero.org/keys/current", KEY).catch(
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(ZoteroRefusal);
    expect(String(caught)).not.toContain(KEY);
    expect((caught as ZoteroRefusal).status).toBe(403);
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
  const run = (ctx: FakeCtx, labId: Id<"labs">, apiKey: string) =>
    handlerOf(connect)(ctx, { labId, apiKey } as never);

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
        body: { ...READ_ONLY_BODY, access: { user: { library: true, write: true } } },
      },
    ]);
    await expect(run(ctx, seed.labId, KEY)).rejects.toBeInstanceOf(ConvexError);
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
    const caught = await run(ctx, seed.labId, KEY).catch((error: unknown) => error);
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
      lastSync: { at: 1, connectedAt: first?.connectedAt ?? 0, statusCode: 403, imported: 0, skipped: 0 },
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

    const events = ctx.db.all("events").filter((e) => e.type === "zotero.link_changed");
    expect(events).toHaveLength(1);
    expect(events[0]?.connected).toBe(true);
    expect(events[0]?.actorId).toBe(seed.pi);
    expect(JSON.stringify(events[0])).not.toContain(KEY);
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

  it("refuses when this member has no link to scope", async () => {
    const { ctx, seed } = await world();
    await expect(
      choose(ctx, { labId: seed.labId, libraryType: "user", libraryId: "475425" }),
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
    expect(ctx.db.all("events").filter((e) => e.type === "zotero.link_changed")).toHaveLength(0);
  });
});

describe("status", () => {
  const read = (ctx: FakeCtx, labId: Id<"labs">) =>
    handlerOf(status)(ctx, { labId } as never);

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
      lastSync: { at: 2_000, connectedAt: 1_000, statusCode: 403, imported: 0, skipped: 0 },
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
```

> `internalApi` in `world()` is `import { internal as internalApi } from "./_generated/api";` — add it to the imports. The registration exists so `connect`, which is an action, can reach `saveLink` through the same `internal.zotero.saveLink` reference the deployed code holds.

- [ ] **Step 2: Run them** — `npx vitest run convex/zotero.test.ts` — FAIL, module missing.

- [ ] **Step 3: Implement `convex/zotero.ts`**

```ts
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
  libraryPrefix,
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
 * `GET <prefix>/items/<key>/file` answers `302` to a presigned Amazon URL. The
 * WHATWG fetch spec strips `Authorization` on a cross-origin redirect and
 * strips *nothing else* — a custom `Zotero-API-Key` header rides along. So the
 * naive spelling of a download hands a member's key to a storage host, and the
 * only reason nobody notices is that it works. Every request this module makes
 * therefore carries `redirect: "manual"`, and the follow-up hop is re-issued
 * with no credential on it at all. That rule lives in `zoteroFetch` rather
 * than at the download site, because a rule at one call site has a second call
 * site coming.
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
    headers["If-Modified-Since-Version"] = String(options.ifModifiedSinceVersion);
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
 * Two refusals before anything is stored, both written for the person holding
 * a string they thought was right:
 *
 *   - The paste is not a key at all — most often the settings *URL*, because
 *     that is what the address bar holds when you are looking at the page the
 *     key is on. Refused without spending a request.
 *   - The key works but can write. Refused with the sentence that tells them
 *     which checkbox to clear, because a read-only key is the whole reason the
 *     worst case here is disclosure rather than destruction.
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
    const userId: Id<"users"> = await ctx.runQuery(
      internal.zotero.callerIn,
      { labId: args.labId },
    );

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
```

- [ ] **Step 4: Implement the three remaining public functions in the same file**

```ts
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
```

Plus the shared action-side helper, placed beside `linkFor`:

```ts
/**
 * The caller's link, credential and all, for an action that needs to fetch.
 *
 * Two round trips rather than one because an action has no database: the id
 * comes from a membership-checked query, and the payload from the one internal
 * query allowed to carry a key. Refuses with a sentence rather than a null so
 * that a picker opened against an unlinked lab says something.
 */
async function callerLink(
  ctx: { runQuery: (ref: unknown, args: unknown) => Promise<unknown> },
  labId: Id<"labs">,
) {
  const linkId = (await ctx.runQuery(internal.zotero.callerLinkId, {
    labId,
  })) as Id<"zoteroLinks"> | null;
  if (linkId === null) {
    throw new ConvexError(
      "There's no Zotero library linked here yet. Paste a key first.",
    );
  }
  const payload = (await ctx.runQuery(internal.zotero.syncPayload, {
    linkId,
  })) as {
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
```

- [ ] **Step 5: Run the module's tests** — `npx vitest run convex/zotero.test.ts` — PASS. Register `internal.zotero.callerIn`, `internal.zotero.callerLinkId` and `internal.zotero.syncPayload` on the `FakeCtx` in `world()` alongside `saveLink` if any test drives an action that reaches them.

- [ ] **Step 6: Un-skip the guard's inverse assertion and add the transport rules**

In `convex/credentials.guard.test.ts`, change `it.skip(...)` back to `it(...)` for `"does put them in the internal queries that need them, so the check is real"` and delete the "Un-skipped by Task 3" comment. Then extend section 3 (`"the modules that post to Slack"`, `:494-547`) — rename it `"the modules that hold a credential"` and append:

```ts
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
```

> The last assertion in the redirect test counts `fetch(` against `redirect: "manual"`. Task 4 adds the one uncredentialed second hop, which will break the count — Task 4's own step updates it to name that hop explicitly rather than relaxing the rule.

- [ ] **Step 7: Whole suite, typecheck, lint** — `npx vitest run && npx tsc --noEmit && npx eslint convex lib` — PASS.

- [ ] **Step 8: Commit**

```bash
git add convex/zotero.ts convex/zotero.test.ts convex/credentials.guard.test.ts
git commit -m "$(cat <<'EOF'
Zotero: connect, scope, unlink — and one transport that holds the key

The key is a header, never a query parameter; every credentialed request
sets redirect: manual, because fetch strips Authorization across a
cross-origin redirect and strips nothing else. connect refuses a
write-scoped key in front of the person pasting it.

status answers about the caller's own link and never carries the key; the
guard walks every returns validator to say so.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The bounded, resumable sync

**Files:**
- Modify: `convex/zotero.ts` (append the sync half)
- Modify: `convex/papers.ts` (export `pdfFromResponse` at ~:951, `cleanTitle` at ~:145, `cleanAuthors` at ~:153 — add `export` to the three declarations, change nothing else)
- Modify: `convex/delegations.fixtures.ts` (give `FakeCtx` a `storage`)
- Modify: `convex/credentials.guard.test.ts` (tighten the redirect assertion now that a second hop exists)
- Test: `convex/zotero.sync.test.ts`

**Interfaces:**
- Consumes: `zoteroFetch`, `ZoteroRefusal`, `permanentStatus`, `libraryOf`, `syncPayload` (Task 3); `itemsUrl`, `childrenUrl`, `fileUrl`, `readSyncHeaders` (Task 2); `toReference`, `pickPdfAttachment` (Task 2); `nextRedirectHop` from `convex/lib/scholarly.ts:137`; `referenceIdentity` from `lib/reference-import/normalize.ts:11`; `pdfFromResponse` / `cleanTitle` / `cleanAuthors` from `convex/papers.ts`.
- Produces, consumed by Task 5:
  - `SYNC_PAGE_ITEMS: 25`
  - `api.zotero.syncNow` — `action({ labId }) → { imported: number; skipped: number; done: boolean }`
  - `internal.zotero.syncLink` — `internalAction({ linkId })`
  - `internal.zotero.sweep` — `internalAction({})`, the cron's entry point
  - `internal.zotero.dueLinks` — `internalQuery`
  - `internal.zotero.newAmong` — `internalQuery`
  - `internal.zotero.commitPage` — `internalMutation`

**The bounded-sync contract, stated once and enforced by tests:**

1. **A run walks at most `SYNC_PAGE_ITEMS = 25` items.** Twenty-five because a run's real cost is not the item page — it is up to twenty-five `/children` requests and up to twenty-five PDF downloads, each capped at 60 MB, against an API that asks for no more than four concurrent requests. A hundred items a run (Zotero's page maximum) is a hundred downloads inside one action, which is how an action gets killed halfway through with a cursor that never advanced. Twenty-five is the number that keeps a run comfortably inside an action and a member's patience, and the cursor makes it the *rate* rather than the *ceiling*.
2. **The cursor is durable and the walk resumes.** `syncCursor` persists `{ targetVersion, start, total, imported }`; the next run — a member pressing Sync now, or the hourly sweep — continues from `start`.
3. **`lastVersion` advances only when a walk completes, and only to `targetVersion`** — the version the walk *began* at. Anything edited during a multi-run walk has a higher version and is seen by the next walk. The cost is re-reading a handful of items; the alternative is losing an edit made while Margin was three pages in.
4. **Dedupe is indexed, never a scan.** `zoteroItemKey` through `by_lab_and_zotero_item`, DOI through the existing `by_lab_and_doi`, and the `referenceIdentity` fallback against a map read **once per run** under the library's own `take(200)`. Nothing is `.collect()`ed per item, ever.
5. **A sweep with nothing to do costs one conditional request per link.** `If-Modified-Since-Version` → `304` → mark swept and stop.
6. **A key replaced mid-run invalidates the run's writes.** `connectedAt` travels with the run; `commitPage` refuses an outcome that names a credential the member no longer has, and deletes any blobs the run fetched under it.

- [ ] **Step 1: Give `FakeCtx` a storage, so an action that fetches a file is testable**

In `convex/delegations.fixtures.ts`, inside `class FakeCtx` after `scheduler` (~:338):

```ts
  /** Blobs the code under test stored, in order, and the ids it deleted. */
  readonly stored: Blob[] = [];
  readonly discarded: string[] = [];
  private storageCounter = 0;

  /**
   * `ctx.storage`, as far as anything under test needs it.
   *
   * Actions store fetched PDFs and mutations delete the ones that lost a
   * dedupe race, and both of those are invariants worth asserting: a blob
   * stored with nothing pointing at it is a file nobody will ever find again.
   * Recording rather than simulating, for the same reason the scheduler does.
   */
  readonly storage = {
    store: async (blob: Blob): Promise<Id<"_storage">> => {
      this.storageCounter += 1;
      this.stored.push(blob);
      return `storage_${this.storageCounter}` as Id<"_storage">;
    },
    delete: async (id: Id<"_storage">): Promise<void> => {
      this.discarded.push(id as string);
    },
    getUrl: async (): Promise<string | null> => null,
  };
```

- [ ] **Step 2: Export the three helpers `convex/papers.ts` already has**

Add `export` to `function cleanTitle` (~:145), `function cleanAuthors` (~:153) and `async function pdfFromResponse` (~:951). No other change to the file. Add one sentence to `pdfFromResponse`'s doc comment (`:940-950`), after "Shared by both fetch paths deliberately":

```
 * Three paths now: the DOI walk, the pasted link, and a Zotero attachment.
 * All three want the same answer to "is this a PDF we agreed to hold", and
 * the Zotero one needs the `%PDF-` fallback most of all — Zotero's storage
 * host answers `application/octet-stream` more often than not.
```

- [ ] **Step 3: Write the failing tests**

```ts
// convex/zotero.sync.test.ts
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
    const { ctx, linkId } = await linkedWorld({
      syncCursor: { targetVersion: 8431, start: 25, total: 60, imported: 25 },
    });
    const calls = stubFetch([
      page([item(100), item(101)], 60),
      noChildren,
      noChildren,
    ]);
    await run(ctx, linkId);

    expect(new URL(calls[0]?.url ?? "").searchParams.get("start")).toBe("25");
    expect(link(ctx)?.syncCursor?.start).toBe(27);
    expect(link(ctx)?.syncCursor?.imported).toBe(27);
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
    await ctx.db.insert("papers", {
      labId: seed.labId,
      title: "Added from a DOI months ago",
      doi: "10.1038/nature12373",
      addedBy: seed.pi,
      ingestStatus: "ready",
    });
    stubFetch([page([item(1, { DOI: "10.1038/nature12373" })], 1)]);
    await run(ctx, linkId);

    expect(papers(ctx)).toHaveLength(0);
    expect(ctx.db.lastReadOf("by_lab_and_doi")).toBeDefined();
  });

  it("recognises a DOI-less paper by the same identity a .bib import uses", async () => {
    // A paper pasted from a citation export last month and synced from Zotero
    // today is one paper. `referenceIdentity` is what decides that, and it is
    // the same function `createFromMetadata` uses.
    const { ctx, seed, linkId } = await linkedWorld();
    await ctx.db.insert("papers", {
      labId: seed.labId,
      title: "Paper number 3",
      year: 2024,
      addedBy: seed.pi,
      ingestStatus: "needs-pdf",
    });
    stubFetch([page([item(3)], 1)]);
    await run(ctx, linkId);

    expect(papers(ctx)).toHaveLength(0);
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
  it("writes nothing under a key that has been replaced", async () => {
    // A run in flight while the member pastes a new key. The papers it is
    // about to write were read with a credential they have revoked, and the
    // cursor it is about to advance belongs to a walk that no longer exists.
    const { ctx, linkId } = await linkedWorld();
    stubFetch([
      page([item(1)], 40),
      { status: 200, body: [] },
    ]);
    const inFlight = run(ctx, linkId);
    await ctx.db.patch(linkId, { connectedAt: 9_000, apiKey: "Zx7QmT4rWbNc8VhJ2LpKd6Ye" });
    await inFlight;

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
    const inFlight = run(ctx, linkId);
    await ctx.db.patch(linkId, { connectedAt: 9_000 });
    await inFlight;

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
```

- [ ] **Step 4: Run them** — `npx vitest run convex/zotero.sync.test.ts` — FAIL, the exports do not exist.

- [ ] **Step 5: Implement the sync half of `convex/zotero.ts`**

Append to `convex/zotero.ts`, and extend its imports with `internalAction`, `referenceIdentity`, `nextRedirectHop`, `cleanAuthors`/`cleanTitle`/`pdfFromResponse`, `itemsUrl`/`childrenUrl`/`fileUrl`/`readSyncHeaders`, `toReference`/`pickPdfAttachment`.

```ts
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
 * The same two hundred `listPapers` reads, and deliberately the same number:
 * this is the set of papers the library page can show, so a duplicate this
 * misses is one a member could not have seen on the shelf either. Read **once
 * per run** into a map rather than once per candidate — `createFromMetadata`
 * does the latter (`convex/papers.ts:369-376`) and at 25 candidates against a
 * full shelf that is five thousand document reads for one page of items.
 *
 * The honest limitation, written down rather than hidden: past two hundred
 * papers this fallback starts missing duplicates that have no DOI and no
 * Zotero key in common. So does the library page's own filter, and the two
 * ceilings should be lifted together — `convex/schema.ts:1119-1122` names the
 * 201st paper as the signal for exactly that.
 */
const IDENTITY_SCAN_LIMIT = 200;

/** How many links one hourly sweep will set going. */
const MAX_SWEEP_LINKS = 20;

/** A link is due for another look an hour after the last one finished. */
const SYNC_INTERVAL_MS = 60 * 60 * 1000;

/** One item, mapped and ready to be filed. */
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
 */
export const newAmong = internalQuery({
  args: { labId: v.id("labs"), candidates: v.array(zoteroCandidate) },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const shelf = await ctx.db
      .query("papers")
      .withIndex("by_lab", (q) => q.eq("labId", args.labId))
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

      if (candidate.doi !== undefined) {
        const byDoi = await ctx.db
          .query("papers")
          .withIndex("by_lab_and_doi", (q) =>
            q.eq("labId", args.labId).eq("doi", candidate.doi),
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
 */
export const commitPage = internalMutation({
  args: {
    linkId: v.id("zoteroLinks"),
    connectedAt: v.number(),
    entries: v.array(
      v.object({
        ...zoteroCandidate.fields,
        storageId: v.optional(v.id("_storage")),
      }),
    ),
    /** How many items the page held, imported or not — what `start` advances by. */
    walked: v.number(),
    targetVersion: v.number(),
    total: v.number(),
    /** True when Zotero gave back a short page: there is no more to walk. */
    exhausted: v.boolean(),
  },
  returns: v.object({ imported: v.number(), skipped: v.number(), done: v.boolean() }),
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.linkId);
    const nothing = { imported: 0, skipped: 0, done: true };
    if (link === null) return nothing;

    if (link.connectedAt !== args.connectedAt) {
      // The member replaced their key while this run was in flight. Drop the
      // files it fetched rather than leaving them in storage unreferenced.
      for (const entry of args.entries) {
        if (entry.storageId !== undefined) {
          await ctx.storage.delete(entry.storageId);
        }
      }
      return nothing;
    }

    const shelf = await ctx.db
      .query("papers")
      .withIndex("by_lab", (q) => q.eq("labId", link.labId))
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
        await ctx.db.patch(byKey._id, {
          title,
          authors,
          year: entry.year,
          venue: entry.venue,
          abstract: entry.abstract,
          doi: entry.doi ?? byKey.doi,
        });
        if (entry.storageId !== undefined) await ctx.storage.delete(entry.storageId);
        skipped += 1;
        continue;
      }

      const byDoi =
        entry.doi === undefined
          ? null
          : await ctx.db
              .query("papers")
              .withIndex("by_lab_and_doi", (q) =>
                q.eq("labId", link.labId).eq("doi", entry.doi),
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
        doi: entry.doi,
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

    const start = (link.syncCursor?.start ?? 0) + args.walked;
    const walkedImported = (link.syncCursor?.imported ?? 0) + imported;
    const done = args.exhausted || start >= args.total;
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
            total: args.total,
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

/** Record that a run looked and found nothing, or was refused. */
export const markSwept = internalMutation({
  args: {
    linkId: v.id("zoteroLinks"),
    connectedAt: v.number(),
    statusCode: v.union(v.number(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.linkId);
    if (link === null || link.connectedAt !== args.connectedAt) return null;
    const at = Date.now();
    await ctx.db.patch(link._id, {
      lastSyncAt: at,
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
```

- [ ] **Step 6: Implement the download and the run itself, still in `convex/zotero.ts`**

```ts
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
    const first = await zoteroFetch(fileUrl(library, attachmentKey), apiKey);
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

    const library: ZoteroLibrary = {
      type: payload.libraryType,
      id: payload.libraryId,
    };
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
    const body = await bodyOf(response);
    const items = Array.isArray(body) ? body : [];
    const targetVersion =
      cursor?.targetVersion ?? headers.lastModifiedVersion ?? payload.lastVersion ?? 0;
    const total = cursor?.total ?? headers.totalResults ?? items.length;

    const candidates = items
      .map((raw) => toReference(raw as Parameters<typeof toReference>[0]))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    const fresh = new Set(
      await ctx.runQuery(internal.zotero.newAmong, {
        labId: payload.labId,
        candidates,
      }),
    );

    const entries: (typeof candidates[number] & { storageId?: Id<"_storage"> })[] = [];
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
 * The file for one item, if it has one Zotero is holding.
 *
 * Two requests at worst and often none: `pickPdfAttachment` reads `linkMode`,
 * `contentType` and `md5` off the children listing, so a snapshot, a linked
 * file and a WebDAV-stored PDF are all refused before a download is spent.
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
    const linkId = await ctx.runQuery(internal.zotero.callerLinkId, {
      labId: args.labId,
    });
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
```

- [ ] **Step 7: Tighten the guard's redirect assertion, now that a second hop exists**

In `convex/credentials.guard.test.ts`, replace the `"never lets a credentialed request follow a redirect"` body:

```ts
  it("never lets a credentialed request follow a redirect", () => {
    // The finding this rule exists for: `fetch` strips `Authorization` across
    // a cross-origin redirect and strips nothing else, so a followed 302 from
    // `/items/<key>/file` hands a member's key to Amazon.
    //
    // Two halves. Every `fetch` in the module steers manually — including the
    // uncredentialed second hop, which is chosen by somebody else's `Location`
    // and has no more business following a chain than the first one does. And
    // the key is named exactly once, inside the transport, so there is one
    // request in the codebase that can carry it and it is the one that sets
    // the header.
    const zotero = sources.find((source) => source.name === "zotero.ts")?.code ?? "";
    const fetches = [...zotero.matchAll(/\bfetch\(/g)].length;
    const manual = [...zotero.matchAll(/redirect:\s*"manual"/g)].length;
    expect(fetches).toBeGreaterThan(1);
    expect(manual).toBe(fetches);
    expect([...zotero.matchAll(/"Zotero-API-Key"/g)]).toHaveLength(1);
  });
```

- [ ] **Step 8: Run everything** — `npx vitest run && npx tsc --noEmit && npx eslint convex lib` — PASS.

- [ ] **Step 9: Commit**

```bash
git add convex/zotero.ts convex/zotero.sync.test.ts convex/papers.ts convex/delegations.fixtures.ts convex/credentials.guard.test.ts
git commit -m "$(cat <<'EOF'
Zotero: a sync that walks 25 items and remembers where it stopped

A run is bounded by the expensive part — up to 25 children requests and
25 downloads — and the cursor makes that a rate rather than a ceiling, so
a 4,000-item collection fills over an afternoon instead of failing at
once. lastVersion advances only when a walk completes, and only to the
version it started at, so an edit made mid-walk is seen rather than lost.

Dedupe is indexed twice and reads the shelf once: no per-item collect
anywhere. The file download makes two hops, and the second one carries no
credential.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: The cron, and the settings row a member actually touches

**Files:**
- Create: `convex/crons.ts` (the first in this repo)
- Create: `app/(app)/app/_components/zotero-sync.tsx`
- Modify: `app/(app)/app/_components/lab-overview.tsx:25,65` (import and mount after `SlackDelivery`)
- Modify: `app/(app)/app/library/_components/add-paper.tsx:49,70-85` (a fourth tab)
- Test: `convex/crons.test.ts`

**Interfaces:**
- Consumes: `api.zotero.status`, `api.zotero.listLibraries`, `api.zotero.listCollections`, `api.zotero.connect`, `api.zotero.chooseScope`, `api.zotero.disconnect` (Task 3); `api.zotero.syncNow`, `internal.zotero.sweep` (Task 4).
- Produces: `ZoteroSync` (the settings section) and `ZoteroSyncButton` (the one the add-paper tab borrows), both exported from `app/(app)/app/_components/zotero-sync.tsx`.

- [ ] **Step 1: Write the cron's test first**

There is no crons file in this repo yet, so the thing worth testing is not "does Convex run a cron" — it is the two decisions this file encodes: how often, and pointed at what.

```ts
// convex/crons.test.ts
import { describe, expect, it } from "vitest";
import crons from "./crons";

/**
 * The first cron in this codebase, and the reason it is tested at all: a
 * schedule is a decision nobody re-reads. An interval typo turns a polite
 * hourly poll into a per-minute one against somebody else's API, and it does
 * so silently, on a deployment, at 3am.
 */
describe("the schedule", () => {
  it("polls Zotero hourly and nothing more often", () => {
    const jobs = Object.values(
      (crons as unknown as { crons: Record<string, { schedule: unknown }> }).crons,
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.schedule).toEqual({ type: "interval", minutes: 60 });
  });

  it("points at the sweep, which is the part that stays cheap", () => {
    // The handler must be the fan-out, not `syncLink` — a cron pointed
    // straight at a sync would run one member's library forever.
    const jobs = Object.values(
      (crons as unknown as { crons: Record<string, { name: string }> }).crons,
    );
    expect(jobs[0]?.name).toContain("sweep");
  });
});
```

- [ ] **Step 2: Run it** — `npx vitest run convex/crons.test.ts` — FAIL, no such module.

- [ ] **Step 3: Write `convex/crons.ts`**

```ts
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

/**
 * Everything this deployment does on its own.
 *
 * The first scheduled work in Margin, and the bar it sets for the next one:
 * a cron here must be cheap when there is nothing to do. `zotero.sweep` reads
 * one index for links older than an hour and schedules a run for each; a run
 * against an unchanged library is a single conditional request that comes back
 * `304`. A deployment where nobody has touched their Zotero all day costs one
 * small request per linked library per hour, and writes nothing.
 *
 * Hourly rather than more often because Zotero is a personal library, not a
 * feed — a paper added at 2pm appearing on the shelf by 3pm is the expectation
 * this is built to, and a member who wants it now has Sync now. Hourly rather
 * than less often because a daily poll makes the button the only real path,
 * and then the sync is a manual feature wearing a schedule.
 */
const crons = cronJobs();

crons.interval("zotero sweep", { minutes: 60 }, internal.zotero.sweep, {});

export default crons;
```

- [ ] **Step 4: Run it** — PASS.

- [ ] **Step 5: Write the settings section**

Modelled on `slack-delivery.tsx` closely enough that the two read as one idea: an eyebrow, two-variant serif prose, a `role="status"` line when the last attempt was refused, and a body that is one of three things depending on how far along the member is.

```tsx
// app/(app)/app/_components/zotero-sync.tsx
"use client";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  errorClass,
  eyebrowClass,
  inputClass,
  labelClass,
  primaryButtonClass,
  secondaryButtonClass,
  selectClass,
  skeletonClass,
} from "@/lib/ui";
import { useAction, useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { useEffect, useRef, useState } from "react";
import { ConfirmAction } from "./confirm-action";
import { readableError } from "./errors";
import type { LabSummary } from "./lab-provider";

/**
 * Keep Zotero.
 *
 * The strategy document is blunt about this (`docs/STRATEGY.md:121`): Margin
 * does not rebuild citation management, and "keep using Zotero" is the pitch
 * rather than a concession. So this section is deliberately small — a key, a
 * library, a collection, and a button — and everything it says is about what
 * Margin will do with somebody else's library rather than what Margin would
 * like to become.
 *
 * ## Why the key never reaches React state
 *
 * The same bargain `slack-delivery.tsx` makes with a webhook URL, for the same
 * reason. The field is read off a ref at submit and the input is cleared; the
 * key is not a value this component holds, it is a value passing through it.
 * Once it is on the server there is no query that will hand it back — the
 * status query answers *when* it was connected, never *what* it is — so the
 * only place the string ever exists in a browser is the field the member
 * pasted it into.
 *
 * ## Why a paged sync gets a paged sentence
 *
 * A run walks a bounded page and stops, on purpose. A UI that says "Synced!"
 * after 25 of a member's 4,000 papers is lying in the way that costs trust
 * later — so progress is always "N of about M", and the button says whether
 * there is more. A partial import that announces itself is a product being
 * careful. A partial import that pretends to be complete is a bug the member
 * finds on their own, a week later.
 */
export function ZoteroSync({ lab }: { lab: LabSummary }) {
  const status = useQuery(api.zotero.status, { labId: lab._id });

  if (status === undefined) {
    return (
      <section className="flex flex-col gap-4 border-t border-rule pt-8">
        <div className={`${skeletonClass} h-4 w-32`} />
        <div className={`${skeletonClass} h-12 w-full max-w-md`} />
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4 border-t border-rule pt-8">
      <h2 className={eyebrowClass}>Zotero</h2>

      <p className="max-w-prose font-serif text-sm leading-relaxed text-ink-muted">
        {status.connected
          ? "Papers you add to the collection below turn up on this lab's shelf, with their PDFs where Zotero is holding them. Margin reads; it never writes back."
          : "Point Margin at one Zotero collection and it will keep the shelf topped up from it. Read-only, one direction — your library stays yours."}
      </p>

      {status.lastSyncFailed !== null && (
        <p role="status" className={errorClass}>
          {/*
            403 and 404 are the two that need the member. A key that was
            deleted, or one that never reached this library — either way no
            amount of waiting fixes it, so the sentence asks for a new key
            rather than promising to retry. Everything else that gets this far
            is a bad afternoon at api.zotero.org, and `permanentStatus` has
            already filtered those out.
          */}
          {status.lastSyncFailed.statusCode === 403 ||
          status.lastSyncFailed.statusCode === 404
            ? "Zotero turned that key down. It may have been deleted, or it may not reach this library any more — paste a new one."
            : "The last sync did not go through. Margin will try again within the hour."}
        </p>
      )}

      {!status.connected ? (
        <ConnectForm labId={lab._id} />
      ) : status.collectionName === null ? (
        <ScopeForm labId={lab._id} />
      ) : (
        <Connected labId={lab._id} status={status} />
      )}
    </section>
  );
}
```

- [ ] **Step 6: The first two bodies, same file**

```tsx
/** Step one: a key, and where to make one. */
function ConnectForm({ labId }: { labId: Id<"labs"> }) {
  const connect = useAction(api.zotero.connect);
  const field = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="flex max-w-md flex-col gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        const input = field.current;
        const apiKey = input?.value.trim() ?? "";
        if (apiKey === "" || pending) return;
        setPending(true);
        setError(null);
        try {
          await connect({ labId, apiKey });
          // Cleared on the way out, never held in state on the way in.
          if (input !== null) input.value = "";
        } catch (caught) {
          setError(readableError(caught, "That key did not work."));
        } finally {
          setPending(false);
        }
      }}
    >
      <label className={labelClass} htmlFor="zotero-key">
        API key
      </label>
      <input
        ref={field}
        id="zotero-key"
        // A password field, because a key pasted in a shared office is still a
        // key, and because it keeps the browser from offering to remember it.
        type="password"
        autoComplete="off"
        className={inputClass}
        placeholder="P9NiFoyLeZu2bZNvvuQPDWsd"
        disabled={pending}
      />
      <p className="font-sans text-xs text-ink-faint">
        zotero.org → Settings → Feeds/API → Create new private key. Margin only
        needs read access.
      </p>
      {error !== null && (
        <p role="alert" className={`${errorClass} pop-in`}>
          {error}
        </p>
      )}
      <button type="submit" className={primaryButtonClass} disabled={pending}>
        {pending ? "Checking…" : "Connect"}
      </button>
    </form>
  );
}

/**
 * Step two: which library, and which collection inside it.
 *
 * A collection rather than the whole library, and not optional, because the
 * whole library is the thing that gets somebody in trouble — a personal Zotero
 * is a decade of half-read PDFs, and pushing all of it onto a shared shelf is
 * a mistake that takes an afternoon to undo. Picking a collection is the
 * moment the member decides what the lab sees.
 *
 * Two round trips rather than one form, because `listCollections` reads the
 * library off the stored link (Task 3) rather than taking one as an argument:
 * choosing a library is itself a `chooseScope` write, and only then is there a
 * library whose collections can be listed. That is the right shape — the
 * server has one answer to "which library is this link pointed at", and it is
 * the stored one, not whatever a form field happened to hold.
 *
 * Both lists come from actions, not queries: they are network calls to
 * somebody else's API, so there is nothing for Convex to keep live. They are
 * fetched once, into state, and re-fetched when the choice changes.
 */
function ScopeForm({ labId }: { labId: Id<"labs"> }) {
  const listLibraries = useAction(api.zotero.listLibraries);
  const listCollections = useAction(api.zotero.listCollections);
  const chooseScope = useMutation(api.zotero.chooseScope);

  type Library = { type: "user" | "group"; id: string; name: string };
  const [libraries, setLibraries] = useState<Library[] | null>(null);
  const [chosen, setChosen] = useState<Library | null>(null);
  const [collections, setCollections] = useState<
    { key: string; name: string }[] | null
  >(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // `cancelled` because this is a network call in an effect and the member
    // can leave the page mid-flight; setting state on the way out is a warning
    // in development and a leak in a long session.
    let cancelled = false;
    listLibraries({ labId })
      .then((result) => {
        if (!cancelled) setLibraries(result.libraries);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(readableError(caught, "Could not reach Zotero."));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [labId, listLibraries]);

  async function pickLibrary(library: Library) {
    setPending(true);
    setError(null);
    setCollections(null);
    setChosen(library);
    try {
      await chooseScope({
        labId,
        libraryType: library.type,
        libraryId: library.id,
        libraryName: library.name,
      });
      const result = await listCollections({ labId });
      setCollections(result.collections);
    } catch (caught) {
      setError(readableError(caught, "Could not read that library."));
    } finally {
      setPending(false);
    }
  }

  async function pickCollection(collection: { key: string; name: string }) {
    if (chosen === null) return;
    setPending(true);
    setError(null);
    try {
      await chooseScope({
        labId,
        libraryType: chosen.type,
        libraryId: chosen.id,
        libraryName: chosen.name,
        collectionKey: collection.key,
        collectionName: collection.name,
      });
    } catch (caught) {
      setError(readableError(caught, "Could not save that choice."));
    } finally {
      setPending(false);
    }
  }

  if (libraries === null && error === null) {
    return <div className={`${skeletonClass} h-10 w-full max-w-md`} />;
  }

  return (
    <div className="flex max-w-md flex-col gap-3">
      <div className="flex flex-col gap-2">
        <label className={labelClass} htmlFor="zotero-library">
          Library
        </label>
        <select
          id="zotero-library"
          className={selectClass}
          value={chosen === null ? "" : `${chosen.type}:${chosen.id}`}
          disabled={pending}
          onChange={(event) => {
            const next = (libraries ?? []).find(
              (entry) => `${entry.type}:${entry.id}` === event.target.value,
            );
            if (next !== undefined) void pickLibrary(next);
          }}
        >
          <option value="">Choose a library…</option>
          {(libraries ?? []).map((entry) => (
            <option key={`${entry.type}:${entry.id}`} value={`${entry.type}:${entry.id}`}>
              {entry.name}
            </option>
          ))}
        </select>
      </div>

      {chosen !== null && (
        <div className="flex flex-col gap-2">
          <label className={labelClass} htmlFor="zotero-collection">
            Collection
          </label>
          {collections === null ? (
            <div className={`${skeletonClass} h-10 w-full`} />
          ) : collections.length === 0 ? (
            <p className="font-sans text-xs text-ink-faint">
              This library has no collections yet. Make one in Zotero, put the
              papers this lab should see in it, and come back.
            </p>
          ) : (
            <select
              id="zotero-collection"
              className={selectClass}
              defaultValue=""
              disabled={pending}
              onChange={(event) => {
                const next = collections.find(
                  (entry) => entry.key === event.target.value,
                );
                if (next !== undefined) void pickCollection(next);
              }}
            >
              <option value="">Choose a collection…</option>
              {collections.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.name}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      {error !== null && (
        <p role="alert" className={`${errorClass} pop-in`}>
          {error}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 7: The connected body, and the button the add-paper tab borrows**

```tsx
/**
 * What `api.zotero.status` answers, named once so three components agree.
 *
 * Written out rather than inferred because this file is the only consumer of
 * that query and a rename on the server should break here loudly.
 */
type ZoteroStatus = {
  connected: boolean;
  libraryName: string | null;
  collectionName: string | null;
  lastSyncAt: number | null;
  lastSyncFailed: { at: number; statusCode: number } | null;
  progress: { checked: number; total: number; imported: number } | null;
  lastImported: number | null;
};

/** Step three: what is linked, how far along it is, and how to stop. */
function Connected({
  labId,
  status,
}: {
  labId: Id<"labs">;
  status: ZoteroStatus;
}) {
  const disconnect = useMutation(api.zotero.disconnect);

  return (
    <div className="flex max-w-md flex-col gap-3">
      <p className="font-sans text-sm text-ink">
        {status.collectionName}
        {status.libraryName === null ? "" : ` — ${status.libraryName}`}
      </p>
      {status.progress !== null && (
        // "About", because `Total-Results` was true when the walk started and
        // the member has been adding papers since. A number that turns out to
        // be off by three is fine; a number that claimed to be exact and was
        // off by three is the one that gets reported as a bug.
        <p className="font-sans text-xs text-ink-faint">
          {`Synced ${status.progress.checked} of about ${status.progress.total} — the rest arrives over the next few checks.`}
        </p>
      )}
      <div className="flex items-center gap-3">
        <ZoteroSyncButton labId={labId} />
        <ConfirmAction
          label="Unlink"
          confirmLabel="Unlink Zotero"
          description="Margin stops checking and forgets the key. Papers already on the shelf stay."
          onConfirm={() => disconnect({ labId })}
        />
      </div>
    </div>
  );
}

/**
 * Sync now, and an honest sentence about what "now" got through.
 *
 * The button owns its own outcome text rather than reading it off the status
 * query, because the interesting part is the *delta* — the member pressed a
 * thing and wants to know what that press did. `done: false` becomes an
 * invitation to press again rather than an error, which is the difference
 * between a cap that reads as pacing and a cap that reads as a failure.
 */
export function ZoteroSyncButton({ labId }: { labId: Id<"labs"> }) {
  const syncNow = useAction(api.zotero.syncNow);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        className={secondaryButtonClass}
        disabled={pending}
        onClick={async () => {
          if (pending) return;
          setPending(true);
          setOutcome(null);
          try {
            const result = await syncNow({ labId });
            setOutcome(
              result.done && result.imported === 0
                ? "Nothing new."
                : result.done
                  ? `Added ${result.imported}.`
                  : `Added ${result.imported} — there's more. Press again, or leave it to the hourly check.`,
            );
          } catch (caught) {
            setOutcome(readableError(caught, "That did not go through."));
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? "Syncing…" : "Sync now"}
      </button>
      {outcome !== null && (
        <span role="status" className="font-sans text-xs text-ink-faint">
          {outcome}
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Mount it**

In `app/(app)/app/_components/lab-overview.tsx`, after the `SlackDelivery` import (`:25`) add `import { ZoteroSync } from "./zotero-sync";`, and after the `<SlackDelivery lab={lab} />` line (`:65`):

```tsx
      {/* Per member, like Slack — but a key is one person's, not the lab's. */}
      <ZoteroSync lab={lab} />
```

- [ ] **Step 9: The fourth tab on Add paper**

The connection lives in settings; this tab is a doorway, not a second place to configure anything. In `app/(app)/app/library/_components/add-paper.tsx`, widen the tab state (`:49`):

```tsx
  const [tab, setTab] = useState<"doi" | "upload" | "references" | "zotero">("doi");
```

Add a fourth `TabButton` after the references one (`:70-76`):

```tsx
        <TabButton
          id="zotero"
          label="From Zotero"
          active={tab === "zotero"}
          onSelect={() => setTab("zotero")}
        />
```

Extend the body chain (`:78-85`) with a `zotero` arm before the references fallback, and add the panel — plus imports for `ZoteroSyncButton` from `../../_components/zotero-sync`, `useQuery` from `convex-helpers/react/cache/hooks`, and `skeletonClass` if the file does not already have them:

```tsx
/**
 * The doorway, not the door.
 *
 * Somebody who thinks "I'll add this from Zotero" looks here, not in lab
 * settings — so this tab exists. What it does *not* do is offer a second place
 * to paste a key: one connection, one place it is configured, and this panel
 * either pulls the handle or points at where the handle is. Two setup surfaces
 * for one credential is how a member ends up with two keys and no idea which
 * one is live.
 */
function ZoteroTab({ labId }: { labId: Id<"labs"> }) {
  const status = useQuery(api.zotero.status, { labId });

  return (
    <div
      role="tabpanel"
      id="add-paper-panel-zotero"
      aria-labelledby="add-paper-tab-zotero"
      className="flex flex-col gap-3"
      tabIndex={0}
    >
      {status === undefined ? (
        <div className={`${skeletonClass} h-9 w-40`} />
      ) : status.connected && status.collectionName !== null ? (
        <>
          <p className="font-serif text-sm leading-relaxed text-ink-muted">
            {`Pulling from ${status.collectionName}. Margin checks hourly on its own.`}
          </p>
          <ZoteroSyncButton labId={labId} />
        </>
      ) : (
        <p className="font-serif text-sm leading-relaxed text-ink-muted">
          Link a Zotero collection in lab settings and papers you add there will
          turn up here on their own.
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 10: Run everything**

```bash
npx vitest run && npx tsc --noEmit && npx eslint . && npx next build
```

`next build` matters here specifically: the `useQuery` import restriction in `eslint.config.mjs` and the client/server boundary on the new component are both build-time facts, and a settings section that fails to compile takes the whole lab page with it.

- [ ] **Step 11: Commit**

```bash
git add convex/crons.ts convex/crons.test.ts "app/(app)/app/_components/zotero-sync.tsx" "app/(app)/app/_components/lab-overview.tsx" "app/(app)/app/library/_components/add-paper.tsx"
git commit -m "$(cat <<'EOF'
Zotero: an hourly check, and a row that admits when it is not finished

The first cron in this codebase, and the bar it sets: cheap when there is
nothing to do — one conditional request per linked library per hour, and
no writes when the answer is 304.

The settings row is Slack's shape because it is Slack's problem: a
credential the browser hands over once and never sees again. The sync
button reports the delta rather than a state, and says "there's more"
when a page ran out, because a paged import that claims to be complete is
a bug the member finds a week later.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Manual browser pass

The tests cover every boundary; these are the things only a person notices.

- [ ] Make a read-only Zotero key on a real account with a real library. Paste it. The field empties and does not offer to autofill next time.
- [ ] Pick a group library if you belong to one. The collection list changes to that library's, not the personal one's.
- [ ] Press Sync now on a collection with more than 25 papers. The line reads "Added 25 — there's more", and the count in the settings row says "Imported 25 of about N".
- [ ] Press it again. It continues rather than restarting; nothing arrives twice.
- [ ] Open one of the synced papers in the reader. The PDF is there and the text layer builds on first open, exactly like a DOI-fetched paper.
- [ ] Add a paper to the Zotero collection that the lab already has from a DOI. Sync. No second row appears.
- [ ] Fix a typo in a title in Zotero. Sync. The shelf's copy updates; annotations on it are undisturbed.
- [ ] Unlink. The row returns to its first state, and the ledger shows a `zotero.link_changed` with no key anywhere in it.
- [ ] With DevTools open on the Network tab through all of the above: no request from the browser contains the key, and no query response does either.
- [ ] Reduced motion on: the row's states change without movement.
- [ ] Dark mode: the select's chevron and the status line are both legible.

## Out of scope, and flagged rather than fixed

Named here so a reviewer can see they were considered and declined, not missed.

- **Two-way sync**, **annotation sync**, **group write-back**, **collection and tag mirroring**, **WebDAV attachments.** One direction is the whole scope. Write-back in particular is a different feature with a different consent question — Margin holding a write key to somebody's decade-old library is not a thing to arrive at by increment.
- **The 200-paper ceiling.** `listPapers` reads a lab's shelf under one `take(200)` (`convex/schema.ts:1119-1122`), and this feature makes hitting it much more likely — a synced collection can be four thousand papers. The identity-fallback dedupe is capped at the same 200 deliberately, so the two ceilings are one ceiling and lift together. **This is the first thing to do after this lands**, and the schema comment already names the 201st paper as the signal.
- **`createFromMetadata`'s per-item `.collect()` dedupe** (`convex/papers.ts:369-376`) is untouched. The `.bib` import path still reads the whole library per reference. It should get the same bounded-map treatment `newAmong` uses, but changing it here would put a shared write path in a Zotero pull request.
- **A key shared across labs.** Each `zoteroLinks` row is one member in one lab, so a member in two labs pastes twice. Correct — the collection is chosen per lab and the papers land per lab — but worth watching if anybody has three.
- **Retry on a `5xx` mid-walk.** Deliberately absent: the durable cursor is the retry, and the sweep comes back in an hour. If members report walks stalling on a flaky repository, the fix is a shorter sweep interval for links with an in-flight cursor, not an in-run retry loop.
