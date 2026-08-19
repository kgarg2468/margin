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
  it("leaves bracketed notation glued to a word alone", () => {
    expect(cleanQuote("the entry x[0] and values in y[12] are swapped", 100)).toBe(
      "the entry x[0] and values in y[12] are swapped",
    );
  });
  it("rejoins a word the typesetter cut across a line", () => {
    expect(cleanQuote("the assump- tion holds", 100)).toBe("the assumption holds");
    // The linebreak is still a linebreak when it reaches us unflattened.
    expect(cleanQuote("the assump-\ntion holds", 100)).toBe("the assumption holds");
  });
  it("rejoins a word broken more than once", () => {
    expect(cleanQuote("the infor- ma- tion gain", 100)).toBe(
      "the information gain",
    );
  });
  it("joins across the typographic hyphens a text layer also emits", () => {
    expect(cleanQuote("the assump‐ tion holds", 100)).toBe(
      "the assumption holds",
    );
    expect(cleanQuote("the assump‑ tion holds", 100)).toBe(
      "the assumption holds",
    );
  });
  it("drops soft hyphens, which have no glyph to justify keeping", () => {
    expect(cleanQuote("the assump­tion holds", 100)).toBe(
      "the assumption holds",
    );
  });
  it("leaves a hyphen somebody wrote alone", () => {
    // No space after it: this one came out of the text layer whole.
    expect(cleanQuote("a well-known result", 100)).toBe("a well-known result");
  });
  it("leaves a suspended compound hanging, as written", () => {
    expect(cleanQuote("the pre- and post-test scores", 100)).toBe(
      "the pre- and post-test scores",
    );
    expect(cleanQuote("intra- or inter-subject variance", 100)).toBe(
      "intra- or inter-subject variance",
    );
    // "or" only reads as the conjunction when it is the whole word — the
    // hyphen before "organising" is a break like any other.
    expect(cleanQuote("a self- organising map", 100)).toBe(
      "a selforganising map",
    );
  });
  it("leaves a dash between words alone", () => {
    expect(cleanQuote("the margin — a place to think — is blank", 100)).toBe(
      "the margin — a place to think — is blank",
    );
  });
  it("does not join across a numeric range", () => {
    expect(cleanQuote("a 3- to 5-fold increase", 100)).toBe(
      "a 3- to 5-fold increase",
    );
  });
  it("measures the cap against the healed quote, not the broken one", () => {
    // "the assumption holds here." is 26 characters; the debris made it 27.
    expect(cleanQuote("the assump- tion holds here. And more.", 27)).toBe(
      "the assumption holds here.",
    );
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
