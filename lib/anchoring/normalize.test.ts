import { describe, expect, it } from "vitest";
import {
  foldedOffset,
  normalizeForMatch,
  normalizePdfText,
  sourceRange,
} from "./normalize";

/** Every folded character must point at a character it could have come from. */
function assertMapIsSane(input: string, folded: ReturnType<typeof normalizeForMatch>) {
  expect(folded.map).toHaveLength(folded.text.length);
  let previous = -1;
  for (const index of folded.map) {
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(input.length);
    expect(index).toBeGreaterThanOrEqual(previous);
    previous = index;
  }
}

describe("normalizePdfText", () => {
  it("collapses whitespace and trims, which is the contract offsets are stored against", () => {
    expect(normalizePdfText("  the  \n cortex \t ")).toBe("the cortex");
  });
});

describe("normalizeForMatch", () => {
  it("is idempotent on already-extracted text", () => {
    const extracted = normalizePdfText("the dorsal   raphe nucleus");
    expect(normalizeForMatch(extracted).text).toBe(extracted);
  });

  it("folds case, curly quotes and dashes", () => {
    expect(normalizeForMatch("The “Hebbian” rule and so on").text).toBe(
      'the "hebbian" rule and so on',
    );
    expect(normalizeForMatch("don’t").text).toBe("don't");
  });

  it("folds accents whether precomposed or decomposed", () => {
    const precomposed = "Poincar\u00e9";
    const decomposed = "Poincare\u0301";
    expect(precomposed).not.toBe(decomposed);
    expect(normalizeForMatch(precomposed).text).toBe("poincare");
    expect(normalizeForMatch(decomposed).text).toBe("poincare");
  });

  it("expands ligatures and maps both halves back to the one source character", () => {
    const input = "the ﬁeld";
    const folded = normalizeForMatch(input);
    expect(folded.text).toBe("the field");
    assertMapIsSane(input, folded);
    // "fi" both came from the single ligature character.
    expect(folded.map[4]).toBe(4);
    expect(folded.map[5]).toBe(4);
    expect(folded.map[6]).toBe(5);
  });

  it("drops soft hyphens and zero-width characters", () => {
    expect(normalizeForMatch("co\u00adoperate\u200b").text).toBe("cooperate");
  });

  it("folds line-break hyphenation the same way from either side", () => {
    const joined = normalizeForMatch("neurotransmitter release").text;
    expect(normalizeForMatch("neuro- transmitter release").text).toBe(joined);
    expect(normalizeForMatch("neuro-transmitter release").text).toBe(joined);
    expect(normalizeForMatch("neuro -transmitter release").text).toBe(joined);
  });

  it("folds a spaced dash the same way as a tight one, or the two sides never meet", () => {
    const tight = normalizeForMatch("rule—roughly").text;
    expect(normalizeForMatch("rule - roughly").text).toBe(tight);
    expect(normalizeForMatch("rule – roughly").text).toBe(tight);
  });

  it("keeps a dash that is not joining two words", () => {
    expect(normalizeForMatch("- item").text).toBe("- item");
    expect(normalizeForMatch("well -").text).toBe("well -");
    expect(normalizeForMatch("a -- b").text).toBe("a -- b");
  });

  it("collapses whitespace and keeps the map monotonic", () => {
    const input = "  the   dorsal\nraphe  ";
    const folded = normalizeForMatch(input);
    expect(folded.text).toBe("the dorsal raphe");
    assertMapIsSane(input, folded);
    // The space stands for the whitespace run it replaced, so it points at the
    // first character of that run.
    expect(input[folded.map[3] as number]).toBe(" ");
  });
});

describe("sourceRange", () => {
  it("maps a folded range back onto the input", () => {
    const input = "The “dorsal raphe” nucleus";
    const folded = normalizeForMatch(input);
    const at = folded.text.indexOf("dorsal raphe");
    const range = sourceRange(folded, at, at + "dorsal raphe".length);
    expect(range).not.toBeNull();
    expect(input.slice(range?.start, range?.end)).toBe("dorsal raphe");
  });

  it("covers the whole source character when a fold expanded it", () => {
    const input = "the ﬁeld";
    const folded = normalizeForMatch(input);
    const at = folded.text.indexOf("field");
    const range = sourceRange(folded, at, at + 5);
    expect(input.slice(range?.start, range?.end)).toBe("ﬁeld");
  });

  it("refuses ranges that are empty or out of bounds", () => {
    const folded = normalizeForMatch("abc");
    expect(sourceRange(folded, 1, 1)).toBeNull();
    expect(sourceRange(folded, -1, 2)).toBeNull();
    expect(sourceRange(folded, 0, 99)).toBeNull();
  });
});

describe("foldedOffset", () => {
  it("finds the folded position of a source offset", () => {
    const input = "The  DORSAL raphe";
    const folded = normalizeForMatch(input);
    expect(folded.text).toBe("the dorsal raphe");
    expect(foldedOffset(folded, input.indexOf("DORSAL"))).toBe(
      folded.text.indexOf("dorsal"),
    );
  });

  it("clamps past the end", () => {
    const folded = normalizeForMatch("abc");
    expect(foldedOffset(folded, 100)).toBe(3);
    expect(foldedOffset(folded, -5)).toBe(0);
  });
});
