import { getFunctionName } from "convex/server";
import { internal } from "./_generated/api";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import {
  STUB_MODEL,
  type DelegationModelFailure,
  type ScoutModelResult,
} from "./delegations";

/**
 * A database that runs in a test process.
 *
 * `convex/` is unit-tested rather than integration-tested — the vitest config
 * says why — and the modules that have needed it so far (the synthesis
 * sanitizer, the digest engine, the anchoring resolver) are pure enough to
 * test as functions. The scout is not. Its invariants are *transactional*:
 * that a claim cannot happen twice, that a store refuses when the lease has
 * moved, that settling a question reaches into rows the settling code has
 * never heard of. None of those is visible from a pure function, and a
 * feature whose correctness lives in the transitions needs the transitions
 * exercised.
 *
 * So this is a small in-memory stand-in for `ctx.db`, `ctx.scheduler` and the
 * `runQuery`/`runMutation` pair, sufficient for the reads this module makes
 * and no more. It is deliberately dumb: indexes are filters, ordering is by
 * creation, and nothing here is a simulation of Convex's semantics beyond
 * what the code under test actually depends on. Where it diverges it should
 * diverge toward being *stricter* than the real thing, never looser — see
 * `hostileSearchIndex` below, which is the whole point of the exercise.
 * One known exception breaks that rule today: the `search` constraint in
 * `matches` accepts every row, so no test here can tell "the search found
 * it" from "something else supplied it". Tightening it means re-seeding
 * scoutEval.test.ts's empty-body overfetch rows in the same change.
 *
 * The file is named with two dots so Convex's bundler skips it, the same
 * trick `*.test.ts` relies on. Nothing here is ever deployed.
 */

/* -------------------------------------------------------------------------
 * Reaching the handler
 * ---------------------------------------------------------------------- */

type Handler = (ctx: unknown, args: never) => unknown;

/**
 * The function inside a registered Convex function.
 *
 * `_handler` is not public API, so this is one narrow accessor with a runtime
 * assertion rather than a cast at each of the dozen call sites — if a future
 * convex release renames it, the suite fails here, with a name, instead of
 * silently testing `undefined`. The same bargain `privacy.guard.test.ts`
 * makes for the validator's `.json` wire form.
 */
export function handlerOf(registered: unknown): Handler {
  const handler = (registered as { _handler?: unknown })._handler;
  if (typeof handler !== "function") {
    throw new Error(
      "A registered Convex function has no `_handler`; these tests cannot reach the code they claim to cover and must not be assumed to pass.",
    );
  }
  return handler as Handler;
}

/**
 * The row a test says is there, with "is it there" folded into the read.
 *
 * `noUncheckedIndexedAccess` is on, so every `rows[0]` is a maybe. Optional
 * chaining would silence that, but it also turns a suite that stored nothing
 * into a suite that passes its `toBeUndefined` assertions — the failure mode
 * a privacy test can least afford. This throws instead.
 */
export function rowAt<T>(rows: readonly T[], index = 0): T {
  const row = rows[index];
  if (row === undefined) {
    throw new Error(
      `Expected a row at index ${index}, found ${rows.length} of them.`,
    );
  }
  return row;
}

/* -------------------------------------------------------------------------
 * The database
 * ---------------------------------------------------------------------- */

type Row = Record<string, unknown> & { _id: string; _creationTime: number };

type Constraint =
  | { kind: "eq"; field: string; value: unknown }
  | { kind: "gte"; field: string; value: unknown }
  | { kind: "lte"; field: string; value: unknown }
  | { kind: "search"; field: string; text: string };

function matches(row: Row, constraints: readonly Constraint[]): boolean {
  return constraints.every((constraint) => {
    const actual = row[constraint.field];
    switch (constraint.kind) {
      case "eq":
        return actual === constraint.value;
      case "gte":
        return (actual as number) >= (constraint.value as number);
      case "lte":
        return (actual as number) <= (constraint.value as number);
      case "search":
        return true;
    }
  });
}

/** Records what the code asked the index for, so a test can assert on it. */
export type IndexRead = {
  table: string;
  index: string;
  constraints: Constraint[];
};

/** A `filter()` expression, evaluated against one row. */
type Expr = (row: Row) => unknown;

