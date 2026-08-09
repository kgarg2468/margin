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
 * clamping to before there was a control.
 */

export const MIN_SCALE = 0.4;
export const MAX_SCALE = 2;

export const ZOOM_STEPS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2];

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
