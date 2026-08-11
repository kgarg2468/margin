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
 *
 * ## The cross-paper extension (Phase 2)
 *
 * The four rules above are the policy the simulation validated, and they are
 * all *within one paper*. `detectCrossPaperCollisions` adds a second, opt-in
 * detector for the pair the simulation never had a shape for: two members
 * arguing about the same claim in two different papers. It is deliberately a
 * separate function rather than a flag on `detectCollisions`, because every
 * existing caller — the digest producer, the presenter's brief — is asking a
 * one-paper question and must keep getting the one-paper answer.
 *
 * Three things keep the extension from cheapening the digest:
 *
 * - It runs on **quote identity only**. Character offsets mean nothing across
 *   two documents, so the sole deterministic signal available is that two
 *   members selected the same words — held to a much longer floor than the
 *   within-paper fallback (`MIN_CROSS_PAPER_QUOTE_CHARS`), because a paper is
 *   context that a cross-paper match does not have.
 * - It **ranks below** every same-paper collision of the same kind. A same
 *   passage in the same paper is a tighter fact than the same sentence quoted
 *   in two places, so it wins the cap first, always.
 * - Its scan is **capped and the cap is reported** (`CrossPaperScan.capped`),
 *   because a pool spanning several papers can hold a pathological group of
 *   identical selections and quietly returning half an answer is the one thing
 *   this file is not allowed to do.
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
  /**
   * The paper this line is filed under — and, for a collision, the paper the
   * *recipient* has their own annotation in.
   *
   * That side is chosen on purpose. It is the paper the reader has actually
   * opened, so it is the one a "read the passage" link can land in without
   * dropping them somewhere they have never been, and it is the one whose
   * cursor an acknowledgement may honestly advance. A cross-paper line names
   * the other paper (`otherPaperId`, and both titles in `line`) but does not
   * claim the reader has caught up on it.
   */
  paperId: PaperId;
  /**
   * The far side of a cross-paper collision. Absent on every other item —
   * coalesced lines and same-paper collisions have one paper and only one.
   */
  otherPaperId?: PaperId;
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

/**
 * Shortest selection that may link two *different* papers.
 *
 * Three times the within-paper floor, and the multiple is the whole argument.
 * Inside one paper, twenty characters is enough because the paper itself is
 * the context: two members are demonstrably reading the same document, and the
 * quote only has to identify a sentence within it. Across two papers there is
 * no shared context at all — the string has to carry the claim on its own, and
 * short-to-middling sentences recur across a literature by construction
 * ("data are presented as mean ± SD"). Sixty characters is a full sentence of
 * substance rather than a phrase.
 *
 * It is a floor, not a guarantee: a long enough piece of methods boilerplate
 * can still clear it. That is why a cross-paper pair also has to be a gold
 * type pair between two different members, and why it ranks below every
 * same-paper pair — the failure mode is one soft line at the bottom of a
 * digest, not a tight fact displaced by a coincidence.
 */
export const MIN_CROSS_PAPER_QUOTE_CHARS = 60;

/**
 * Ceiling on how many candidate pairs one cross-paper scan will compare.
 *
 * The scan is not the naive quadratic — annotations are grouped by their
 * normalized selection first, and only groups that actually span two papers
 * are compared at all, so a realistic lab's scan is dozens of comparisons over
 * a pool where the blind version would be half a million. The cap is for the
 * shape that defeats the grouping: one boilerplate sentence selected by fifty
 * members across ten papers is a single group of five hundred rows and a
 * hundred-odd thousand comparisons on its own.
 *
 * When it bites, the scan stops and says so (`CrossPaperScan.capped`). It
 * never returns a short answer as though it were a complete one — the same
 * rule `assembleDigest` follows when the item cap cuts a line and it reports
 * `droppedCount` rather than pretending five was all there was.
 */
