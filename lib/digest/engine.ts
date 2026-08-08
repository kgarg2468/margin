/**
 * The collision-digest engine: `digest_gold5`, as pure functions.
 *
 * Everything in this file is deliberately ctx-free — no Convex, no database,
 * no clock. The Convex layer (`convex/digests.ts`) does the reading, the
 * authorization and the writing; this module does the thinking, so the policy
 * that the KCP simulation validated can be unit-tested directly against the
 * shapes it was validated on.
 *
 * The policy, from `.context/experiments/kcp-sim/RESULTS.md`:
 *
 * 1. Collision detection is **deterministic** — a hand-written type-pair
 *    matrix over overlapping passage anchors. No model is involved, so a
 *    digest cannot hallucinate a connection that isn't in the data.
 * 2. Detection is at **passage** granularity. Paper-level co-annotation was
 *    measured at 6–12% precision and is not used.
 * 3. Gold pairs are promoted to individual, passage-addressed lines — but
 *    **recipient-relative**: only when the recipient authored one of the two
 *    colliding annotations, which is the sim's definition of a gold *event*
 *    (RESULTS.md §4). A collision between two other members is real, but it is
 *    news about the lab rather than news about you, so it coalesces.
 *    Everything else coalesces to **one line per paper**.
 * 4. **Hard cap of five items.** The simulation put gold retention at
 *    99.7–100% at that cap, which is the whole argument for it: the cap costs
 *    essentially no signal and buys a digest a person will actually read.
 */

/** The 7-type annotation ontology, mirroring `annotationType` in the schema. */
export type AnnotationType =
  | "note"
  | "hypothesis"
  | "method-note"
  | "critique"
  | "definition"
  | "connection-to-own-work"
  | "open-question";

/**
 * One annotation, flattened to the fields the policy actually reads.
 *
 * Generic over the id types so the Convex layer can pass branded `Id<"...">`
 * values straight through and get branded ids back out, while tests pass
 * plain strings.
 */
export type DigestAnnotation<
  PaperId extends string = string,
  AnnotationId extends string = string,
  UserId extends string = string,
> = {
  id: AnnotationId;
  paperId: PaperId;
  memberId: UserId;
  /** Display name of the author, already resolved. "Someone" if unknown. */
  memberName: string;
  type: AnnotationType;
  pageIndex: number;
  start: number;
  end: number;
  quote: string;
  createdAt: number;
};

/** A fired cell of the type-pair matrix, over two specific annotations. */
export type Collision<
  PaperId extends string = string,
  AnnotationId extends string = string,
  UserId extends string = string,
> = {
  a: DigestAnnotation<PaperId, AnnotationId, UserId>;
  b: DigestAnnotation<PaperId, AnnotationId, UserId>;
  /** The matrix cell, as `"<type> x <type>"` with the two types sorted. */
  pairType: string;
  /** The semantics of that cell, e.g. `"contradiction"`. */
  label: GoldLabel;
  /** Why the two anchors are the same passage. */
  overlap: "range" | "quote";
};

/** A row of `digests.items`, in the schema's exact shape. */
export type DigestItem<
  PaperId extends string = string,
  AnnotationId extends string = string,
> = {
  kind: "collision" | "coalesced";
  paperId: PaperId;
  annotationIds: AnnotationId[];
  pairType?: string;
  line: string;
};

export type GoldLabel =
  | "convergent theorizing"
  | "contradiction"
  | "possible answer"
  | "project collision"
  | "method available";

/**
 * The type-pair matrix. Keys are `"<type> x <type>"` with the two types sorted
 * lexicographically, so lookup is order-free and the stored `pairType` is
 * stable no matter which annotation was written first.
 *
 * Only these five cells are gold. Every other combination — including the
 * large majority that involve an untyped `note` — is a real co-annotation but
 * not one worth interrupting someone for, so it flows into the coalesced line
 * for its paper instead of getting a line of its own.
 */
export const GOLD_PAIRS: Readonly<Record<string, GoldLabel>> = {
  "hypothesis x hypothesis": "convergent theorizing",
  "critique x hypothesis": "contradiction",
  "definition x open-question": "possible answer",
  "connection-to-own-work x connection-to-own-work": "project collision",
  "hypothesis x method-note": "method available",
};

/** The sim-validated cap. Five items, then the rest is a number. */
export const MAX_DIGEST_ITEMS = 5;

/** Longest quote we will inline in a digest line before eliding. */
const MAX_QUOTE_CHARS = 100;

/**
 * Shortest quote that may stand in for a passage anchor on its own.
 *
 * The identical-quote fallback exists for one case: the same sentence at
 * different offsets because two members are reading different PDFs of the same
 * paper. Short selections are not that case — "the model", "Figure 3", "n = 40"
 * recur all over a paper and across pages, and treating two of them as the same
 * passage manufactures collisions out of coincidence. Twenty characters is
 * roughly a clause: long enough that an exact match is evidence.
 */
