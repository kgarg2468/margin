import { describe, expect, it } from "vitest";
import {
  MAX_SCALE,
  MIN_SCALE,
  ZOOM_STEPS,
  canStepZoom,
  holdFraction,
  parsePageJump,
  restoreDelta,
  stepZoom,
  zoomLabel,
  zoomScale,
} from "./zoom";

/** A letter page in a 900px column: fit width lands a little over 1.4x. */
const COLUMN = { columnWidth: 900, baseWidth: 612 };

describe("fit width, which is the reader's resting state", () => {
  it("makes the page exactly as wide as the column it is in", () => {
    expect(zoomScale("fit-width", COLUMN)).toBeCloseTo(900 / 612, 10);
  });

  it("does not divide by a column that has not been measured yet", () => {
    expect(zoomScale("fit-width", { columnWidth: 0, baseWidth: 612 })).toBe(1);
    expect(zoomScale("fit-width", { columnWidth: 900, baseWidth: 0 })).toBe(1);
  });

  it("stays inside the range pdf.js is being asked to render", () => {
    expect(zoomScale("fit-width", { columnWidth: 40, baseWidth: 612 })).toBe(MIN_SCALE);
    expect(zoomScale("fit-width", { columnWidth: 9000, baseWidth: 612 })).toBe(MAX_SCALE);
  });
});

describe("a scale the reader chose", () => {
  it("is used as given", () => {
    expect(zoomScale(1.25, COLUMN)).toBe(1.25);
  });

  it("is clamped like any other", () => {
    expect(zoomScale(99, COLUMN)).toBe(MAX_SCALE);
    expect(zoomScale(0.01, COLUMN)).toBe(MIN_SCALE);
  });
});

describe("stepping", () => {
  it("leaves fit width for the first stop above wherever fit width landed", () => {
    // fit width here is ~1.47, so the next stop up is 1.5.
    expect(stepZoom("fit-width", 1, COLUMN)).toBe(1.5);
  });

  it("leaves fit width for the first stop below it, going the other way", () => {
    expect(stepZoom("fit-width", -1, COLUMN)).toBe(1.25);
  });

  it("walks the stops one at a time", () => {
    expect(stepZoom(1, 1, COLUMN)).toBe(1.25);
    expect(stepZoom(1.25, -1, COLUMN)).toBe(1);
  });

  it("stops at the ends rather than wrapping or drifting", () => {
    expect(stepZoom(MAX_SCALE, 1, COLUMN)).toBe(MAX_SCALE);
    expect(stepZoom(MIN_SCALE, -1, COLUMN)).toBe(MIN_SCALE);
  });

  it("does not sit still on a stop because of a rounding hair", () => {
    expect(stepZoom(1.0000001, 1, COLUMN)).toBe(1.25);
  });
});

describe("the stops and the bounds are one table", () => {
  it("starts at the smallest the page is allowed to be", () => {
    // They used to disagree: the floor was 0.4 and the lowest stop 0.5, so the
    // smallest size fit width could reach was a size the − button could not,
    // and the last press before the floor did nothing at all.
    expect(ZOOM_STEPS[0]).toBe(MIN_SCALE);
  });

  it("ends at the largest", () => {
    expect(ZOOM_STEPS[ZOOM_STEPS.length - 1]).toBe(MAX_SCALE);
  });

  it("is in order, with no repeats", () => {
    for (let i = 1; i < ZOOM_STEPS.length; i++) {
      expect(ZOOM_STEPS[i] as number).toBeGreaterThan(
        ZOOM_STEPS[i - 1] as number,
      );
    }
  });
});

/**
 * What the ± buttons are allowed to claim. A control that is live and does
 * nothing is a control that lied, and there is no way to tell it apart from a
 * control that is broken.
 */
describe("whether a press would move anything", () => {
  it("moves from a stop in the middle of the table", () => {
    expect(canStepZoom(1, 1, COLUMN)).toBe(true);
    expect(canStepZoom(1, -1, COLUMN)).toBe(true);
  });

  it("does not move down from the floor", () => {
    expect(canStepZoom(MIN_SCALE, -1, COLUMN)).toBe(false);
  });

  it("does not move up from the ceiling", () => {
    expect(canStepZoom(MAX_SCALE, 1, COLUMN)).toBe(false);
  });

  it("moves down from the lowest ordinary stop, which is not the floor", () => {
    expect(canStepZoom(0.5, -1, COLUMN)).toBe(true);
  });

  it("moves either way from fit width, when fit width landed between stops", () => {
    expect(canStepZoom("fit-width", 1, COLUMN)).toBe(true);
    expect(canStepZoom("fit-width", -1, COLUMN)).toBe(true);
  });

  it("asks about the size, not about the mode", () => {
    // A monitor wide enough that fit width clamps to the ceiling. The step
    // "leaves fit width", so a mode comparison says something changed — and
    // the page does not move by a pixel. The same shape, at the other end.
    const wide = { columnWidth: 9000, baseWidth: 612 };
    expect(canStepZoom("fit-width", 1, wide)).toBe(false);
    expect(canStepZoom("fit-width", -1, wide)).toBe(true);

    const narrow = { columnWidth: 40, baseWidth: 612 };
    expect(canStepZoom("fit-width", -1, narrow)).toBe(false);
    expect(canStepZoom("fit-width", 1, narrow)).toBe(true);
  });

  it("says nothing will move before the page has been measured", () => {
    // No document yet: every scale is 1 by definition, and a press would set a
    // number against a page whose width nobody knows.
    expect(canStepZoom("fit-width", 1, { columnWidth: 0, baseWidth: 0 })).toBe(
      false,
    );
    expect(canStepZoom("fit-width", -1, { columnWidth: 0, baseWidth: 0 })).toBe(
      false,
    );
  });
});

