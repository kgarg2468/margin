/**
 * One number per note, for a whole write-up.
 *
 * A synthesis item or a brief line carries the ids of the annotations it was
 * drawn from, and the surfaces that render it used to number those ids by
 * their position inside that one item's own array. Almost every item resolves
 * to a single note, so almost every citation on the page read "Note 1" — not a
 * wrong number so much as a number with no scope wider than one bullet.
 *
 * A citation number is a document-wide handle: "Note 3" has to mean the same
 * note in the third bullet, in the fifth, and in the .md somebody downloaded.
 * So it is assigned once, by first appearance, walking the sections in the
 * order the reader meets them — and every later mention of that note reuses
 * it. Two bullets resting on the same note say so by carrying the same number,
 * which is the whole reason a reader looks at one.
 *
 * ## One map, three renderers
 *
 * The page, the presenter's brief, and the Markdown export all number the same
 * citations, and they agree because they call this with the same ordered
 * sections rather than because three implementations happen to match. The
 * export builds its own map from the sections argument it was already given,
 * so the file and the screen agree by construction.
 *
 * Callers pass ids they have already filtered down to what this reader can
 * currently see. A withdrawn note that still consumed a number would leave a
 * hole in the sequence — "Note 1, Note 3" on a line whose second citation was
 * never drawn — and a gap is a worse disclosure than no number at all.
 */

/** Anything that cites notes: a synthesis item, a brief line, a section. */
type Citing<A extends string> = { annotationIds: readonly A[] };

/**
 * The note-number registry for a write-up, in display order.
 *
 * 1-based, contiguous, and stable for repeats. `Map` iteration order is
 * insertion order, so the map itself is also the list of cited notes in the
 * order they were first mentioned.
 */
export function citationNumbering<A extends string>(
  sections: readonly Citing<A>[],
): Map<A, number> {
  const numbers = new Map<A, number>();
  for (const section of sections) {
    for (const id of section.annotationIds) {
      if (!numbers.has(id)) {
        numbers.set(id, numbers.size + 1);
      }
    }
  }
  return numbers;
}
