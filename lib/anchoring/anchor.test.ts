import { describe, expect, it } from "vitest";
import type { TextAnchor } from "./anchor";
import {
  CONTEXT_LENGTH,
  MAX_QUOTE_LENGTH,
  createAnchor,
  resolveAnchor,
} from "./anchor";

/**
 * A page of a real-shaped paper: one sentence repeated verbatim (a running
 * definition), which is the case the context selectors exist for.
 */
const PAGE =
  "We recorded from the dorsal raphe nucleus during foraging. " +
  "Serotonin release tracked patch value, not reward rate. " +
  "The dorsal raphe nucleus is the principal source of forebrain serotonin. " +
  "In a second cohort we replicated the effect under satiety. " +
  "The dorsal raphe nucleus is the principal source of forebrain serotonin.";

function anchorOn(page: string, quote: string, occurrence = 0): TextAnchor {
  let at = page.indexOf(quote);
  for (let i = 0; i < occurrence; i++) {
    at = page.indexOf(quote, at + 1);
  }
  const anchor = createAnchor(page, at, at + quote.length, 3);
  if (anchor === null) {
    throw new Error(`no anchor for ${quote}`);
  }
  return anchor;
}

describe("createAnchor", () => {
  it("records the quote with context either side", () => {
    const anchor = anchorOn(PAGE, "Serotonin release tracked patch value");
    expect(anchor.quote).toBe("Serotonin release tracked patch value");
    expect(anchor.prefix).toHaveLength(CONTEXT_LENGTH);
    expect(anchor.prefix.endsWith("during foraging. ")).toBe(true);
    expect(anchor.suffix.startsWith(", not reward rate")).toBe(true);
    expect(anchor.pageIndex).toBe(3);
    expect(PAGE.slice(anchor.start, anchor.end)).toBe(anchor.quote);
  });

  it("trims whitespace off both edges of a sloppy drag", () => {
    const page = "alpha beta gamma";
    const anchor = createAnchor(page, 5, 11, 0);
    expect(anchor?.quote).toBe("beta");
    expect(page.slice(anchor?.start, anchor?.end)).toBe("beta");
  });

  it("normalises a backwards selection", () => {
    const forwards = createAnchor(PAGE, 20, 40, 0);
    const backwards = createAnchor(PAGE, 40, 20, 0);
    expect(backwards).toEqual(forwards);
  });

  it("clamps out-of-range offsets rather than producing a short quote", () => {
    const page = "alpha beta";
    expect(createAnchor(page, -10, 5, 0)?.quote).toBe("alpha");
    expect(createAnchor(page, 6, 999, 0)?.quote).toBe("beta");
  });

  it("caps the quote, keeping start/end in agreement with it", () => {
    const page = "x".repeat(1000);
    const anchor = createAnchor(page, 0, 1000, 0);
    expect(anchor?.quote).toHaveLength(MAX_QUOTE_LENGTH);
    expect(anchor?.end).toBe(MAX_QUOTE_LENGTH);
    expect(page.slice(anchor?.start, anchor?.end)).toBe(anchor?.quote);
  });

  it("shortens context at the edges of the page instead of padding it", () => {
    const anchor = createAnchor(PAGE, 0, 2, 0);
    expect(anchor?.prefix).toBe("");
    expect(createAnchor(PAGE, PAGE.length - 2, PAGE.length, 0)?.suffix).toBe("");
  });

  it("returns null for a selection with no text in it", () => {
    expect(createAnchor(PAGE, 10, 10, 0)).toBeNull();
    expect(createAnchor("alpha   beta", 5, 8, 0)).toBeNull();
    expect(createAnchor("", 0, 0, 0)).toBeNull();
  });
});