const MIN_QUOTE_MATCH_CHARS = 20;

/** Canonical matrix key for two types, order-free. */
export function pairKey(a: AnnotationType, b: AnnotationType): string {
  return a <= b ? `${a} x ${b}` : `${b} x ${a}`;
}

/**
 * Do two annotations sit on the same passage?
 *
 * Two ways to qualify, both cheap and both deterministic:
 *
 * - **range** — same paper, same page, and half-open `[start, end)` character
 *   ranges that intersect. Touching endpoints do not count; two people who
 *   highlighted adjacent sentences did not highlight the same sentence.
 * - **quote** — same paper and byte-identical selected text, of at least
 *   `MIN_QUOTE_MATCH_CHARS`. This is the escape hatch for the case the
 *   redundant anchor exists for: the same sentence at different offsets,
 *   because one member is reading the preprint and the other the published
 *   PDF. The length floor is what keeps it from firing on a two-word selection
 *   that happens to recur.
 *
 * Returns `null` when they are not the same passage.
 */
export function anchorOverlap(
  a: DigestAnnotation,
  b: DigestAnnotation,
): "range" | "quote" | null {
  if (a.paperId !== b.paperId) return null;
  if (
    a.pageIndex === b.pageIndex &&
    a.start < b.end &&
    b.start < a.end &&
    a.start !== a.end &&
    b.start !== b.end
  ) {
    return "range";
  }
  const quote = a.quote.trim();
  if (quote.length >= MIN_QUOTE_MATCH_CHARS && quote === b.quote.trim()) {
    return "quote";
  }
  return null;
}

/**
 * Deterministic collision order: newest collision first, id as the tiebreak.
 *
 * Shared by `detectCollisions` and `assembleDigest` so that a precomputed list
 * handed in from the Convex layer is ranked exactly the same way as one the
 * engine detected itself. Order decides which gold lines survive the cap, so it
 * is not allowed to depend on where the list came from.
 */
function byRecency(x: Collision, y: Collision): number {
  const yAt = Math.max(y.a.createdAt, y.b.createdAt);
  const xAt = Math.max(x.a.createdAt, x.b.createdAt);
  if (yAt !== xAt) return yAt - xAt;
  if (x.a.id !== y.a.id) return x.a.id < y.a.id ? -1 : 1;
  return x.b.id < y.b.id ? -1 : x.b.id > y.b.id ? 1 : 0;
}

/**
 * Every gold collision in a pool of annotations.
 *
 * O(n²) on purpose: the pool is one paper's lab-visible annotations, which is
 * tens of rows, not thousands. Pairs where both annotations have the same
 * author are skipped — noticing that you annotated the same passage twice is
 * not a collision, it is a memory.
 *
 * The result is sorted deterministically (newest collision first, ties broken
 * by id) so the same input always produces the same digest.
 */
export function detectCollisions<
  P extends string,
  A extends string,
  U extends string,
>(
  pool: readonly DigestAnnotation<P, A, U>[],
): Collision<P, A, U>[] {
  const collisions: Collision<P, A, U>[] = [];
  for (let i = 0; i < pool.length; i++) {
    const first = pool[i];
    if (first === undefined) continue;
    for (let j = i + 1; j < pool.length; j++) {
      const second = pool[j];
      if (second === undefined) continue;
      if (first.memberId === second.memberId) continue;
      const label = GOLD_PAIRS[pairKey(first.type, second.type)];
      if (label === undefined) continue;
      const overlap = anchorOverlap(first, second);
      if (overlap === null) continue;
      // Canonical order: older annotation first, id as the tiebreak.
      const [a, b] =
        first.createdAt < second.createdAt ||
        (first.createdAt === second.createdAt && first.id <= second.id)
          ? [first, second]
          : [second, first];
      collisions.push({
        a,
        b,
        pairType: pairKey(a.type, b.type),
        label,
        overlap,
      });
    }
  }
  collisions.sort(byRecency);
  return collisions;
}

const SINGULAR: Readonly<Record<AnnotationType, string>> = {
  note: "note",
  hypothesis: "hypothesis",
  "method-note": "method note",
  critique: "critique",
  definition: "definition",
  "connection-to-own-work": "connection to own work",
  "open-question": "open question",
};

const PLURAL: Readonly<Record<AnnotationType, string>> = {
  note: "notes",
  hypothesis: "hypotheses",
  "method-note": "method notes",
  critique: "critiques",
  definition: "definitions",
  "connection-to-own-work": "connections to own work",
  "open-question": "open questions",
};