/**
 * The `q` handed to a `.filter()` callback.
 *
 * Convex offers far more than this — `gt`, `lt`, `add`, `sub` — and every one
 * of them is deliberately absent rather than approximated. A read that starts
 * needing one throws here, at the missing method, instead of being filtered by
 * a builder that quietly returned something truthy; this fixture's whole
 * bargain is that where it diverges it diverges toward being stricter.
 */
class ExpressionBuilder {
  field(name: string): Expr {
    return (row) => row[name];
  }
  eq(a: Expr, b: Expr | unknown): Expr {
    return (row) => a(row) === (typeof b === "function" ? (b as Expr)(row) : b);
  }
  neq(a: Expr, b: Expr | unknown): Expr {
    return (row) => a(row) !== (typeof b === "function" ? (b as Expr)(row) : b);
  }
  and(...parts: Expr[]): Expr {
    return (row) => parts.every((part) => part(row) === true);
  }
  or(...parts: Expr[]): Expr {
    return (row) => parts.some((part) => part(row) === true);
  }
}

class FakeQuery {
  constructor(
    private readonly rows: Row[],
    private readonly constraints: Constraint[],
    private readonly descending: boolean,
    /** When true, filters are recorded and then ignored — a lying index. */
    private readonly hostile: boolean,
    /** The `filter()` predicate, applied after the index constraints. */
    private readonly predicate: Expr | null = null,
  ) {}

  order(direction: "asc" | "desc"): FakeQuery {
    return new FakeQuery(
      this.rows,
      this.constraints,
      direction === "desc",
      this.hostile,
      this.predicate,
    );
  }

  filter(build: (q: ExpressionBuilder) => Expr): FakeQuery {
    const predicate = build(new ExpressionBuilder());
    if (typeof predicate !== "function") {
      throw new Error(
        "A `filter()` callback returned something this fixture cannot evaluate; it knows eq/neq/and/or/field and nothing else.",
      );
    }
    return new FakeQuery(
      this.rows,
      this.constraints,
      this.descending,
      this.hostile,
      predicate,
    );
  }

  private keep(row: Row): boolean {
    if (this.predicate === null) return true;
    const verdict = this.predicate(row);
    // A bare `q.field("x")` as the whole filter is the shape that would
    // otherwise pass a truthy row and drop a falsy one while looking like a
    // predicate. Convex requires a boolean here and so does this.
    if (typeof verdict !== "boolean") {
      throw new Error(
        `A \`filter()\` expression answered ${typeof verdict} rather than a boolean; this fixture refuses to guess what that meant.`,
      );
    }
    return verdict;
  }

  private resolve(): Row[] {
    const indexed = this.hostile
      ? [...this.rows]
      : this.rows.filter((row) => matches(row, this.constraints));
    const kept = indexed.filter((row) => this.keep(row));
    kept.sort((a, b) => a._creationTime - b._creationTime);
    return this.descending ? kept.reverse() : kept;
  }

  async take(count: number): Promise<Row[]> {
    return this.resolve().slice(0, count);
  }

  async collect(): Promise<Row[]> {
    return this.resolve();
  }

  async unique(): Promise<Row | null> {
    const all = this.resolve();
    if (all.length > 1) throw new Error("unique() matched more than one row");
    return all[0] ?? null;
  }

  async first(): Promise<Row | null> {
    return this.resolve()[0] ?? null;
  }
}

/** The `q` handed to a `.withIndex` / `.withSearchIndex` callback. */
class ConstraintBuilder {
  constructor(readonly constraints: Constraint[]) {}
  eq(field: string, value: unknown): ConstraintBuilder {
    this.constraints.push({ kind: "eq", field, value });
    return this;
  }
  gte(field: string, value: unknown): ConstraintBuilder {
    this.constraints.push({ kind: "gte", field, value });
    return this;
  }
  lte(field: string, value: unknown): ConstraintBuilder {
    this.constraints.push({ kind: "lte", field, value });
    return this;
  }
  search(field: string, text: string): ConstraintBuilder {
    this.constraints.push({ kind: "search", field, text });
    return this;
  }
}

export class FakeDb {
  private readonly tables = new Map<string, Row[]>();
  private readonly byId = new Map<string, Row>();
  private counter = 0;

  /** Every indexed read the code under test has performed, in order. */
  readonly reads: IndexRead[] = [];

