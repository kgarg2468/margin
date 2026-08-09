import type { DraftBox } from "./types";

/**
 * The arithmetic behind the box the composer is anchored to.
 *
 * Both functions live out here rather than inside the components because they
 * are the only decisions in that path that can be wrong in a way a browser
 * would not show you. The rest of it — measuring client rects, drawing spans —
 * either works or is visibly broken on screen; these two are silent.
 */

/** A rectangle in one page's own coordinates. */
export type BoxRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/**
 * The one rectangle that contains all of them, or `null` for nothing to
 * contain.
 *
 * A selection that wraps across three lines is three client rects, and the
 * composer wants somewhere to sit beside *the passage*, not beside its first
 * line. The union is deliberately not the first rect nor the tallest: a note
 * about a sentence that begins at the end of one line and ends at the start of
 * the next would otherwise be anchored to a two-word fragment.
 */
export function unionOfRects(rects: readonly BoxRect[]): BoxRect | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const rect of rects) {
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.left + rect.width);
    bottom = Math.max(bottom, rect.top + rect.height);
  }
  if (left === Infinity) {
    return null;
  }
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * The draft's rectangle in the page's own coordinates, at the size the page is
 * now rather than the size it was measured at.
 *
 * A zoom throws the text layer away and builds a new one asynchronously; a page
 * that has left the render window does not build one at all. The box is held
 * through both, because retracting it would strand the composer — and held, it
 * is a rectangle off a page that has since changed size. A passage twice as far
 * down a page twice as tall is the same sentence, so the ratio is the whole
 * correction, and the composer stays on its passage instead of floating over
 * whatever the new size put where the old one had it.
 *
 * The page's own border is the one part of the box that does not scale with
 * the page, which is worth a pixel at the extremes and nothing anywhere else.
 */
export function draftAnchorBox(box: DraftBox, scale: number): BoxRect {
  const ratio = box.scale > 0 ? scale / box.scale : 1;
  return {
    left: box.left * ratio,
    top: box.top * ratio,
    width: box.width * ratio,
    height: box.height * ratio,
  };
}

/**
 * The reader's answer to one page reporting where the draft's passage sits.
 *
 * Every page runs the reporting effect, and a page with no draft on it reports
 * `null`. In a forty-page paper that is thirty-nine pages saying "not here"
 * about a box the fortieth just measured — so a retraction is only honoured
 * from the page that owns the box. Without that rule the composer's anchor is
 * decided by whichever page happened to render last.
 */
export function nextDraftBox(
  previous: DraftBox | null,
  pageIndex: number,
  box: Omit<DraftBox, "pageIndex"> | null,
): DraftBox | null {
  if (box === null) {
    return previous?.pageIndex === pageIndex ? null : previous;
  }
  return { pageIndex, ...box };
}
