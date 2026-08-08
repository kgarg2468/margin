/**
 * Text normalization for anchoring.
 *
 * Two different normalizations live here and they exist for different reasons.
 *
 * 1. `normalizePdfText` — re-exported, not redefined. It is the whitespace
 *    collapse that `lib/pdf/extract.ts` applies when it writes the page text an
 *    anchor's character offsets address. If the reader ever normalized
 *    differently from the ingester, every stored offset would quietly point at
 *    the wrong words, so there is exactly one definition and anchoring imports
 *    it rather than growing its own `replace(/\s+/g, " ")`.
 *
 * 2. `normalizeForMatch` — a lossy *folding* used only by the fuzzy layer, when
 *    an exact quote match has already failed. A preprint and the version of
 *    record disagree about curly quotes, en dashes, ligatures, accents,
 *    capitalisation and line-break hyphenation without disagreeing about a
 *    single word. Folding those away is what turns "the same sentence, set
 *    differently" into an exact match.
 *
 * The folding carries a `map` back to the original offsets. That is the whole
 * trick: rules that change length (ﬁ → fi, dropping a line-break hyphen) are
 * allowed, because every folded character remembers where it came from and a
 * match found in folded space can be reported in the caller's coordinates.
 */

import { normalizePdfText } from "../pdf/extract";

export { normalizePdfText };

export type NormalizedText = {
  /** The folded text. */
  text: string;
  /** `map[i]` is the index in the input that `text[i]` was folded from. */
  map: number[];
  /**
   * `mapEnd[i]` is one past the last index in the input that `text[i]` was
   * folded from — the whole source character, not its first code unit.
   *
   * It exists because a source character is not always one code unit wide. A
   * range that ends inside an astral character (a mathematical italic, a rare
   * CJK glyph) has to widen to cover it rather than slicing the surrogate pair
   * in half, and `map` alone cannot say where it ends.
   */
  mapEnd: number[];
};

/**
 * Typographic variants that two typesettings of the same sentence disagree
 * about. Folded before NFKD because NFKD leaves most of them alone.
 */
const PUNCTUATION_FOLDS: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "‚": "'",
  "‛": "'",
  "′": "'",
  "´": "'",
  "`": "'",
  "“": '"',
  "”": '"',
  "„": '"',
  "‟": '"',
  "″": '"',
  "«": '"',
  "»": '"',
  "‐": "-",
  "‑": "-",
  "‒": "-",
  "–": "-",
  "—": "-",
  "―": "-",
  "−": "-",
};

/** Soft hyphens, zero-width joiners, BOMs: present in the bytes, absent from the sentence. */
const INVISIBLE = /^[­​‌‍⁠﻿]$/;

const COMBINING = /\p{M}/gu;

const WHITESPACE = /^\s+$/;

/**
 * Lowercased already by the time this is asked, so no need for A-Z.
 *
 * Letters only, deliberately. A hyphen between digits is arithmetic or a range
 * — "10-20", "pp. 114-118", "1990-1994" — and closing it up would fold those
 * into "1020", "114118", which collides with numbers that are genuinely
 * different. Line-break hyphenation only ever happens inside a word.
 */
const LETTER = /^[a-z]$/;

/**
 * One input character to its folded form — usually one character, sometimes
 * two (the `ﬁ` ligature), sometimes none (a lone combining acute).
 */
function foldChar(char: string): string {
  const direct = PUNCTUATION_FOLDS[char];
  if (direct !== undefined) {
    return direct;
  }
  // NFKD splits an accented letter into base + combining mark and expands
  // ligatures and the compatibility punctuation (… → ...); dropping the marks
  // then leaves the base letters.
  const decomposed = char.normalize("NFKD").replace(COMBINING, "").toLowerCase();
  let folded = "";
  for (const decomposedChar of decomposed) {
    folded += PUNCTUATION_FOLDS[decomposedChar] ?? decomposedChar;
  }
  return folded;
}

/**
 * Drop hyphens between words, along with any spaces around them.
 *
 * A PDF breaking "neurotransmitter" across a line leaves "neuro-" and
 * "transmitter" as separate text items, which extraction joins into
 * "neuro- transmitter". The published version has no line break there and no
 * hyphen at all.
 *
 * The spaces have to go with the hyphen for the rule to be *symmetric*, which
 * is the only property that matters here: an anchor written against one
 * typesetting is resolved against another, and a fold that treats
 * "rule — roughly" and "rule—roughly" differently makes the two sides
 * unmatchable for a reason that has nothing to do with the words. So all of
 * "neuro- transmitter", "neurotransmitter", "well-known" and "rule — roughly"
 * lose the hyphen and close up. The cost is that this text no longer reads as
 * English, which is fine: nothing ever displays it, and it is only ever
 * compared against text folded the same way.
 *
 * A hyphen with a digit on either side is left alone, because there the hyphen
 * is carrying meaning rather than typesetting: "10-20" and "1020" are two
 * different numbers, and no line break ever put that hyphen there.
 */