  /**
   * When true, search reads return every row in the table regardless of the
   * filters the caller asked for.
   *
   * This is not a convenience. It is the adversary: a search index that has
   * silently stopped honouring `visibility` looks, from the calling code,
   * exactly like one that still does. Turning this on is how the privacy
   * suite proves the *second* gate — that a private note handed to the code
   * anyway still never reaches a prompt or a finding.
   */
  hostileSearchIndex = false;

  /**
   * `ctx.db.system`, which in Convex reads the metadata Convex itself keeps —
   * here, the `_storage` rows `papers.requireStoredPdf` checks a file's type and
   * size against before a paper is allowed to claim it. Nothing writes these; a
   * test that wants an upload to exist calls `putSystem` and says what it is.
   */
  readonly system = {
    get: async (id: string): Promise<Row | null> =>
      this.systemRows.get(id) ?? null,
  };

  private readonly systemRows = new Map<string, Row>();

  /** Declare a stored file, as the platform would have after an upload. */
  putSystem(id: string, doc: Record<string, unknown>): void {
    this.systemRows.set(id, { ...doc, _id: id, _creationTime: 0 } as Row);
  }

  private rowsOf(table: string): Row[] {
    const existing = this.tables.get(table);
    if (existing !== undefined) return existing;
    const created: Row[] = [];
    this.tables.set(table, created);
    return created;
  }

  async insert<T extends TableNames>(
    table: T,
    doc: Record<string, unknown>,
  ): Promise<Id<T>> {
    this.counter += 1;
    const row: Row = {
      ...doc,
      _id: `${table}_${this.counter}`,
      _creationTime: this.counter,
    };
    for (const [key, value] of Object.entries(row)) {
      if (value === undefined) delete row[key];
    }
    this.rowsOf(table).push(row);
    this.byId.set(row._id, row);
    return row._id as Id<T>;
  }

  async get<T extends TableNames>(id: Id<T>): Promise<Doc<T> | null> {
    return (this.byId.get(id as string) ?? null) as Doc<T> | null;
  }

  async patch(id: string, fields: Record<string, unknown>): Promise<void> {
    const row = this.byId.get(id);
    if (row === undefined) throw new Error(`no such row: ${id}`);
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) delete row[key];
      else row[key] = value;
    }
  }

  async delete(id: string): Promise<void> {
    const row = this.byId.get(id);
    if (row === undefined) return;
    this.byId.delete(id);
    const table = id.slice(0, id.lastIndexOf("_"));
    const rows = this.rowsOf(table);
    rows.splice(rows.indexOf(row), 1);
  }

  query(table: string) {
    const rows = this.rowsOf(table);
    const record = (index: string, constraints: Constraint[]) => {
      this.reads.push({ table, index, constraints });
    };
    /**
     * A read with no index at all — a table scan, which Convex allows and
     * this codebase almost never does.
     *
     * It is here for `scoutEval.questions`, whose "every lab on this
     * deployment" read has no index to go through and is bounded by a `take`
     * instead. Recorded under its own name so a test can still assert that a
     * *product* read went through the index it claims to.
     */
    const scan = () => {
      record("(table scan)", []);
      return new FakeQuery(rows, [], false, false);
    };
    return {
      take: (count: number) => scan().take(count),
      collect: () => scan().collect(),
      first: () => scan().first(),
      order: (direction: "asc" | "desc") => scan().order(direction),
      withIndex: (
        index: string,
        build?: (q: ConstraintBuilder) => ConstraintBuilder,
      ) => {
        const constraints: Constraint[] = [];
        build?.(new ConstraintBuilder(constraints));
        record(index, constraints);
        return new FakeQuery(rows, constraints, false, false);
      },
      withSearchIndex: (
        index: string,
        build: (q: ConstraintBuilder) => ConstraintBuilder,
      ) => {
        const constraints: Constraint[] = [];
        build(new ConstraintBuilder(constraints));
        record(index, constraints);
        return new FakeQuery(rows, constraints, false, this.hostileSearchIndex);
      },
    };
  }

  /** Everything currently in one table, for assertions. */
  all<T extends TableNames>(table: T): Doc<T>[] {
    return [...this.rowsOf(table)] as unknown as Doc<T>[];
  }

  /** The constraints a named index was last read with. */
  lastReadOf(index: string): IndexRead | undefined {
    return [...this.reads].reverse().find((read) => read.index === index);
  }
}

