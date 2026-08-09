import { describe, expect, it } from "vitest";
import {
  MAX_SCALE,
  MIN_SCALE,
  parsePageJump,
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

describe("what the control says", () => {
  it("reads as a percentage of the page's own width", () => {
    expect(zoomLabel(1, COLUMN)).toBe("100%");
    expect(zoomLabel(1.25, COLUMN)).toBe("125%");
  });

  it("says what fit width actually came out as", () => {
    expect(zoomLabel("fit-width", COLUMN)).toBe("147%");
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
