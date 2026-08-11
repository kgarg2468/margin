/**
 * What may be stored, out of what a model returned.
 *
 * Per item, and drop-and-count rather than fail-the-batch: one hallucinated
 * label should cost the lab that line, not the four beside it that cited real
 * notes. The count travels to the reader, because a finding that quietly lost
 * half of itself is a finding nobody can calibrate against.
 *
 * Nothing here throws. `lib/` is loaded by the browser as well as by Convex,
 * so unreadable output comes back as `null` and the `convex/` caller turns it
 * into the refusal its users read.
 */
import { scanLabels } from "./labels";

/** What a label resolves to: the row it named, and the paper that row is on. */
export type CitedRow<A extends string, P extends string> = {
  id: A;
  paperId: P;
};

export type GatedItem<A extends string, P extends string> = {
  text: string;
  citedAnnotationIds: A[];
  citedPaperIds: P[];
};

/**
 * Resolve labels against the material, and say whether one of them was never
 * issued.
 *
 * `sawUnknown` is not a warning, it is a verdict about the item: a label
 * nobody minted is evidence about how the sentence was produced.
 */
export function resolveCitations<R>(
  labels: readonly string[],
  resolve: (label: string) => R | undefined,
): { resolved: R[]; sawUnknown: boolean } {
  const resolved: R[] = [];
  let sawUnknown = false;
  for (const label of labels) {
    const row = resolve(label);
    if (row === undefined) {
      sawUnknown = true;
      continue;
    }
    // Identity, because labels are one-to-one with rows: the same label
    // resolves to the same object every time.
    if (!resolved.includes(row)) resolved.push(row);
  }
  return { resolved, sawUnknown };
}

/**
 * Papers, derived from the citations and never asked of the model.
 *
 * A model asked which paper it is talking about will answer.
 */
export function citedPaperIds<P extends string>(
  rows: readonly { paperId: P }[],
): P[] {
  const papers: P[] = [];
  for (const row of rows) {
    if (!papers.includes(row.paperId)) papers.push(row.paperId);
  }
  return papers;
}

/**
 * The per-item gate: text, citations from both the list and the sentence,
 * every label real, or the item does not get stored.
 *
 * "Half of it checks out" is not a property a scientist can use — they would
 * have to know which half, which is the work the machine was supposed to do.
 * So an item that cited anything unreal is dropped whole, not trimmed.
 *
 * `null` means the output was not even a list of items. That is a different
 * fact from "no item survived" and the caller must be able to tell them apart.
 */
export function gateItems<A extends string, P extends string>(
  rawItems: unknown,
  resolve: (label: string) => CitedRow<A, P> | undefined,
  limits: { maxItems: number; maxChars: number },
): { items: GatedItem<A, P>[]; droppedForCitation: number } | null {
  if (!Array.isArray(rawItems)) return null;

  const items: GatedItem<A, P>[] = [];
  let droppedForCitation = 0;

  for (const entry of rawItems.slice(0, limits.maxItems)) {
    if (typeof entry !== "object" || entry === null) {
      droppedForCitation += 1;
      continue;
    }
    const record = entry as { text?: unknown; citations?: unknown };
    const text =
      typeof record.text === "string"
        ? record.text.trim().slice(0, limits.maxChars)
        : "";

    const { resolved, sawUnknown } = resolveCitations(
      [...scanLabels(record.citations), ...scanLabels(record.text)],
      resolve,
    );

    if (text.length === 0 || resolved.length === 0 || sawUnknown) {
      droppedForCitation += 1;
      continue;
    }
    items.push({
      text,
      citedAnnotationIds: resolved.map((one) => one.id),
      citedPaperIds: citedPaperIds(resolved),
    });
  }

  return { items, droppedForCitation };
}