/* -------------------------------------------------------------------------
 * The context
 * ---------------------------------------------------------------------- */

export type ScheduledCall = { name: string; args: unknown };

/**
 * A `ctx` good enough for this module: a database, a scheduler that records
 * rather than runs, and the `runQuery`/`runMutation` pair an action needs.
 *
 * The dispatch table is keyed by the Convex function *name*, so a test drives
 * `internal.delegations.run` through exactly the references the production
 * code holds — no parallel wiring that could agree with itself while
 * disagreeing with the app.
 */
export class FakeCtx {
  readonly db = new FakeDb();
  readonly scheduled: ScheduledCall[] = [];
  private readonly dispatch = new Map<string, Handler>();
  /** Set to impersonate a signed-in member; `requireUserId` is not used here. */
  auth: { userId?: string } = {};

  register(reference: unknown, registered: unknown): this {
    this.dispatch.set(
      getFunctionName(reference as Parameters<typeof getFunctionName>[0]),
      handlerOf(registered),
    );
    return this;
  }

  readonly scheduler = {
    runAfter: async (_delay: number, reference: unknown, args: unknown) => {
      this.scheduled.push({
        name: getFunctionName(
          reference as Parameters<typeof getFunctionName>[0],
        ),
        args,
      });
      return "job" as unknown;
    },
    runAt: async () => "job" as unknown,
    cancel: async () => undefined,
  };

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

  private async call(reference: unknown, args: unknown): Promise<unknown> {
    const name = getFunctionName(
      reference as Parameters<typeof getFunctionName>[0],
    );
    const handler = this.dispatch.get(name);
    if (handler === undefined) {
      throw new Error(`test ctx has no handler registered for ${name}`);
    }
    return await handler(this, args as never);
  }

  runQuery = (reference: unknown, args: unknown) => this.call(reference, args);
  runMutation = (reference: unknown, args: unknown) =>
    this.call(reference, args);
  runAction = (reference: unknown, args: unknown) => this.call(reference, args);
}

/* -------------------------------------------------------------------------
 * The model
 * ---------------------------------------------------------------------- */

const MATERIAL_MARKER = "MATERIAL (JSON):\n";

/**
 * A model that reads its prompt and cites everything it was shown.
 *
 * The offline stand-in for `internal.delegations.callScoutModel`, registered
 * against the real reference so the suites drive the whole run — claim,
 * gather, the privacy gate, the prompt, the citation gate, the store — and
 * fake only the network.
 *
 * It parses the prompt's own JSON payload rather than being handed the
 * material out of band, which is both what a model does and what makes it a
 * fixture that cannot pass while the prompt is broken. It cites rather than
 * paraphrases: a stub that invented prose could clear the citation gate while
 * saying something about notes it had not read, and a fixture that lies is
 * worse than none.
 *
 * It answers per question, out of `questions[].labels` rather than out of the
 * shared `annotations` layout — the batch prompt gives every question the same
 * vocabulary and a different subset of it to use, and a fixture that cited the
 * whole layout would be a fixture that cannot fail the per-question gate. A
 * stand-in that could only pass is not a stand-in.
 */
export function fakeScoutModel(prompt: string): {
  ok: true;
  text: string;
  model: string;
} {
  const at = prompt.indexOf(MATERIAL_MARKER);
  if (at === -1) {
    throw new Error(
      "The scout prompt no longer carries a `MATERIAL (JSON):` payload; the fake model cannot read what the real one is shown.",
    );
  }
  const payload = JSON.parse(prompt.slice(at + MATERIAL_MARKER.length)) as {
    questions: { ref: string; labels: string[] }[];
  };
  return {
    ok: true,
    model: STUB_MODEL,
    text: JSON.stringify({
      answers: payload.questions.map((one) => ({
        ref: one.ref,
        items: one.labels.map((label) => ({
          text: `The lab has written on this before [${label}].`,
          citations: [label],
        })),
      })),
    }),
  };
}