function dehyphenate({ text, map, mapEnd }: NormalizedText): NormalizedText {
  if (!text.includes("-")) {
    return { text, map, mapEnd };
  }
  const chars: string[] = [];
  const folded: number[] = [];
  const foldedEnd: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (char === "-") {
      // The last real character before the hyphen, looking past one space.
      let back = chars.length - 1;
      if (chars[back] === " ") {
        back--;
      }
      const previous = back >= 0 ? (chars[back] as string) : undefined;
      let resumeAt = i + 1;
      if (text[resumeAt] === " ") {
        resumeAt++;
      }
      const next = text[resumeAt];
      if (
        previous !== undefined &&
        LETTER.test(previous) &&
        next !== undefined &&
        LETTER.test(next)
      ) {
        while (chars.length - 1 > back) {
          chars.pop();
          folded.pop();
          foldedEnd.pop();
        }
        i = resumeAt - 1;
        continue;
      }
    }
    chars.push(char);
    folded.push(map[i] as number);
    foldedEnd.push(mapEnd[i] as number);
  }
  return { text: chars.join(""), map: folded, mapEnd: foldedEnd };
}

/**
 * Fold text for approximate matching, keeping a map back to the input's
 * character offsets.
 *
 * Whitespace is collapsed the same way extraction collapses it, so folding an
 * already-extracted page is idempotent on that axis.
 *
 * The walk is by code point rather than by code unit. A page that quotes a
 * mathematical italic or an emoji is rare but not impossible, and stepping
 * through it two bytes at a time would hand `foldChar` half a surrogate pair —
 * which normalizes to nothing recognisable and, worse, would let `sourceRange`
 * return an offset that splits the pair and slices a lone surrogate out of the
 * page text.
 */
export function normalizeForMatch(input: string): NormalizedText {
  const chars: string[] = [];
  const map: number[] = [];
  const mapEnd: number[] = [];
  let pendingSpace = false;
  let lastSource = -1;

  let i = 0;
  for (const char of input) {
    // `i` walks code units, because that is the coordinate system every offset
    // in an anchor is written in; `char` is a whole code point.
    const at = i;
    i += char.length;
    if (INVISIBLE.test(char)) {
      continue;
    }
    if (WHITESPACE.test(char)) {
      pendingSpace = true;
      continue;
    }
    const folded = foldChar(char);
    if (folded.length === 0) {
      continue;
    }
    if (WHITESPACE.test(folded)) {
      pendingSpace = true;
      continue;
    }
    // Leading whitespace is dropped rather than emitted, which is the trim
    // half of the contract; trailing whitespace never gets flushed.
    if (pendingSpace && chars.length > 0) {
      // Attributed to the run of whitespace it replaced — the character just
      // past the last one that survived — which keeps `map` strictly
      // increasing and makes `foldedOffset` a plain binary search.
      chars.push(" ");
      map.push(lastSource + 1);
      mapEnd.push(lastSource + 2);
    }
    pendingSpace = false;
    // One entry per code unit of the fold, because `map` is indexed by code
    // unit of `text`; every one of them points at the whole source character.
    for (let unit = 0; unit < folded.length; unit++) {
      chars.push(folded[unit] as string);
      map.push(at);
      mapEnd.push(at + char.length);
    }
    lastSource = at + char.length - 1;
  }

  return dehyphenate({ text: chars.join(""), map, mapEnd });
}

/**
 * Translate a half-open range in folded coordinates back to the input's.
 *
 * The end comes from `mapEnd[end - 1]` rather than `map[end]`: the last folded
 * character may be one of several that came from a single input character
 * (a ligature, or one half of a surrogate pair), and the range has to cover
 * all of it.
 */
export function sourceRange(
  normalized: NormalizedText,
  start: number,
  end: number,
): { start: number; end: number } | null {
  if (start < 0 || end <= start || end > normalized.map.length) {
    return null;
  }
  return {
    start: normalized.map[start] as number,
    end: normalized.mapEnd[end - 1] as number,
  };
}

/**
 * The folded offset closest to an offset in the input. Used to break ties
 * between two equally good fuzzy matches by preferring the one nearest where
 * the anchor claims to be.
 *
 * `map` is non-decreasing, so this is a binary search.
 */
export function foldedOffset(
  normalized: NormalizedText,
  sourceOffset: number,
): number {
  const { map } = normalized;
  let low = 0;
  let high = map.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((map[mid] as number) < sourceOffset) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}
