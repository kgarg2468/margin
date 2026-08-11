/**
 * Whole-item redaction: the stricter of this codebase's two rules.
 *
 * An item is redacted when **any** one of the notes it rests on stops being
 * shared — not when all of them have. A brief line names both members and
 * quotes each; a finding item is a paraphrase of *these* notes. Either way,
 * keeping the sentence because something else behind it survived leaves the
 * withdrawn note's substance in a line the reader can still read.
 *
 * `synthesis.applyWithdrawals` is deliberately laxer and stays where it is
 * (design §3.7): a synthesis item's attribution is a union of names with no
 * mapping back to particular ids, so dropping the names is a real remedy
 * there and would be theatre here. Two rules, named apart, one of them shared.
 *
 * The ids are never stripped. They are what lets a client run the same test
 * against what it can see and reach the same verdict.
 */

/** The rule itself, as a predicate: every citation still shared, or none of it counts. */
export function allCitationsShared<A extends string>(
  ids: readonly A[],
  stillShared: ReadonlySet<A>,
): boolean {
  return ids.every((id) => stillShared.has(id));
}

/**
 * Apply the rule across a list of items.
 *
 * The caller supplies how to read an item's citations and what a redacted one
 * looks like, because the sentence differs by surface — a brief says a line
 * was here, a finding says the scout's note was — and the shapes differ too.
 * The *rule* is what must not differ.
 */
export function redactWhenAnyWithdrawn<A extends string, I>(
  items: readonly I[],
  stillShared: ReadonlySet<A>,
  citationsOf: (item: I) => readonly A[],
  redact: (item: I) => I,
): { items: I[]; redactedCount: number } {
  let redactedCount = 0;
  const applied = items.map((item) => {
    if (allCitationsShared(citationsOf(item), stillShared)) return item;
    redactedCount += 1;
    return redact(item);
  });
  return { items: applied, redactedCount };
}
