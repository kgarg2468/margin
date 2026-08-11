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

/**
 * The digits a label may carry: as many as were written.
 *
 * It used to be `\d{1,4}`, and that was a length limit doing a validation job.
 * A five-digit reference was not rejected by it — it was *invisible* to it, so
 * `gateItems` never resolved it, never set `sawUnknown`, and stored the item
 * with an unresolvable `[A12345]` still in the sentence. Reading it is what
 * kills it: a label nobody minted resolves to nothing and the item is dropped
 * whole. The bound was never the safety property; the resolution is.
 */
const LABEL = String.raw`A\d+`;

/** A label anywhere in prose, brackets optional. Word-bounded: `DNA12` is not one. */
const IN_PROSE = new RegExp(String.raw`\[?\b(${LABEL})\b\]?`, "g");

/**
 * The same label with whatever space runs in front of it, for taking one back
 * out of a sentence.
 *
 * Built from `LABEL` rather than written out, because the scanner and the
 * remover have to agree exactly: a marker the gate cannot see is a marker this
 * cannot remove, and that is the shape the bug above had.
 */
const IN_PROSE_WITH_SPACE = new RegExp(
  String.raw`\s*\[?\b(${LABEL})\b\]?`,
  "g",
);

/** A `refs` entry that is nothing but a label, and the leading zeros it may carry. */
const SOLE_LABEL = /^\[?\s*a\s*(\d+)\s*\]?$/i;

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
  const match = SOLE_LABEL.exec(raw.trim());
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
  return [...text.matchAll(IN_PROSE)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

/**
 * The sentence with its labels taken back out, for a reader.
 *
 * A label is a handle between this code and a model; it was never meant to be
 * read by a person, and the surfaces render citations as the notes they are
 * rather than as markers. Stripping is all that is available: the label→row
 * map is per-run and is not stored, so `[A3]` cannot be turned back into
 * "Note 3" without guessing — and a citation nobody can follow is worse than
 * no citation at all.
 *
 * The same grammar as the gate, deliberately. Every marker that survived into
 * a stored item resolved to a real row (`gateItems` drops the item otherwise),
 * so anything this removes is a citation the reader is being shown properly
 * underneath, and anything it *cannot* remove would be a hole in the gate.
 *
 * A model that used a label as a noun — "both A3 and A4 said so" — leaves an
 * awkward sentence behind. That is the right trade: an awkward sentence is a
 * reader's problem for a second, and a raw `[A12345]` is a claim the product
 * cannot support.
 */
export function stripLabels(text: string): string {
  return (
    text
      .replace(IN_PROSE_WITH_SPACE, "")
      // The husk a parenthesised run leaves: "(A3, A4)" is emptied to "(, )".
      .replace(/\(\s*[,;·]*\s*\)/g, "")
      .replace(/\s+([.,;:!?])/g, "$1")
      .replace(/\s{2,}/g, " ")
      .trim()
  );
}
