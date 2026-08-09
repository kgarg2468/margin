import { describe, expect, it } from "vitest";
import { citationNumbering } from "./numbering";

describe("citationNumbering", () => {
  it("numbers by first appearance across sections", () => {
    const map = citationNumbering([
      { annotationIds: ["b", "a"] },
      { annotationIds: ["c", "a"] },
    ]);
    expect(map.get("b")).toBe(1);
    expect(map.get("a")).toBe(2);
    expect(map.get("c")).toBe(3);
  });

  it("is stable for repeats — a note keeps its number", () => {
    const map = citationNumbering([
      { annotationIds: ["a"] },
      { annotationIds: ["a", "b"] },
      { annotationIds: ["b"] },
    ]);
    expect(map.get("a")).toBe(1);
    expect(map.get("b")).toBe(2);
    expect(map.size).toBe(2);
  });

  it("returns an empty map for no sections", () => {
    expect(citationNumbering([]).size).toBe(0);
  });

  it("skips nothing and leaves no gaps — the numbers are 1..n", () => {
    // What the page renders is `Note {map.get(id)}`, so a sequence with a hole
    // in it reads as a citation the reader was not shown. Callers pass ids
    // they have already filtered to what is visible, and the fold's contract
    // is that whatever arrives comes back numbered contiguously.
    const map = citationNumbering([
      { annotationIds: ["a", "b"] },
      { annotationIds: [] },
      { annotationIds: ["c", "b", "d"] },
    ]);
    expect([...map.values()].sort((x, y) => x - y)).toEqual([1, 2, 3, 4]);
  });
});
