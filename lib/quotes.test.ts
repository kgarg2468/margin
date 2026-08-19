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
  it("closes the extractor's space, and keeps the hyphen it found there", () => {
    expect(cleanQuote("the assump- tion holds", 100)).toBe(
      "the assump-tion holds",
    );
    // The linebreak is still a linebreak when it reaches us unflattened.
    expect(cleanQuote("the assump-\ntion holds", 100)).toBe(
      "the assump-tion holds",
    );
  });
  it("closes every break in a word broken more than once", () => {
    expect(cleanQuote("the infor- ma- tion gain", 100)).toBe(
      "the infor-ma-tion gain",
    );
  });
  it("never invents a word: a split compound comes back correct", () => {
    // The whole reason the hyphen survives. Extraction puts a space between
    // every pair of text items, so these arrive looking exactly like a broken
    // word — and a full join would print "costeffective" to a room.
    expect(cleanQuote("a cost- effective assay", 100)).toBe(
      "a cost-effective assay",
    );
    expect(cleanQuote("the state- of-the-art model", 100)).toBe(
      "the state-of-the-art model",
    );
    expect(cleanQuote("a self- organising map", 100)).toBe(
      "a self-organising map",
    );
  });
  it("closes the space after the typographic hyphens a text layer emits", () => {
    expect(cleanQuote("the assump\u2010 tion holds", 100)).toBe(
      "the assump\u2010tion holds",
    );
    expect(cleanQuote("the assump\u2011 tion holds", 100)).toBe(
      "the assump\u2011tion holds",
    );
  });
  it("joins a soft hyphen fully, glyph and gap alike", () => {
    // The one hyphen that proves its own discretion, so the word closes up.
    expect(cleanQuote("the assump\u00adtion holds", 100)).toBe(
      "the assumption holds",
    );
    expect(cleanQuote("the assump\u00ad tion holds", 100)).toBe(
      "the assumption holds",
    );
    expect(cleanQuote("the assump\u00ad\ntion holds", 100)).toBe(
      "the assumption holds",
    );
  });
  it("leaves a hyphen somebody wrote alone", () => {
    // No space after it: this one came out of the text layer whole.
    expect(cleanQuote("a well-known result", 100)).toBe("a well-known result");
  });
  // One case per exempted word, so that removing any of the four from the
  // guard fails a test rather than passing quietly.
  it("leaves a compound suspended on 'and' as written", () => {
    expect(cleanQuote("the pre- and post-test scores", 100)).toBe(
      "the pre- and post-test scores",
    );
  });
  it("leaves a compound suspended on 'or' as written", () => {
    expect(cleanQuote("intra- or inter-subject variance", 100)).toBe(
      "intra- or inter-subject variance",
    );
  });
  it("leaves a compound suspended on 'nor' as written", () => {
    expect(cleanQuote("neither pre- nor post-treatment", 100)).toBe(
      "neither pre- nor post-treatment",
    );
  });
  it("leaves a compound suspended on 'to' as written", () => {
    // Lowercase on both sides, so the guard is what spares it — unlike a
    // numeric range, where the digit never reaches the rule at all.
    expect(cleanQuote("a three- to five-year follow-up", 100)).toBe(
      "a three- to five-year follow-up",
    );
  });
  it("leaves a dash between words alone", () => {
    expect(cleanQuote("the margin — a place to think — is blank", 100)).toBe(
      "the margin — a place to think — is blank",
    );
  });
  it("never reaches a hyphen a digit is holding", () => {
    expect(cleanQuote("a 3- to 5-fold increase", 100)).toBe(
      "a 3- to 5-fold increase",
    );
  });
  it("measures the cap against the healed quote, not the broken one", () => {
    // "the assump-tion holds here." is 27 characters; the extractor's space
    // made it 28, which is one too many for the sentence end to fit.
    expect(cleanQuote("the assump- tion holds here. And more.", 28)).toBe(
      "the assump-tion holds here.",
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
