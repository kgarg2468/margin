/**
 * How strongly a mark is drawn.
 *
 * The wash tokens are shared with `::selection` and with the pressed state of
 * every chip in the app, so the honest place to raise a passage's visibility is
 * here — in the multiplier the overlay applies — and not in `--note-*-wash`,
 * which `app/globals.css` already records was raised once after a co-founder
 * review and which three other surfaces read.
 *
 * At 0.5 a resting typed passage came out as a 10% tint. A reaction chip on the
 * card referring to that passage is a full 30%: the annotation was three times
 * more visible than the sentence it was about, which is the wrong way round for
 * a reader whose whole job is the paper. 0.75 puts a typed passage at 15% and a
 * plain highlight at 22.5% — under the 40% of a live selection, which still has
 * to be the loudest thing on the page, and plainly above the paper.
 *
 * The drifted pair stays proportionally lower on purpose. A passage recovered by
 * fuzzy alignment is a claim the reader is making about the text, and it is
 * drawn with less confidence than one found exactly where it was left.
 */

export type MarkTone = {
  /** The passage was reasoned back to rather than found where it was left. */
  drifted: boolean;
  /** This is the note the pointer or the keyboard is on. */
  active: boolean;
};

export function washOpacity({ drifted, active }: MarkTone): number {
  if (drifted) {
    return active ? 0.7 : 0.4;
  }
  return active ? 1 : 0.75;
}

export function ruleOpacity({ active }: Pick<MarkTone, "active">): number {
  return active ? 1 : 0.75;
}
