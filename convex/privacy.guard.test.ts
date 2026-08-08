import type { ValidatorJSON } from "convex/values";
import { describe, expect, it } from "vitest";
import schema from "./schema";

/**
 * THE PRIVACY CONSTITUTION, MECHANICALLY.
 *
 * `docs/ARCHITECTURE.md` says the privacy rules are "enforced by the schema
 * rather than by policy". This file is the part that makes that sentence
 * true: it reads `convex/schema.ts` back out through Convex's own validator
 * introspection and checks the promises structurally, so "there is no `reads`
 * table and no `viewedAt` field" is a build failure rather than a paragraph.
 *
 * The promises, from the constitution:
 *
 *   - No dwell or read tracking. No `reads` table, no `viewedAt` field, no
 *     read event type. The only evidence of engagement Margin ever stores is
 *     an annotation someone chose to write.
 *   - Annotations are private outside a session and lab-visible inside one —
 *     two states, not a permission lattice that quietly grows a third.
 *   - The ledger references annotations; it never duplicates their bodies.
 *     A copy of a private note inside an append-only table is a note that can
 *     never be unshared, and `events` rows are never deleted.
 *
 * IF THIS FILE FAILS, YOU HAVE BROKEN A MARKETING-LEVEL PRODUCT PROMISE.
 * The failure is the point. Do not relax an assertion to make it pass — the
 * schema is what is wrong. If a product decision genuinely changes one of
 * these promises, that decision belongs in `docs/ARCHITECTURE.md` first, and
 * the copy on the sign-in page ("Margin never tracks what you read") second.
 */

// --- Validator introspection -----------------------------------------------
//
// A Convex validator exposes its wire form at `.json`: objects are
// `{ type: "object", value: { field: { fieldType, optional } } }`, unions are
// `{ type: "union", value: [...] }`, and so on. Walking that structure is
// exact, where scanning the source text of schema.ts for a substring would
// match a comment and miss a field spelled through a shared constant.

type Json = unknown;

function isRecord(node: Json): node is Record<string, Json> {
  return typeof node === "object" && node !== null && !Array.isArray(node);
}

/**
 * The wire form of a validator.
 *
 * `ValidatorJSON` is public API and `.json` is what Convex itself pushes to a
 * deployment, but the property is absent from the declared type of the wide
 * `VUnion | VObject | …` union that `schema.tables[x].validator` resolves to.
 * One narrow accessor, asserted at runtime, rather than a cast at each of the
 * three call sites — if a future convex release moves it, this throws here
 * with a name instead of silently walking `undefined` and passing.
 */
function wireForm(validator: unknown): ValidatorJSON {
  const json = (validator as { json?: unknown }).json;
  if (!isRecord(json)) {
    throw new Error(
      "Convex validator has no `.json` wire form; this guard cannot introspect the schema and must not be assumed to pass.",
    );
  }
  return json as ValidatorJSON;
}

/** Every field declared anywhere under `node`, as `a.b.c` paths. */
function fieldPaths(node: Json, prefix: string[] = []): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((child) => fieldPaths(child, prefix));
  }
  if (!isRecord(node)) return [];

  if (node.type === "object" && isRecord(node.value)) {
    return Object.entries(node.value).flatMap(([name, entry]) => {
      const path = [...prefix, name];
      const nested = isRecord(entry) ? fieldPaths(entry.fieldType, path) : [];
      return [path.join("."), ...nested];
    });
  }

  // Unions, arrays, records: descend through every child that could hold an
  // object. `type` and `tableName` are leaf metadata, never nested schema.
  return Object.entries(node)
    .filter(([key]) => key !== "type" && key !== "tableName")
    .flatMap(([, child]) => fieldPaths(child, prefix));
}

/** Every literal string appearing anywhere under `node`. */
function literals(node: Json): string[] {
  if (Array.isArray(node)) return node.flatMap(literals);
  if (!isRecord(node)) return [];
  if (node.type === "literal") {
    return typeof node.value === "string" ? [node.value] : [];
  }
  // Objects get their own branch rather than falling through to the generic
  // descent below: a *field* may legitimately be named `type` — the ledger's
  // discriminant is — and the generic filter would drop it along with the
  // node's own `type` tag, silently blinding the read-event check.
  if (node.type === "object" && isRecord(node.value)) {
    return Object.values(node.value).flatMap((entry) =>
      isRecord(entry) ? literals(entry.fieldType) : [],
    );
  }
  return Object.entries(node)
    .filter(([key]) => key !== "type" && key !== "tableName")
    .flatMap(([, child]) => literals(child));
}

const tableNames = Object.keys(schema.tables);

const tableValidators = Object.entries(schema.tables).map(
  ([name, table]) => [name, wireForm(table.validator)] as const,
);