export const MAX_CROSS_PAPER_COMPARISONS = 5000;

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
 * The comparable form of a selection, or `null` if it is too slight to link
 * two papers with.
 *
 * Normalization is the minimum that survives being printed twice: whitespace
 * collapsed, case folded, and leading/trailing punctuation dropped. Those three
 * differences are typesetting — a sentence that starts a paragraph in one paper
 * and follows a colon in the other, a selection that swept up the full stop and
 * one that stopped short of it — and treating them as different claims would
 * mean the feature only ever fires on two people who dragged their cursors
 * identically. Nothing beyond that is normalized: no stemming, no stopword
 * stripping, no fuzzy distance. The promise this file makes is that a digest
 * cannot assert a connection that is not literally in the data, and every
 * loosening is a chance to break it.
 */
function claimKey(quote: string): string | null {
  const normalized = quote
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  return normalized.length >= MIN_CROSS_PAPER_QUOTE_CHARS ? normalized : null;
}

/**
 * Do two annotations in *different* papers sit on the same claim?
 *
 * The mirror of `anchorOverlap` for the case that function refuses by design.
 * There is no range arm here and there cannot be one: `start` and `end` are
 * offsets into one document's text, and two documents' offsets have nothing to
 * say to each other. Same paper returns `null` — that question belongs to
 * `anchorOverlap`, and answering it in both places is how two detectors start
 * disagreeing.
 */
