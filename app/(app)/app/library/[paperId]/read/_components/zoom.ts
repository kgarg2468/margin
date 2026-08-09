/**
 * How big the paper is.
 *
 * Fit width is not an option among options — it is the reader's resting state,
 * and it is what a paper opens at, because a column of a fixed width is the
 * only sensible default for a document nobody has expressed an opinion about
 * yet. Everything else is a departure from it, which is why `ZoomMode` is
 * "fit width, or a number", not a number with a flag beside it.
 *
 * The stops are the ones a reader recognises from every other document viewer.
 * They are absolute page scales rather than multiples of fit width, so 100%
 * means the page at the size it was typeset — which on a wide screen is
 * *smaller* than fit width, and is the thing somebody checking a figure's
 * proportions actually wants.
 *
 * The bounds are pdf.js's practical ones and match what the reader was already
 * clamping to before there was a control — and they are the two ends of the
 * table, not a second opinion beside it. They disagreed once: the floor was
 * 0.4 and the lowest stop 0.5, so fit width in a narrow column could reach a
 * size the − button could not, and the press at 50% was live and did nothing.
 * 0.4 keeps the floor where a narrow phone needs it and hands the last step
 * back to the control.
 */

export const MIN_SCALE = 0.4;
export const MAX_SCALE = 2;

export const ZOOM_STEPS: readonly number[] = [
  MIN_SCALE,
  0.5,
  0.75,
  1,
  1.25,
  1.5,
  MAX_SCALE,
];

/** Comparing scales that came out of a division needs a hair of tolerance. */
const EPSILON = 0.0001;

export type ZoomMode = "fit-width" | number;

export type ZoomInput = {
  /** The width of the column the page is rendered into. */
  columnWidth: number;
  /** The page's own width at scale 1. */
  baseWidth: number;
};

export function zoomScale(mode: ZoomMode, input: ZoomInput): number {
  if (mode !== "fit-width") {
    return clamp(mode);
  }
  if (input.columnWidth <= 0 || input.baseWidth <= 0) {
    return 1;
  }
  return clamp(input.columnWidth / input.baseWidth);
}

export function stepZoom(
  mode: ZoomMode,
  direction: 1 | -1,
  input: ZoomInput,
): ZoomMode {
  const current = zoomScale(mode, input);
  if (direction === 1) {
    return ZOOM_STEPS.find((step) => step > current + EPSILON) ?? current;
  }
  return (
    [...ZOOM_STEPS].reverse().find((step) => step < current - EPSILON) ?? current
  );
}

/**
 * Whether pressing ± would actually change the size of the page.
 *
 * Asked of the *scale*, not of the mode. `stepZoom` at either end of the table
 * hands back a number where fit width was, which is a different `ZoomMode` and
 * the same page: on a monitor wide enough that fit width clamps to the ceiling,
 * a mode comparison says + will do something and the page does not move by a
 * pixel. It is the same lesson the restore guard learned — compare the thing
 * that is about to change, not the thing you asked with.
 *
 * An unmeasured document cannot step at all. Nothing has a size yet, and the
 * press would not zoom so much as quietly give up fit width for the session,
 * against a page whose width nobody has read.
 */
export function canStepZoom(
  mode: ZoomMode,
  direction: 1 | -1,
  input: ZoomInput,
): boolean {
  if (input.columnWidth <= 0 || input.baseWidth <= 0) {
    return false;
  }
  return (
    zoomScale(stepZoom(mode, direction, input), input) !== zoomScale(mode, input)
  );
}

export function zoomLabel(mode: ZoomMode, input: ZoomInput): string {
  return `${Math.round(zoomScale(mode, input) * 100)}%`;
}

/**
 * A page number as somebody typed it, as the index the reader uses, or `null`
 * if it is not a page in this paper. Deliberately strict: "3.5" and "iv" are
 * not near misses to be rounded into something, they are somebody still typing.
 */
export function parsePageJump(input: string, pageCount: number): number | null {
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const page = Number(trimmed);
  if (page < 1 || page > pageCount) {
    return null;
  }
  return page - 1;
}

function clamp(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

/**
 * Keeping the reader's place across a scale change.
 *
 * These two live out here rather than inline in the reader for the reason
 * `draft-box.ts` gives about its own pair: they are the only decisions in that
 * path that can be wrong in a way a browser would not show you. A zoom that
 * restores to the wrong place does not look broken — it looks like the paper
 * jumped, which is what it does *without* a restore, so a sign error here
 * would read as the feature simply not working and nobody would find it.
 *
 * The place is held as a fraction of the current page rather than as a scroll
 * offset, because the offset is exactly the thing about to be invalidated: a
 * zoom changes the height of every page above the viewport as well as the one
 * in it, so by the time the hold is spent the page has moved thousands of
 * pixels from wherever it was measured.
 */

/**
 * How far into the page the top of the viewport sits, as a fraction of the
 * page's height.
 *
 * Negative for a page that has not reached the top of the viewport yet, which
 * is the ordinary case rather than an edge one: the page this is asked about
 * is the one the reader is *looking at*, named by an observer with -45%/-50%
 * root margins, so it usually begins below the viewport's top edge.
 */
export function holdFraction(
  rootTop: number,
  boxTop: number,
  boxHeight: number,
): number {
  return (rootTop - boxTop) / Math.max(1, boxHeight);
}

/**
 * What to add to `scrollTop` to put that fraction of the page back under the
 * top of the viewport, given where the page has ended up and how tall it now
 * is. Raising `scrollTop` by the delta moves the box up by the same amount.
 */
export function restoreDelta(
  fraction: number,
  rootTop: number,
  boxTop: number,
  boxHeight: number,
): number {
  return boxTop - rootTop + fraction * boxHeight;
}
