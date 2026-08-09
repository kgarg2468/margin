import { describe, expect, it } from "vitest";
import { cleanQuote } from "./quotes";

describe("cleanQuote", () => {
  it("collapses whitespace", () => {
    expect(cleanQuote("attention  is\n all you   need.", 100)).toBe(
      "attention is all you need.",
    );
  });
  it("strips [nn] and [nn, mm] citation debris, healing the gap", () => {
    expect(
      cleanQuote("as shown in prior work [12] the model [3, 14] converges.", 100),
    ).toBe("as shown in prior work the model converges.");
  });
  it("cuts at the last sentence end that fits", () => {
    expect(
      cleanQuote("First point. Second point continues well past the cap.", 20),
    ).toBe("First point.");
  });
  it("falls back to a word boundary with an ellipsis when no sentence fits", () => {
    expect(cleanQuote("one unbroken clause that runs long", 15)).toBe("one unbroken…");
  });
  it("keeps short quotes untouched", () => {
    expect(cleanQuote("Short and whole.", 100)).toBe("Short and whole.");
  });
  it("only trusts a sentence end past forty percent of the cap", () => {
    // "Dr." at position 3 is not a resting place worth cutting to.
    expect(cleanQuote("Dr. Vaswani proposed attention mechanisms", 30)).toBe(
      "Dr. Vaswani proposed…",
    );
  });
});
