import { describe, expect, it } from "vitest";
import { fuzzyFind } from "./fuzzy";

describe("fuzzyFind", () => {
  it("finds an exact occurrence with distance zero", () => {
    const match = fuzzyFind("the dorsal raphe nucleus", "dorsal raphe");
    expect(match).toMatchObject({ start: 4, end: 16, distance: 0, score: 1 });
  });

  it("absorbs a substitution", () => {
    const match = fuzzyFind("the dorsal raphe nucleus", "dorsel raphe");
    expect(match?.distance).toBe(1);
    expect("the dorsal raphe nucleus".slice(match?.start, match?.end)).toBe(
      "dorsal raphe",
    );
  });

  it("absorbs an inserted word", () => {
    const haystack = "serotonin release closely tracked patch value here";
    const match = fuzzyFind(haystack, "serotonin release tracked patch value");
    expect(match).not.toBeNull();
    expect(haystack.slice(match?.start, match?.end)).toBe(
      "serotonin release closely tracked patch value",
    );
  });

  it("absorbs a deletion at the end of the needle", () => {
    const haystack = "alpha beta gamma delta";
    const match = fuzzyFind(haystack, "beta gamma delt");
    expect(haystack.slice(match?.start, match?.end)).toBe("beta gamma delt");
  });

  it("refuses a match that is too far away", () => {
    expect(
      fuzzyFind("grid cells in the entorhinal cortex", "dorsal raphe nucleus"),
    ).toBeNull();
  });

  it("respects a caller's threshold", () => {
    const haystack = "the dorsal raphe nucleus";
    expect(fuzzyFind(haystack, "dorsel rafe", { minScore: 0.6 })).not.toBeNull();
    expect(fuzzyFind(haystack, "dorsel rafe", { minScore: 0.95 })).toBeNull();
  });

  it("is deterministic between equally good matches, preferring the leftmost", () => {
    const haystack = "beta gamma ... beta gamma";
    expect(fuzzyFind(haystack, "beta gamma")?.start).toBe(0);
  });

  it("breaks ties toward a caller's expected position", () => {
    const haystack = "beta gamma ... beta gamma";
    const match = fuzzyFind(haystack, "beta gamma", { preferNear: 25 });
    expect(haystack.slice(match?.start, match?.end)).toBe("beta gamma");
    expect(match?.start).toBe(15);
  });

  it("returns null for degenerate inputs", () => {
    expect(fuzzyFind("", "abc")).toBeNull();
    expect(fuzzyFind("abc", "")).toBeNull();
  });

  it("falls back to a seeded search when the full matrix is over budget", () => {
    const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit. ";
    const needle =
      "serotonin release tracked patch value, not reward rate, in the raphe";
    const haystack = `${filler.repeat(400)}${needle}${filler.repeat(400)}`;
    // Forcing the budget below the matrix size takes the seeded path.
    const match = fuzzyFind(haystack, needle, { maxCells: 1000 });
    expect(haystack.slice(match?.start, match?.end)).toBe(needle);
  });

  it("gives up rather than scanning when no seed of the needle occurs", () => {
    const haystack = "z".repeat(50_000);
    const needle = "serotonin release tracked patch value in the dorsal raphe";
    expect(fuzzyFind(haystack, needle, { maxCells: 1000 })).toBeNull();
  });

  it("stays fast on a page-sized haystack that does not contain the needle", () => {
    const haystack = "lorem ipsum dolor sit amet. ".repeat(300);
    const needle = "the dorsal raphe nucleus projects to the forebrain";
    const started = performance.now();
    for (let i = 0; i < 20; i++) {
      expect(fuzzyFind(haystack, needle)).toBeNull();
    }
    // The early exit is what makes this cheap; without it this is ~8 M cells
    // per call. Generous enough not to flake on a loaded CI runner.
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
