/**
 * Where the margin's notes go when more than one of them wants the same line.
 *
 * The naive pass — take them in document order, push each one down until it
 * clears the last — is what a typesetter does by hand, and it has the property
 * that a hand pass has: the error accumulates. Six notes on one paragraph put
 * the sixth a screen and a half from the sentence it is about, and it is always
 * the sixth, because the pass only ever moves things one way.
 *
 * This moves them both ways and shares the error out. Formally it is the
 * placement minimising the total squared distance from each card to its
 * passage, subject to the cards staying in document order with a gap between
 * them; substituting out the space every earlier card occupies turns that
 * constraint into plain monotonicity, and the monotone least-squares fit is
 * pool-adjacent-violators. One pass, no iteration, no tuning constant, and O(n)
 * — which is the reason it can run on a paper carrying the full thousand notes
 * `convex/annotations.ts` allows, on every commit a scrolling page produces.
 *
 * What it deliberately does not do is refuse to lift a card above its passage.
 * "Never above, only below" was the old pass's rule and it is the whole source
 * of the accumulation; a note half a line above the sentence it annotates reads
 * as beside it, and a note four hundred pixels below does not.
 */

/** Breathing room between two cards that want the same line. */
export const DEFAULT_GAP = 10;

export type RelaxItem = {
  id: string;
  /** Where the passage is, in the rail's own coordinates. */
  wanted: number;
  /** Measured. See `relaxColumn` on why an estimate here is not good enough. */
  height: number;
};

export type RelaxPlacement = {
  id: string;
  /** Where the card goes. */
  top: number;
  /** Where its passage is, carried through so the caller need not re-derive it. */
  wanted: number;
  /**
   * How far the pass had to move it — negative for a card lifted above its
   * passage. Everything the reader needs to be told about the gap is here.
   */
  drift: number;
};

export type RelaxResult = {
  /** In document order, which after this pass is also top-to-bottom order. */
  placements: RelaxPlacement[];
  /**
   * The bottom of the last card. The spacer the cards are absolutely positioned
   * inside is as tall as the *pages*, and a crowded run can end below them; a
   * spacer that did not grow would let the unanchored section underneath be
   * overlapped.
   */
  contentHeight: number;
};

export type RelaxOptions = {
  gap?: number;
  /** The rail's own top. Nothing is placed above it. */
  floor?: number;
};

export function relaxColumn(
  items: readonly RelaxItem[],
  options: RelaxOptions = {},
): RelaxResult {
  const gap = options.gap ?? DEFAULT_GAP;
  const floor = options.floor ?? 0;

  // Ties broken by id, not left to sort stability: `cards` is rebuilt from a
  // fresh Map on every page resolution, so two notes on the same line would
  // otherwise be free to swap places while somebody was reading them.
  const order = [...items].sort(
    (a, b) => a.wanted - b.wanted || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  if (order.length === 0) {
    return { placements: [], contentHeight: 0 };
  }

  // The target each card would sit at with the space every earlier card
  // occupies subtracted out. In this coordinate the "stay in order, keep a
  // gap" constraint is exactly "these numbers must not decrease".
  const targets: number[] = [];
  let occupied = 0;
  for (const card of order) {
    targets.push(card.wanted - occupied);
    occupied += card.height + gap;
  }

  // Pool adjacent violators. A block is a run of cards that ended up sharing
  // one answer; its value is the mean of their targets, which is the point
  // minimising the squared displacement of the whole run.
  const values: number[] = [];
  const counts: number[] = [];
  for (const target of targets) {
    values.push(target);
    counts.push(1);
    while (
      values.length > 1 &&
      (values[values.length - 2] as number) > (values[values.length - 1] as number)
    ) {
      const value = values.pop() as number;
      const count = counts.pop() as number;
      const priorValue = values.pop() as number;
      const priorCount = counts.pop() as number;
      values.push((priorValue * priorCount + value * count) / (priorCount + count));
      counts.push(priorCount + count);
    }
  }

  // The floor is applied in the substituted coordinate, not to the final tops.
  // Clamping the tops would give two cards pinned at the ceiling the same y;
  // clamping here pins the first one and the rest follow it down by their own
  // heights, which is what "nothing above the first line" actually means.
  const placements: RelaxPlacement[] = [];
  let index = 0;
  let occupiedSoFar = 0;
  let bottom = floor;
  for (let block = 0; block < values.length; block++) {
    const value = Math.max(values[block] as number, floor);
    for (let member = 0; member < (counts[block] as number); member++) {
      const card = order[index] as RelaxItem;
      const top = value + occupiedSoFar;
      placements.push({
        id: card.id,
        top,
        wanted: card.wanted,
        drift: top - card.wanted,
      });
      occupiedSoFar += card.height + gap;
      bottom = Math.max(bottom, top + card.height);
      index++;
    }
  }

  return { placements, contentHeight: bottom };
}
