import { describe, expect, it } from "vitest";
import { boxAnchor, openedFromKeyboard } from "./ui";

describe("boxAnchor", () => {
  const box = { top: 40, left: 10, width: 200, height: 18 };

  it("puts the rectangle where the scrolling content currently is", () => {
    const rect = boxAnchor(box, () => ({ left: 100, top: 500 })).getBoundingClientRect();
    expect([rect.left, rect.top, rect.width, rect.height]).toEqual([110, 540, 200, 18]);
    expect([rect.right, rect.bottom]).toEqual([310, 558]);
    expect([rect.x, rect.y]).toEqual([110, 540]);
  });

  it("asks where the content is on every read, so a scroll moves the sheet with it", () => {
    let scrolled = 0;
    const anchor = boxAnchor(box, () => ({ left: 0, top: -scrolled }));
    expect(anchor.getBoundingClientRect().top).toBe(40);
    scrolled = 300;
    expect(anchor.getBoundingClientRect().top).toBe(-260);
  });

  it("falls back to the viewport origin rather than throwing when there is nothing to measure", () => {
    const rect = boxAnchor(box, () => null).getBoundingClientRect();
    expect([rect.left, rect.top]).toEqual([10, 40]);
  });

  it("serialises, because that is part of being a DOMRect", () => {
    const rect = boxAnchor(box, () => ({ left: 0, top: 0 })).getBoundingClientRect();
    expect(JSON.parse(JSON.stringify(rect.toJSON()))).toMatchObject({
      left: 10,
      top: 40,
      width: 200,
      height: 18,
    });
  });

  it("carries a contextElement through when given one, and omits it otherwise", () => {
    const context = { tag: "scroll-container" } as unknown as Element;
    const anchored = boxAnchor(box, () => null, context);
    expect(anchored.contextElement).toBe(context);
    // floating-ui probes with `in` before unwrapping, so the property must be
    // absent entirely when there is no container — not present-but-undefined.
    expect("contextElement" in boxAnchor(box, () => null)).toBe(false);
  });
});

describe("openedFromKeyboard", () => {
  it("says no when there was no event at all", () => {
    expect(openedFromKeyboard(undefined)).toBe(false);
  });
});