describe("resolveAnchor", () => {
  it("takes the recorded offsets when they still hold the quote", () => {
    const anchor = anchorOn(PAGE, "foraging");
    const resolved = resolveAnchor(anchor, PAGE);
    expect(resolved).toMatchObject({
      start: anchor.start,
      end: anchor.end,
      method: "position",
      confidence: 1,
    });
  });

  it("finds a passage that moved, when it is the only copy", () => {
    const anchor = anchorOn(PAGE, "replicated the effect under satiety");
    const shifted = `A paragraph inserted by a reviewer. ${PAGE}`;
    const resolved = resolveAnchor(anchor, shifted);
    expect(resolved?.method).toBe("quote");
    expect(resolved?.confidence).toBe(1);
    expect(shifted.slice(resolved?.start, resolved?.end)).toBe(anchor.quote);
  });

  it("uses prefix and suffix to pick between identical copies", () => {
    const repeated = "The dorsal raphe nucleus is the principal source";
    const second = anchorOn(PAGE, repeated, 1);
    // Shift everything so the position selector is useless.
    const shifted = `${"-".repeat(200)}${PAGE}`;
    const resolved = resolveAnchor(second, shifted);
    expect(resolved?.method).toBe("context");
    expect(resolved?.ambiguous).toBe(false);
    expect(resolved?.start).toBe(second.start + 200);
  });

  it("admits ambiguity when the copies have identical context too", () => {
    // Anchored at the very start of its page, so it carries no prefix to tell
    // the two copies apart with.
    const original = "alpha beta gamma.";
    const anchor = createAnchor(original, 0, 10, 0);
    expect(anchor?.quote).toBe("alpha beta");
    const rewritten = "q alpha beta gamma. alpha beta gamma.";
    const resolved = resolveAnchor(anchor as TextAnchor, rewritten);
    expect(resolved?.method).toBe("context");
    expect(resolved?.ambiguous).toBe(true);
    expect(resolved?.confidence).toBeLessThan(0.75);
    // Ambiguous, but it still lands on the copy nearest the recorded offset.
    expect(resolved?.start).toBe(2);
  });

  it("re-anchors across line-break hyphenation", () => {
    const anchor = anchorOn(
      "Serotonin is a neurotransmitter released in the raphe.",
      "neurotransmitter released",
    );
    const reflowed =
      "Serotonin is a neuro- transmitter released in the raphe, mostly.";
    const resolved = resolveAnchor(anchor, reflowed);
    expect(resolved?.method).toBe("fuzzy");
    expect(reflowed.slice(resolved?.start, resolved?.end)).toBe(
      "neuro- transmitter released",
    );
  });

  it("re-anchors across typographic drift the publisher introduced", () => {
    const preprint = 'The "Hebbian" rule - roughly, fire together, wire together';
    const anchor = anchorOn(preprint, '"Hebbian" rule - roughly');
    const published =
      "The “Hebbian” rule — roughly, fire together, wire together";
    const resolved = resolveAnchor(anchor, published);
    expect(resolved?.method).toBe("fuzzy");
    expect(resolved?.confidence).toBeGreaterThan(0.8);
    expect(published.slice(resolved?.start, resolved?.end)).toContain("Hebbian");
  });

  it("re-anchors when a word was added in review", () => {
    const anchor = anchorOn(PAGE, "Serotonin release tracked patch value");
    const revised = PAGE.replace(
      "Serotonin release tracked patch value",
      "Serotonin release closely tracked patch value",
    );
    const resolved = resolveAnchor(anchor, revised);
    expect(resolved?.method).toBe("fuzzy");
    expect(resolved?.confidence).toBeLessThan(1);
    expect(revised.slice(resolved?.start, resolved?.end)).toContain(
      "tracked patch value",
    );
  });

  it("orphans an anchor whose passage is simply gone", () => {
    const anchor = anchorOn(PAGE, "replicated the effect under satiety");
    const other =
      "Grid cells in the medial entorhinal cortex fire in a hexagonal lattice.";
    expect(resolveAnchor(anchor, other)).toBeNull();
  });

  it("orphans rather than accepting a match below the caller's threshold", () => {
    const anchor = anchorOn(PAGE, "Serotonin release tracked patch value");
    const mangled = PAGE.replace(
      "Serotonin release tracked patch value",
      "Dopamine signals encoded prediction error",
    );
    expect(resolveAnchor(anchor, mangled, { minScore: 0.9 })).toBeNull();
  });

  it("orphans an empty quote or an empty page", () => {
    const anchor = anchorOn(PAGE, "foraging");
    expect(resolveAnchor({ ...anchor, quote: "" }, PAGE)).toBeNull();
    expect(resolveAnchor(anchor, "")).toBeNull();
  });

  it("does not trust stale offsets that happen to be in range", () => {
    const anchor = anchorOn(PAGE, "foraging");
    const resolved = resolveAnchor({ ...anchor, start: 0, end: 8 }, PAGE);
    expect(resolved?.method).not.toBe("position");
    expect(PAGE.slice(resolved?.start, resolved?.end)).toBe("foraging");
  });

  it("handles a quote at the very start and the very end of a page", () => {
    const first = anchorOn(PAGE, "We recorded");
    expect(resolveAnchor(first, PAGE)?.start).toBe(0);
    const lastQuote = "forebrain serotonin.";
    const last = anchorOn(PAGE, lastQuote, 1);
    expect(resolveAnchor(last, PAGE)?.end).toBe(PAGE.length);
  });
});
