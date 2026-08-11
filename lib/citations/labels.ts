/**
 * The `[A#]` vocabulary, issued once and read back.
 *
 * A model is allowed to name the lab's writing in exactly one way: by a label
 * this code minted for the material it was shown. That is what makes a
 * citation checkable rather than a claim — and it only works if the side that
 * writes the labels and the side that resolves them are the same code. Two
 * surfaces use it (the session synthesis and the scout), so it lives here
 * rather than twice.
 */

/** One label, from a zero-based position. 1-based on the page: the prompt says `[A1]`. */
export function labelAt(index: number): string {
  return `A${index + 1}`;
}

/** The material, labelled in the order it will be laid out. */
export function issueLabels<T extends object>(
  items: readonly T[],
): (T & { label: string })[] {
  return items.map((item, index) => ({ ...item, label: labelAt(index) }));
}

/** Label → row, for resolving what came back. */
export function indexByLabel<T extends { label: string }>(
  labelled: readonly T[],
): Map<string, T> {
  return new Map(labelled.map((one) => [one.label, one]));
}

/**
 * One ref field, normalized. `[A12]`, `a12`, ` A12 `, `A007` → `A12` / `A7`.
 *
 * Strict on purpose: a `refs` entry is a claim about a single label, so
 * anything with more in it than a label is not a label. `scanLabels` below is
 * the loose reader, for prose, and the two are different jobs rather than one
 * job done twice — a gate that accepted "A1 and also A2" as a ref would be
 * deciding what the model meant.
 */
export function normalizeLabel(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const match = /^\[?\s*a\s*(\d{1,4})\s*\]?$/i.exec(raw.trim());
  const digits = match?.[1];
  return digits === undefined ? undefined : `A${Number(digits)}`;
}

/**
 * Every label mentioned in a string, or in a list of them.
 *
 * The loose reader, and it has to be loose: a model that cites inline and
 * sends an empty citation list is still telling you what its sentence rests
 * on, and an item whose stored citations omit a label its prose leans on is
 * an item that label's withdrawal cannot redact. Word-bounded so `DNA12` is
 * not a citation.
 */
export function scanLabels(source: unknown): string[] {
  const text =
    typeof source === "string"
      ? source
      : Array.isArray(source)
        ? source.filter((one) => typeof one === "string").join(" ")
        : "";
  return [...text.matchAll(/\[?\b(A\d{1,4})\b\]?/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}
