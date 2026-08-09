import { describe, expect, it } from "vitest";
import { connectorGeometry } from "./connector";

/** Every coordinate below is in the rail spacer's own space. */
const PADDING = 3;

describe("a note level with its passage", () => {
  const geometry = connectorGeometry({ x: -24, y: 100 }, { x: 0, y: 100 });

  it("spans the gutter and nothing else", () => {
    expect(geometry?.left).toBe(-24);
    expect(geometry?.width).toBe(24);
  });

  it("is a flat line with only the padding for height", () => {
    expect(geometry?.top).toBe(100 - PADDING);
    expect(geometry?.height).toBe(PADDING * 2);
    expect(geometry?.path).toBe("M 0 3 C 13.2 3, 10.8 3, 24 3");
  });
});

describe("a note the relax pass had to move", () => {
  const geometry = connectorGeometry({ x: -30, y: 100 }, { x: 0, y: 160 });

  it("covers both ends and the padding around them", () => {
    expect(geometry?.top).toBe(97);
    expect(geometry?.height).toBe(66);
  });

  it("starts on the passage's edge of the box and ends on the card's", () => {
    expect(geometry?.path.startsWith("M 0 3 ")).toBe(true);
    expect(geometry?.path.endsWith(" 30 63")).toBe(true);
  });

  it("leaves the passage horizontally and arrives horizontally, so the curve is a leader and not a diagonal", () => {
    // The control points share their y with the endpoint they belong to.
    expect(geometry?.path).toBe("M 0 3 C 16.5 3, 13.5 63, 30 63");
  });
});

describe("a note above its passage", () => {
  it("draws the same line upward", () => {
    const geometry = connectorGeometry({ x: -30, y: 160 }, { x: 0, y: 100 });
    expect(geometry?.top).toBe(97);
    expect(geometry?.height).toBe(66);
    expect(geometry?.path).toBe("M 0 63 C 16.5 63, 13.5 3, 30 3");
  });
});

describe("no gutter to cross", () => {
  it("declines to draw when the passage is not to the left of the card", () => {
    expect(connectorGeometry({ x: 0, y: 100 }, { x: 0, y: 100 })).toBeNull();
    expect(connectorGeometry({ x: 4, y: 100 }, { x: 0, y: 100 })).toBeNull();
  });

  it("declines to draw a hairline nobody would see", () => {
    expect(connectorGeometry({ x: -1, y: 100 }, { x: 0, y: 100 })).toBeNull();
  });
});

describe("the numbers in the path", () => {
  it("are rounded, so a resolution change cannot churn the attribute", () => {
    const geometry = connectorGeometry(
      { x: -24.123456, y: 100.987654 },
      { x: 0, y: 140.111111 },
    );
    expect(geometry?.path).not.toMatch(/\d\.\d{3}/);
  });

  it("honours a padding of the caller's choosing", () => {
    const geometry = connectorGeometry({ x: -24, y: 100 }, { x: 0, y: 100 }, {
      padding: 10,
    });
    expect(geometry?.height).toBe(20);
    expect(geometry?.top).toBe(90);
  });
});