/** Register it, and hand back the log of what the run asked the model. */
export function registerFakeScoutModel(
  ctx: FakeCtx,
  options: { modelFailure?: DelegationModelFailure } = {},
): { prompt: string }[] {
  const calls: { prompt: string }[] = [];
  ctx.register(internal.delegations.callScoutModel, {
    // Annotated, because `register`/`handlerOf` go through `unknown` and erase
    // every type on the way: a fixture that drifted from the seam's contract
    // would typecheck happily and fail as a puzzle at runtime. This is the one
    // place the two shapes can still be held together.
    _handler: (_ctx: unknown, args: { prompt: string }): ScoutModelResult => {
      calls.push({ prompt: args.prompt });
      return options.modelFailure === undefined
        ? fakeScoutModel(args.prompt)
        : { ok: false, failure: options.modelFailure };
    },
  });
  return calls;
}

/* -------------------------------------------------------------------------
 * Rows
 * ---------------------------------------------------------------------- */

/**
 * A minimal lab: one lab, one PI, one member, one paper, one scheduled
 * session, and the two shapes of open question the scout can be pointed at —
 * an `open-question` annotation (v1's subject, the one a brief carries
 * forward) and an `actions` row of kind `question` (the outcomes panel's).
 *
 * Every test in the suite starts from the same world so a failure is about
 * the transition under test.
 */
export async function seedLab(ctx: FakeCtx) {
  const pi = await ctx.db.insert("users", { name: "Ana Ruiz" });
  const member = await ctx.db.insert("users", { name: "Ben Okafor" });
  const labId = await ctx.db.insert("labs", {
    name: "Ruiz Lab",
    createdBy: pi,
    memberCount: 2,
  });
  await ctx.db.insert("memberships", {
    labId,
    userId: pi,
    role: "pi",
    joinedAt: 1,
  });
  await ctx.db.insert("memberships", {
    labId,
    userId: member,
    role: "member",
    joinedAt: 1,
  });
  const paperId = await ctx.db.insert("papers", {
    labId,
    title: "Cold-chain effects on assay reproducibility",
    addedBy: pi,
    ingestStatus: "ready",
  });
  const sessionId = await ctx.db.insert("sessions", {
    labId,
    paperId,
    presenterId: pi,
    scheduledAt: 1,
    status: "scheduled",
    createdBy: pi,
  });
  const actionId = await ctx.db.insert("actions", {
    labId,
    sessionId,
    paperId,
    kind: "question",
    body: "Does the 4°C incubation step explain the reproducibility gap between the two cohorts?",
    recordedBy: pi,
  });
  const questionId = await ctx.db.insert("annotations", {
    labId,
    paperId,
    sessionId,
    memberId: pi,
    anchor: {
      quote: "incubated at 4°C overnight",
      prefix: "",
      suffix: "",
      start: 0,
      end: 26,
      pageIndex: 3,
    },
    type: "open-question",
    body: "Does the 4°C incubation step explain the reproducibility gap between the two cohorts?",
    visibility: "lab",
  });
  return { pi, member, labId, paperId, sessionId, actionId, questionId };
}

/** One annotation, lab-visible unless told otherwise. */
export async function seedAnnotation(
  ctx: FakeCtx,
  seed: { labId: Id<"labs">; paperId: Id<"papers">; memberId: Id<"users"> },
  overrides: Partial<{
    body: string;
    visibility: "private" | "lab";
    deletedAt: number;
    type: string;
    labId: Id<"labs">;
    paperId: Id<"papers">;
    /** The passage it sits on — what a cross-paper pairing is made of. */
    quote: string;
    /** The meeting it was written under — what makes a note carriable forward. */
    sessionId: Id<"sessions">;
  }> = {},
): Promise<Id<"annotations">> {
  return await ctx.db.insert("annotations", {
    labId: overrides.labId ?? seed.labId,
    paperId: overrides.paperId ?? seed.paperId,
    sessionId: overrides.sessionId,
    memberId: seed.memberId,
    anchor: {
      quote: overrides.quote ?? "incubation at 4°C",
      prefix: "",
      suffix: "",
      start: 0,
      end: 17,
      pageIndex: 2,
    },
    type: overrides.type ?? "open-question",
    body: overrides.body ?? "The 4°C incubation looks like the difference.",
    visibility: overrides.visibility ?? "lab",
    deletedAt: overrides.deletedAt,
  });
}