describe("what the control says", () => {
  it("reads as a percentage of the page's own width", () => {
    expect(zoomLabel(1, COLUMN)).toBe("100%");
    expect(zoomLabel(1.25, COLUMN)).toBe("125%");
  });

  it("says what fit width actually came out as", () => {
    expect(zoomLabel("fit-width", COLUMN)).toBe("147%");
  });
});

describe("holding the reader's place", () => {
  it("is zero when the page starts exactly at the top of the viewport", () => {
    expect(holdFraction(100, 100, 800)).toBe(0);
  });

  it("is how much of the page is above the viewport, as a fraction of it", () => {
    // Viewport top 400px into an 800px page.
    expect(holdFraction(500, 100, 800)).toBe(0.5);
    expect(holdFraction(300, 100, 800)).toBeCloseTo(0.25, 10);
  });

  it("goes negative for a page that has not reached the top yet", () => {
    // Routine, not an edge case: `currentPage` comes from an observer with
    // -45%/-50% root margins, so the page it names usually starts below the
    // top of the viewport.
    expect(holdFraction(100, 300, 800)).toBeCloseTo(-0.25, 10);
  });

  it("does not divide by a page that has not been measured yet", () => {
    expect(Number.isFinite(holdFraction(100, 50, 0))).toBe(true);
    expect(holdFraction(100, 50, 0)).toBe(50);
  });
});

describe("putting the reader back", () => {
  it("does nothing when nothing moved", () => {
    const fraction = holdFraction(500, 100, 800);
    expect(restoreDelta(fraction, 500, 100, 800)).toBe(0);
  });

  it("lands the same fraction into a page that changed height", () => {
    const fraction = holdFraction(500, 100, 800);
    // The page is now half again as tall, and the reader was halfway down it.
    const delta = restoreDelta(fraction, 500, 100, 1200);
    // Raising scrollTop by the delta moves the box up by the same amount.
    expect(100 - delta).toBe(500 - 0.5 * 1200);
  });

  it("puts the viewport back however far the page itself moved", () => {
    // The two things a zoom changes at once: the page's own height, and where
    // it now sits after every page above it also changed height. The second is
    // why a scroll offset could not have been held — by the time it is spent,
    // the page is thousands of pixels from where the offset was recorded.
    for (const fraction of [-0.3, 0, 0.25, 0.5, 0.99]) {
      for (const height of [600, 800, 1200]) {
        for (const boxTopNow of [-4000, -12, 900]) {
          const delta = restoreDelta(fraction, 500, boxTopNow, height);
          // Raising scrollTop by the delta moves the box up by the delta.
          expect(boxTopNow - delta).toBeCloseTo(500 - fraction * height, 10);
        }
      }
    }
  });

  it("round-trips a hold taken and spent at the same size", () => {
    for (const boxTop of [-2000, 100, 640]) {
      const held = holdFraction(500, boxTop, 900);
      expect(restoreDelta(held, 500, boxTop, 900)).toBeCloseTo(0, 10);
    }
  });
});

describe("the page box", () => {
  it("turns a page number into the index the reader addresses pages by", () => {
    expect(parsePageJump("1", 40)).toBe(0);
    expect(parsePageJump("40", 40)).toBe(39);
    expect(parsePageJump("  12  ", 40)).toBe(11);
  });

  it("refuses anything that is not a page in this paper", () => {
    expect(parsePageJump("0", 40)).toBeNull();
    expect(parsePageJump("41", 40)).toBeNull();
    expect(parsePageJump("", 40)).toBeNull();
    expect(parsePageJump("iv", 40)).toBeNull();
    expect(parsePageJump("3.5", 40)).toBeNull();
    expect(parsePageJump("-2", 40)).toBeNull();
    expect(parsePageJump("2", 0)).toBeNull();
  });
});
