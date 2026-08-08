import { describe, expect, it } from "vitest";
import type { Segment } from "./segments";
import { indexSegments, offsetInText, pointInSegments } from "./segments";
import { normalizePdfText } from "./normalize";

/** pdf.js gives one text item per span; extraction joined them with a space. */
function items(...strings: string[]): Segment[] {
  return strings.map((text) => ({ text, break: true }));
}

describe("indexSegments", () => {
  it("reproduces exactly what extraction wrote for the same items", () => {
    const strings = ["We recorded from the", "dorsal raphe", " nucleus  "];
    const index = indexSegments(items(...strings));
    // `lib/pdf/extract.ts` does `text += item.str; text += " "` then normalizes.
    expect(index.text).toBe(
      normalizePdfText(strings.map((s) => `${s} `).join("")),
    );
    expect(index.text).toBe("We recorded from the dorsal raphe nucleus");
  });

  it("keeps text nodes inside one item joined when no break is declared", () => {
    const index = indexSegments([
      { text: "neuro", break: true },
      { text: "transmitter", break: false },
    ]);
    expect(index.text).toBe("neurotransmitter");
  });

  it("collapses runs of whitespace inside and between items", () => {
    const index = indexSegments(items("alpha  \n beta", "", "  ", "gamma"));
    expect(index.text).toBe("alpha beta gamma");
  });

  it("trims the page rather than leaving a leading space", () => {
    const index = indexSegments(items("  ", "alpha", "  "));
    expect(index.text).toBe("alpha");
    expect(index.segment[0]).toBe(1);
    expect(index.offset[0]).toBe(0);
  });

  it("maps every character back to the item it came from", () => {
    const index = indexSegments(items("alpha", "beta"));
    expect(index.text).toBe("alpha beta");
    expect(index.segment).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
    // The collapsed separator is attributed to the item it followed.
    expect(index.offset).toEqual([0, 1, 2, 3, 4, 5, 0, 1, 2, 3]);
    expect(index.firstIndex).toEqual([0, 6]);
    expect(index.lastIndex).toEqual([5, 9]);
  });

  it("survives an empty page", () => {
    const index = indexSegments([]);
    expect(index.text).toBe("");
    expect(offsetInText(index, 0, 0, "start")).toBe(0);
  });
});

describe("offsetInText", () => {
  const index = indexSegments(items("We recorded from the", "dorsal  raphe", "nucleus"));

  it("round-trips every real character through both directions", () => {
    for (let i = 0; i < index.text.length; i++) {
      // Spaces stand for collapsed whitespace and deliberately do not survive
      // the round trip: a boundary on one snaps to the next real character.
      if (index.text[i] === " ") {
        continue;
      }
      const point = pointInSegments(index, i);
      expect(point).not.toBeNull();
      const back = offsetInText(
        index,
        (point as { segment: number }).segment,
        (point as { offset: number }).offset,
        "start",
      );
      expect(back).toBe(i);
    }
  });

  it("snaps a boundary that landed on collapsed whitespace", () => {
    // The space between "the" and "dorsal" only exists because the collapse put
    // it there; a selection starting on it means the word after it.
    const space = index.text.indexOf(" dorsal") ;
    const point = pointInSegments(index, space);
    const start = offsetInText(
      index,
      (point as { segment: number }).segment,
      (point as { offset: number }).offset,
      "start",
    );
    expect(index.text.slice(start)).toBe("dorsal raphe nucleus");
  });

  it("turns a selection inside one item into the passage a reader dragged", () => {
    const start = offsetInText(index, 0, 3, "start");
    const end = offsetInText(index, 0, 11, "end");
    expect(index.text.slice(start, end)).toBe("recorded");
  });

  it("spans a selection across items", () => {
    const start = offsetInText(index, 0, 16, "start");
    const end = offsetInText(index, 2, 7, "end");
    expect(index.text.slice(start, end)).toBe("the dorsal raphe nucleus");
  });

  it("moves a start forward off whitespace the collapse removed", () => {
    // Offset 6 in "dorsal  raphe" is the first of the two spaces.
    const start = offsetInText(index, 1, 6, "start");
    expect(index.text.slice(start)).toBe("raphe nucleus");
  });

  it("moves an end back off whitespace the collapse removed", () => {
    const end = offsetInText(index, 1, 8, "end");
    expect(index.text.slice(0, end)).toBe("We recorded from the dorsal");
  });

  it("walks past items that contributed nothing", () => {
    const sparse = indexSegments(items("alpha", "   ", "", "beta"));
    expect(sparse.text).toBe("alpha beta");
    expect(offsetInText(sparse, 1, 0, "start")).toBe(6);
    expect(offsetInText(sparse, 2, 0, "end")).toBe(5);
  });

  it("clamps points outside the item list", () => {
    expect(offsetInText(index, -1, 0, "start")).toBe(0);
    expect(offsetInText(index, 99, 0, "end")).toBe(index.text.length);
  });

  it("clamps an offset past the end of the last item", () => {
    expect(offsetInText(index, 2, 999, "end")).toBe(index.text.length);
    expect(offsetInText(index, 0, 999, "start")).toBe(
      index.text.indexOf("dorsal"),
    );
  });
});

describe("pointInSegments", () => {
  it("refuses offsets outside the page", () => {
    const index = indexSegments(items("alpha"));
    expect(pointInSegments(index, -1)).toBeNull();
    expect(pointInSegments(index, 5)).toBeNull();
    expect(pointInSegments(index, 4)).toEqual({ segment: 0, offset: 4 });
  });
});