export function crossPaperOverlap(
  a: DigestAnnotation,
  b: DigestAnnotation,
): "quote" | null {
  if (a.paperId === b.paperId) return null;
  const key = claimKey(a.quote);
  return key !== null && key === claimKey(b.quote) ? "quote" : null;
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

/** Are the two halves of this collision in different papers? */
function isCrossPaper(collision: Collision): boolean {
  return collision.a.paperId !== collision.b.paperId;
}

/**
 * The full ranking: every same-paper collision, then every cross-paper one,
 * each tier newest-first by `byRecency`.
 *
 * Scope outranks recency rather than merely breaking its ties, and that is a
 * deliberate reading of "a same-paper collision is a tighter fact". A tie on
 * `createdAt` is a millisecond coincidence that essentially never happens, so a
 * rule that only fired on one would be decoration. What the tier actually buys
 * is that the five lines can never fill up with quote matches while a member's
 * own passage sits under somebody's critique unmentioned.
 *
 * It costs less than it looks like it should. Only a pair containing a *fresh*
 * annotation can become an item at all (`assembleDigest` promotes nothing that
 * is not in the delta), so the same-paper tier is not a backlog of old news
 * queue-jumping — it is this week's tight facts ahead of this week's soft ones.
 *
 * For a single-paper pool — a session's prep, a presenter's brief — every
 * collision is in the same tier and this is exactly `byRecency`.
 */
function byPairRank(x: Collision, y: Collision): number {
  const xCross = isCrossPaper(x) ? 1 : 0;
  const yCross = isCrossPaper(y) ? 1 : 0;
  if (xCross !== yCross) return xCross - yCross;
  return byRecency(x, y);
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

/**
 * What one cross-paper scan found, and whether it got to look at everything.
 *
 * `capped` is the honesty half and the reason this is an object rather than an
 * array: a partial scan and a complete one produce the same *kind* of answer,
 * and a caller that cannot tell them apart will present a bounded guess as a
 * finished search.
 */
export type CrossPaperScan<
  PaperId extends string = string,
  AnnotationId extends string = string,
  UserId extends string = string,
> = {
  /** Gold pairs spanning two papers, ranked by `byPairRank`. */
  collisions: Collision<PaperId, AnnotationId, UserId>[];
  /** How many candidate pairs were actually compared. */
  comparisons: number;
  /** True when the comparison cap stopped the scan before the candidates ran out. */
  capped: boolean;
};

/**
 * Every gold collision that spans two papers in the same lab.
 *
 * **Precondition, and it is the privacy one:** `pool` must already be the
 * lab-visible, non-deleted annotations of papers in a single lab, exactly as
 * `convex/digests.ts` builds it. This function pairs whatever it is handed;
 * nothing in the annotation shape carries a lab or a visibility, so the read
 * that produced the pool is the only thing that can enforce either — which is
 * why that read is pinned to `by_paper_and_visibility` at `"lab"` and every
 * paper's `labId` is re-checked before its rows join the pool.
 *
 * Not the naive quadratic. Annotations are grouped by `claimKey` first and
 * only groups that span more than one paper are compared, which is what makes
 * the interesting case (a handful of shared sentences) cost a handful of
 * comparisons in a pool of a thousand rows. `limit` bounds what is left: the
 * group of identical boilerplate that grouping cannot help with.
 *
 * Determinism does not depend on the order the pool arrives in. Groups are
 * ranked freshest-first with the key as the tiebreak, rows within a group are
 * ranked newest-first with the id as the tiebreak, and the cap therefore cuts
 * the *oldest* candidates rather than whichever ones the database happened to
 * return last.
 */
export function detectCrossPaperCollisions<
  P extends string,
  A extends string,
  U extends string,
>(
  pool: readonly DigestAnnotation<P, A, U>[],
  limit: number = MAX_CROSS_PAPER_COMPARISONS,
): CrossPaperScan<P, A, U> {
  const groups = new Map<string, DigestAnnotation<P, A, U>[]>();
  for (const annotation of pool) {
    const key = claimKey(annotation.quote);
    if (key === null) continue;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [annotation]);
    else bucket.push(annotation);
  }

  const newestIn = (rows: readonly DigestAnnotation<P, A, U>[]): number =>
    rows.reduce((max, row) => Math.max(max, row.createdAt), 0);

  const candidates = [...groups.entries()]
    // A group confined to one paper is `anchorOverlap`'s business, not this
    // function's, and comparing it would spend budget to rediscover pairs
    // `detectCollisions` has already found.
    .filter(([, rows]) => new Set(rows.map((row) => row.paperId)).size > 1)
    .sort((x, y) => {
      const diff = newestIn(y[1]) - newestIn(x[1]);
      return diff !== 0 ? diff : x[0] < y[0] ? -1 : 1;
    });

  const collisions: Collision<P, A, U>[] = [];
  let comparisons = 0;
  let capped = false;

  scan: for (const [, rows] of candidates) {
    const ranked = [...rows].sort((x, y) =>
      y.createdAt !== x.createdAt
        ? y.createdAt - x.createdAt
        : x.id < y.id
          ? -1
          : x.id > y.id
            ? 1
            : 0,
    );
    for (let i = 0; i < ranked.length; i++) {
      const first = ranked[i];
      if (first === undefined) continue;
      for (let j = i + 1; j < ranked.length; j++) {
        const second = ranked[j];
        if (second === undefined) continue;
        if (comparisons >= limit) {
          capped = true;
          break scan;
        }
        comparisons += 1;
        // Same paper inside a mixed group: already `detectCollisions`'s.
        if (first.paperId === second.paperId) continue;
        if (first.memberId === second.memberId) continue;
        const label = GOLD_PAIRS[pairKey(first.type, second.type)];
        if (label === undefined) continue;
        // Canonical order: older annotation first, id as the tiebreak — the
        // same rule `detectCollisions` uses, so a stored pair reads the same
        // way whichever detector found it.
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
          overlap: "quote",
        });
      }
    }
  }

  collisions.sort(byPairRank);
  return { collisions, comparisons, capped };
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
 *
 * `paperTitle` is the title of `collision.a`'s paper. `otherPaperTitle` is
 * `collision.b`'s, and passing it is what turns this into a cross-paper line —
 * omit it and a cross-paper pair would be printed as though both halves were
 * in one document, which is the one thing a reader must never have to guess
 * about. It is ignored when the two halves share a paper.
 */