/** Fixed ontology order, used to break ties in the coalesced type summary. */
const TYPE_ORDER: readonly AnnotationType[] = [
  "hypothesis",
  "critique",
  "open-question",
  "connection-to-own-work",
  "method-note",
  "definition",
  "note",
];

function elide(quote: string): string {
  const trimmed = quote.trim().replace(/\s+/g, " ");
  if (trimmed.length <= MAX_QUOTE_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_QUOTE_CHARS - 1).trimEnd()}…`;
}

function label(annotation: DigestAnnotation, recipientId: string): string {
  return annotation.memberId === recipientId ? "You" : annotation.memberName;
}

function lower(name: string): string {
  return name === "You" ? "you" : name;
}

/**
 * The sentence for a gold collision, addressed to one recipient.
 *
 * Written from the recipient's side: when they are one of the two authors the
 * line says "you", because "Ben critiqued the passage you hypothesised about"
 * is the reason this product exists and "Ben critiqued the passage Ana
 * hypothesised about" is a newsletter.
 */
export function collisionLine(
  collision: Collision,
  recipientId: string,
  paperTitle: string,
): string {
  const { a, b, label: semantics } = collision;
  // Put the recipient first in symmetric phrasings.
  const [first, second] = b.memberId === recipientId ? [b, a] : [a, b];
  const firstName = label(first, recipientId);
  const secondName = lower(label(second, recipientId));

  const byType = (type: AnnotationType): DigestAnnotation =>
    a.type === type ? a : b;

  let phrase: string;
  switch (semantics) {
    case "convergent theorizing":
      phrase = `${firstName} and ${secondName} both left a hypothesis on the same passage`;
      break;
    case "project collision":
      phrase = `${firstName} and ${secondName} both connected the same passage to their own work`;
      break;
    case "contradiction": {
      const critic = byType("critique");
      const hypothesis = byType("hypothesis");
      phrase = `${label(critic, recipientId)} critiqued the passage ${lower(
        label(hypothesis, recipientId),
      )} hypothesised about`;
      break;
    }
    case "possible answer": {
      const definition = byType("definition");
      const question = byType("open-question");
      phrase = `${label(definition, recipientId)} defined a term on the passage ${lower(
        label(question, recipientId),
      )} left an open question on`;
      break;
    }
    case "method available": {
      const method = byType("method-note");
      const hypothesis = byType("hypothesis");
      phrase = `${label(method, recipientId)} noted a method on the passage ${lower(
        label(hypothesis, recipientId),
      )} hypothesised about`;
      break;
    }
  }

  // Cite the page the recipient will recognize. When the two anchors are on
  // different pages — the identical-quote fallback across a preprint and a
  // published PDF — "p. 7" has to mean the page in *their* copy, or the line
  // sends them somewhere they have never been. Only a third-party collision,
  // which `assembleDigest` no longer promotes, has no recipient side to use.
  const mine =
    a.memberId === recipientId ? a : b.memberId === recipientId ? b : undefined;
  const page = (mine?.pageIndex ?? Math.max(a.pageIndex, b.pageIndex)) + 1;
  const quote = elide(a.quote.length >= b.quote.length ? a.quote : b.quote);
  const where = `${paperTitle}, p. ${page}`;
  return quote.length > 0
    ? `${phrase} — ${where}: “${quote}”`
    : `${phrase} — ${where}`;
}

/**
 * The one-line-per-paper summary of everything that wasn't gold.
 *
 * Note the framing, which the privacy constitution fixes: this is a count of
 * what is new *since you last looked*. It never names who has or hasn't read
 * anything, and there is no way to phrase it that would.
 */
export function coalescedLine(
  annotations: readonly DigestAnnotation[],
  paperTitle: string,
): string {
  const counts = new Map<AnnotationType, number>();
  const members = new Set<string>();
  for (const annotation of annotations) {
    counts.set(annotation.type, (counts.get(annotation.type) ?? 0) + 1);
    members.add(annotation.memberId);
  }
  const total = annotations.length;
  const breakdown = [...counts.entries()]
    .sort((x, y) => {
      if (y[1] !== x[1]) return y[1] - x[1];
      return TYPE_ORDER.indexOf(x[0]) - TYPE_ORDER.indexOf(y[0]);
    })
    .map(([type, count]) =>
      count === 1 ? `1 ${SINGULAR[type]}` : `${count} ${PLURAL[type]}`,
    )
    .join(", ");
  const noun = total === 1 ? "annotation" : "annotations";
  const who =
    members.size === 1 ? "1 member" : `${members.size} members`;
  return `${total} new ${noun} on ${paperTitle} from ${who} — ${breakdown}`;
}

export type AssembledDigest<
  PaperId extends string = string,
  AnnotationId extends string = string,
> = {
  items: DigestItem<PaperId, AnnotationId>[];
  /**
   * Annotations the cap kept out of this digest — the underlying rows, not the
   * lines they would have occupied, because one dropped coalesced line can be
   * hiding a dozen annotations and "and 1 more" would be a lie.
   */
  droppedCount: number;
};

/**
 * `digest_gold5`: turn one recipient's delta into at most five lines.
 *
 * - `pool` is every lab-visible, non-deleted annotation on the papers in play,
 *   including the recipient's own. Collisions are detected across the whole
 *   pool because the interesting case is somebody landing on *your* passage.
 * - `delta` is the subset that is new to this recipient — authored by someone
 *   else, after their cursor. Only a delta annotation can cause an item; the
 *   recipient's own annotation can only ever be the other half of a pair.
 * - `collisions`, when supplied, is a precomputed `detectCollisions(pool)`.
 *   The Convex layer runs one detection pass for a whole lab rather than one
 *   per member; the engine stays pure either way, and the default keeps the
 *   single-argument call honest.
 *
 * Promotion is **recipient-relative**: a gold pair earns its own line only when
 * the recipient wrote one half of it. A collision between two other members is
 * a real convergence in the lab, but the sim counted gold *events* per
 * recipient (RESULTS.md §4), and "Ana and Ben both hypothesised about p. 7" is
 * a newsletter item — it goes into the coalesced count for its paper, where a
 * bystander's five items of budget are not spent on it.
 *
 * Each new annotation contributes to at most one gold line, so five different
 * people colliding with one of your hypotheses reads as five lines, but one
 * annotation colliding with five things does not.
 */
export function assembleDigest<
  P extends string,
  A extends string,
  U extends string,
>(input: {
  recipientId: U;
  pool: readonly DigestAnnotation<P, A, U>[];
  delta: readonly DigestAnnotation<P, A, U>[];
  /** `paperId` → display title. Missing titles fall back to "this paper". */
  paperTitles: ReadonlyMap<P, string>;
  /** `detectCollisions(pool)`, if the caller already has it. */
  collisions?: readonly Collision<P, A, U>[];
  cap?: number;
}): AssembledDigest<P, A> {
  const cap = input.cap ?? MAX_DIGEST_ITEMS;
  const deltaIds = new Set<A>(input.delta.map((a) => a.id));
  const titleOf = (paperId: P): string =>
    input.paperTitles.get(paperId) ?? "this paper";

  const promoted = new Set<A>();
  const goldItems: DigestItem<P, A>[] = [];

  // Re-sorted rather than trusted: a precomputed list must rank identically to
  // a detected one, because this order is what the cap cuts against.
  const candidates = (input.collisions ?? detectCollisions(input.pool))
    .filter(
      (c) =>
        c.a.memberId === input.recipientId || c.b.memberId === input.recipientId,
    )
    .sort(byRecency);

  for (const collision of candidates) {
    const fresh = [collision.a, collision.b].filter((x) => deltaIds.has(x.id));
    if (fresh.length === 0) continue;
    if (fresh.some((x) => promoted.has(x.id))) continue;
    for (const x of fresh) promoted.add(x.id);
    goldItems.push({
      kind: "collision",
      paperId: collision.a.paperId,
      annotationIds: [collision.a.id, collision.b.id],
      pairType: collision.pairType,
      line: collisionLine(
        collision,
        input.recipientId,
        titleOf(collision.a.paperId),
      ),
    });
  }

  const byPaper = new Map<P, DigestAnnotation<P, A, U>[]>();
  for (const annotation of input.delta) {
    if (promoted.has(annotation.id)) continue;
    const bucket = byPaper.get(annotation.paperId);
    if (bucket === undefined) byPaper.set(annotation.paperId, [annotation]);
    else bucket.push(annotation);
  }

  const coalesced: DigestItem<P, A>[] = [...byPaper.entries()]
    .sort((x, y) => {
      const newest = (list: DigestAnnotation<P, A, U>[]) =>
        list.reduce((max, a) => Math.max(max, a.createdAt), 0);
      const diff = newest(y[1]) - newest(x[1]);
      return diff !== 0 ? diff : x[0] < y[0] ? -1 : 1;
    })
    .map(([paperId, annotations]) => ({
      kind: "coalesced" as const,
      paperId,
      annotationIds: annotations.map((a) => a.id),
      line: coalescedLine(annotations, titleOf(paperId)),
    }));

  const all = [...goldItems, ...coalesced];
  // Count the annotations behind the lines that didn't fit, not the lines.
  // Only delta rows count: a promoted collision cites the recipient's own
  // annotation as its other half, and their own writing was never news to them.
  const withheld = new Set<A>();
  for (const item of all.slice(cap)) {
    for (const id of item.annotationIds) {
      if (deltaIds.has(id)) withheld.add(id);
    }
  }
  return {
    items: all.slice(0, cap),
    droppedCount: withheld.size,
  };
}
