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
  box: BoxRect | null,
): DraftBox | null {
  if (box === null) {
    return previous?.pageIndex === pageIndex ? null : previous;
  }
  return { pageIndex, ...box };
}
