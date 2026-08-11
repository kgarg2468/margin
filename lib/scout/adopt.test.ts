import { describe, expect, it } from "vitest";
import { adoptSeed } from "./adopt";

/**
 * The one rule: what a member's composer opens with must be pointers, not
 * prose. A finding's sentences were written by a model, and a reply table that
 * accepted them — even as a starting draft somebody then edited — would be
 * machine speech laundered into the one table this product promises is human.
 */
describe("adoptSeed", () => {
  it("carries the passages, whose page and author a reader can check", () => {
    expect(
      adoptSeed([
        { authorName: "Ana Ruiz", pageIndex: 3, quote: "incubated at 4°C overnight" },
        { authorName: "Ben Okafor", pageIndex: 7, quote: "two independent cohorts" },
      ]),
    ).toBe(
      "\n\nAna Ruiz, p. 4: “incubated at 4°C overnight”\n" +
        "Ben Okafor, p. 8: “two independent cohorts”",
    );
  });

  it("opens above the pointers, so the member types first", () => {
    expect(adoptSeed([{ authorName: "Ana Ruiz", pageIndex: 0, quote: "x" }])).toMatch(
      /^\n\n/,
    );
  });

  it("elides a passage long enough to become the reply", () => {
    const long = "a".repeat(200);
    const seeded = adoptSeed([{ authorName: "Ana Ruiz", pageIndex: 0, quote: long }]);
    expect(seeded).toContain("…");
    expect(seeded.length).toBeLessThan(160);
  });

  it("is empty when there is nothing to point at", () => {
    expect(adoptSeed([])).toBe("");
  });
});
