import { describe, expect, it } from "vitest";
import { draftAnchorBox, nextDraftBox, unionOfRects } from "./draft-box";
import type { DraftBox } from "./types";

/**
 * Two silent decisions. The union is wrong only in ways that put the composer
 * beside the wrong half of a wrapped sentence; the reducer is wrong only when
 * some page nobody is looking at retracts a box that belongs to another one.
 * Neither would look broken on screen, which is why they are out here.
 */

describe("the rectangle a wrapped passage occupies", () => {
  it("has nothing to report for a passage with no rectangles", () => {
    expect(unionOfRects([])).toBeNull();
  });

  it("gives a single-line passage back its own rectangle", () => {
    expect(unionOfRects([{ left: 10, top: 20, width: 100, height: 12 }])).toEqual({
      left: 10,
      top: 20,
      width: 100,
      height: 12,
    });
  });

  it("spans every line of a passage that wraps, not just the first", () => {
    // The tail of one line, a full line, and the head of the next — the shape
    // of any sentence that crosses a line break.
    const union = unionOfRects([
      { left: 300, top: 100, width: 60, height: 12 },
      { left: 40, top: 116, width: 320, height: 12 },
      { left: 40, top: 132, width: 90, height: 12 },
    ]);
    expect(union).toEqual({ left: 40, top: 100, width: 320, height: 44 });
  });

  it("does not let the first rectangle decide the anchor", () => {
    // A two-word fragment at the end of a line, followed by the real body of
    // the passage. Anchoring to rects[0] would put the composer out at x=300.
    const union = unionOfRects([
      { left: 300, top: 100, width: 60, height: 12 },
      { left: 40, top: 116, width: 320, height: 12 },
    ]);
    expect(union?.left).toBe(40);
    expect(union?.width).toBeGreaterThan(60);
  });
});

describe("which page may retract the composer's box", () => {
  const box = { left: 40, top: 100, width: 320, height: 44, scale: 1 };
  const held: DraftBox = { pageIndex: 4, ...box };

  it("takes a box from the page that measured one", () => {
    expect(nextDraftBox(null, 4, box)).toEqual(held);
  });

  it("lets the owning page retract its own box", () => {
    expect(nextDraftBox(held, 4, null)).toBeNull();
  });

  it("ignores a retraction from any other page", () => {
    // Page 11 reporting "no draft here" is not news about page 4's passage.
    expect(nextDraftBox(held, 11, null)).toBe(held);
  });

  it("ignores a retraction when there is nothing held at all", () => {
    expect(nextDraftBox(null, 11, null)).toBeNull();
  });

  it("lets a new page take the box over from the old one", () => {
    expect(nextDraftBox(held, 7, box)).toEqual({ pageIndex: 7, ...box });
  });
});

/**
 * The third silent one, and the reason the box carries the size it was
 * measured at. A zoom throws the text layer away and rebuilds it
 * asynchronously; a page that has left the render window never rebuilds it at
 * all. In between, the last rectangle the page reported is the only thing the
 * composer has to sit beside, and it is a rectangle from a page that is no
 * longer that size.
 */
describe("a rectangle measured at one size, read at another", () => {
  const box: DraftBox = {
    pageIndex: 4,
    left: 40,
    top: 100,
    width: 320,
    height: 44,
    scale: 1,
  };

  it("hands back exactly what was measured while the size is unchanged", () => {
    expect(draftAnchorBox(box, 1)).toEqual({
      left: 40,
      top: 100,
      width: 320,
      height: 44,
    });
  });

  it("carries the passage along when the page doubles", () => {
    // Twice as far down a page that is twice as tall is the same sentence.
    expect(draftAnchorBox(box, 2)).toEqual({
      left: 80,
      top: 200,
      width: 640,
      height: 88,
    });
  });

  it("carries it back the other way", () => {
    expect(draftAnchorBox({ ...box, scale: 2 }, 1)).toEqual({
      left: 20,
      top: 50,
      width: 160,
      height: 22,
    });
  });

  it("round-trips through a zoom and back", () => {
    for (const from of [0.4, 1, 1.47, 2]) {
      for (const to of [0.5, 1.25, 1.9]) {
        const zoomed = draftAnchorBox({ ...box, scale: from }, to);
        const back = draftAnchorBox(
          { ...box, ...zoomed, scale: to },
          from,
        );
        expect(back.top).toBeCloseTo(box.top, 10);
        expect(back.left).toBeCloseTo(box.left, 10);
      }
    }
  });

  it("does not divide by a size that was never measured", () => {
    expect(draftAnchorBox({ ...box, scale: 0 }, 1.5)).toEqual({
      left: 40,
      top: 100,
      width: 320,
      height: 44,
    });
  });
});