/** `field` → the `table.a.b.field` paths it appears at, across the schema. */
const allFields = tableValidators.flatMap(([table, validator]) =>
  fieldPaths(validator).map((path) => ({
    table,
    path: `${table}.${path}`,
    name: path.split(".").at(-1) ?? path,
  })),
);

// --- 1. No table that records that someone looked at something -------------

describe("no read-tracking table", () => {
  /**
   * Matched against the table name lowercased with separators stripped, so
   * `read_receipts`, `readReceipts` and `ReadReceipt` are all one pattern.
   */
  const forbidden = [
    /^reads?$/,
    /readreceipt/,
    /pageview/,
    /pagevisit/,
    /viewlog/,
    /viewevent/,
    /readevent/,
    /readinghistory/,
    /readingtime/,
    /dwell/,
    /impression/,
  ];

  it("declares no table whose name describes reading or viewing", () => {
    const offenders = tableNames.filter((name) => {
      const normalized = name.toLowerCase().replace(/[^a-z]/g, "");
      return forbidden.some((pattern) => pattern.test(normalized));
    });

    expect(
      offenders,
      "The only evidence of engagement Margin stores is an authored annotation.",
    ).toEqual([]);
  });

  it("still declares the tables the rest of the product needs", () => {
    // A guard that passes because the schema stopped exporting anything is
    // not a guard. Anchor it to tables that must exist.
    expect(tableNames).toEqual(
      expect.arrayContaining(["annotations", "events", "papers", "sessions"]),
    );
    expect(allFields.length).toBeGreaterThan(50);
  });
});

// --- 2. No field that records when, or for how long, someone read ----------

describe("no dwell or read-timing field", () => {
  const forbidden = [
    /^dwell/i,
    /^viewedAt$/i,
    /^readAt$/i,
    /^lastReadAt$/i,
    /^firstReadAt$/i,
    /^openedAt$/i,
    /^scrollDepth$/i,
    /^timeSpent$/i,
    /^readCount$/i,
    /^viewCount$/i,
  ];

  it("declares no such field anywhere in the schema", () => {
    const offenders = allFields
      .filter(({ name }) => forbidden.some((pattern) => pattern.test(name)))
      .map(({ path }) => path);

    expect(
      offenders,
      "Margin records what a member wrote, never that they looked.",
    ).toEqual([]);
  });
});

// --- 3. The ledger has no read event, and never copies an annotation body --

describe("the events ledger", () => {
  const eventsValidator = wireForm(schema.tables.events.validator);

  it("has no read/view event type", () => {
    // Event types are dotted names like `annotation.created`; compare per
    // segment so a future `session.spread` is not a false positive.
    const readish = new Set([
      "read",
      "reads",
      "viewed",
      "view",
      "views",
      "opened",
      "dwell",
      "seen",
    ]);

    const eventLiterals = literals(eventsValidator);

    // Anchor: if the walk ever stops seeing the discriminant, this check is
    // vacuous and would pass a `paper.read` variant without noticing.
    expect(eventLiterals).toContain("annotation.created");

    const offenders = eventLiterals.filter((literal) =>
      literal
        .split(/[.\-_]/)
        .some((segment) => readish.has(segment.toLowerCase())),
    );

    expect(offenders).toEqual([]);
  });

  it("references annotation bodies rather than duplicating them", () => {
    // An events row is never updated and never deleted. A copy of an
    // annotation's text in here would survive the annotation being made
    // private, edited, or deleted — so the ledger carries ids only.
    const forbidden = new Set(["body", "text", "content", "quote", "excerpt"]);

    const offenders = fieldPaths(eventsValidator).filter((path) =>
      forbidden.has((path.split(".").at(-1) ?? path).toLowerCase()),
    );

    expect(
      offenders,
      "Ledger events reference annotations by id; they never carry the prose.",
    ).toEqual([]);

    // And prove the reference actually exists, so the check above is not
    // passing over an empty union.
    expect(fieldPaths(eventsValidator)).toContain("annotationId");
  });
});

// --- 4. Annotation visibility is exactly two states ------------------------

describe("annotation visibility", () => {
  it("admits exactly private and lab", () => {
    const annotations = wireForm(schema.tables.annotations.validator);
    if (annotations.type !== "object") {
      throw new Error("annotations is no longer an object validator");
    }

    const visibility = annotations.value.visibility;
    if (visibility === undefined) {
      throw new Error("annotations.visibility has disappeared from the schema");
    }

    // Not optional: an annotation with no visibility is an annotation whose
    // audience the code has to guess, and the safe guess is the one that
    // leaks.
    expect(visibility.optional, "visibility is never absent").toBe(false);

    expect([...literals(visibility.fieldType)].sort()).toEqual([
      "lab",
      "private",
    ]);
  });
});