export function collisionLine(
  collision: Collision,
  recipientId: string,
  paperTitle: string,
  otherPaperTitle?: string,
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
  const quote = elide(a.quote.length >= b.quote.length ? a.quote : b.quote);

  // A cross-paper pair is two passages in two documents, so it gets two
  // citations. One title would be worse than none: the reader would go looking
  // for both halves in whichever paper got named and find one of them, which
  // reads as the product being wrong about its own evidence. The recipient's
  // own side is cited first, for the same reason the same-paper line prefers
  // their page — it is the copy they have actually held.
  if (otherPaperTitle !== undefined && a.paperId !== b.paperId) {
    const cite = (side: DigestAnnotation): string =>
      `${side === a ? paperTitle : otherPaperTitle}, p. ${side.pageIndex + 1}`;
    const [near, far] = mine === b ? [b, a] : [a, b];
    const across = `across ${cite(near)} and ${cite(far)}`;
    return quote.length > 0
      ? `${phrase} — ${across}: “${quote}”`
      : `${phrase} — ${across}`;
  }

  const page = (mine?.pageIndex ?? Math.max(a.pageIndex, b.pageIndex)) + 1;
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
  /**
   * Whether the cross-paper scan behind this digest hit its comparison cap —
   * i.e. whether there might be cross-paper pairs nobody has looked for.
   *
   * `false` when no cross-paper scan was supplied at all, which is the honest
   * answer: a digest that never went looking has nothing truncated.
   */
  crossPaperCapped: boolean;
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
 *
 * ## Cross-paper pairs are opt-in
 *
 * `crossPaper` is a `detectCrossPaperCollisions(pool)` result, and omitting it
 * is not a degraded mode — it is the one-paper policy the simulation validated,
 * which is what a session's prep digest still wants: it pools one paper and
 * has nothing to pair across. The presenter's brief no longer wants it. It is
 * a different assembler (`lib/brief/assemble.ts`) answering the same question
 * the other way, because a presenter planning an hour is precisely the reader
 * who can use "somebody made this claim in another paper" — so `convex/briefs.ts`
 * reads a budgeted set of neighbouring papers and runs the scan itself. When it
 * is supplied, its pairs join the same candidate list, are promoted by the same
 * recipient-relative rule, and rank behind every same-paper pair. They are
 * distinguishable in the output without reading the prose: `otherPaperId` is
 * set, and `line` names both papers.
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
  /**
   * `detectCrossPaperCollisions(pool)`. Omit it for the one-paper policy —
   * a pool that spans papers is not on its own a request to pair across them.
   */
  crossPaper?: CrossPaperScan<P, A, U>;
  cap?: number;
}): AssembledDigest<P, A> {
  const cap = input.cap ?? MAX_DIGEST_ITEMS;
  const deltaIds = new Set<A>(input.delta.map((a) => a.id));
  const titleOf = (paperId: P): string =>
    input.paperTitles.get(paperId) ?? "this paper";

  const promoted = new Set<A>();
  const goldItems: DigestItem<P, A>[] = [];

  // Re-sorted rather than trusted: a precomputed list must rank identically to
  // a detected one, because this order is what the cap cuts against. Both
  // detectors' output goes through the one comparator, which is where
  // same-paper's precedence over cross-paper is decided.
  const candidates = [
    ...(input.collisions ?? detectCollisions(input.pool)),
    ...(input.crossPaper?.collisions ?? []),
  ]
    .filter(
      (c) =>
        c.a.memberId === input.recipientId || c.b.memberId === input.recipientId,
    )
    .sort(byPairRank);

  for (const collision of candidates) {
    const fresh = [collision.a, collision.b].filter((x) => deltaIds.has(x.id));
    if (fresh.length === 0) continue;
    if (fresh.some((x) => promoted.has(x.id))) continue;
    for (const x of fresh) promoted.add(x.id);
    const cross = isCrossPaper(collision);
    // File the line under the recipient's own side. They are always one half —
    // promotion is recipient-relative — and for a same-paper pair the two
    // sides are the same paper, so this is `collision.a.paperId` as before.
    const near =
      collision.a.memberId === input.recipientId ? collision.a : collision.b;
    const far = near === collision.a ? collision.b : collision.a;
    goldItems.push({
      kind: "collision",
      paperId: near.paperId,
      ...(cross ? { otherPaperId: far.paperId } : {}),
      annotationIds: [collision.a.id, collision.b.id],
      pairType: collision.pairType,
      line: collisionLine(
        collision,
        input.recipientId,
        titleOf(collision.a.paperId),
        cross ? titleOf(collision.b.paperId) : undefined,
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
    crossPaperCapped: input.crossPaper?.capped ?? false,
  };
}
