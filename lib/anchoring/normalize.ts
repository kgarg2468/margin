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

/** Lowercased already by the time this is asked, so no need for A-Z. */
const ALNUM = /^[a-z0-9]$/;

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
 */
function dehyphenate({ text, map }: NormalizedText): NormalizedText {
  if (!text.includes("-")) {
    return { text, map };
  }
  const chars: string[] = [];
  const folded: number[] = [];
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
        ALNUM.test(previous) &&
        next !== undefined &&
        ALNUM.test(next)
      ) {
        while (chars.length - 1 > back) {
          chars.pop();
          folded.pop();
        }
        i = resumeAt - 1;
        continue;
      }
    }
    chars.push(char);
    folded.push(map[i] as number);
  }
  return { text: chars.join(""), map: folded };
}

/**
 * Fold text for approximate matching, keeping a map back to the input's
 * character offsets.
 *
 * Whitespace is collapsed the same way extraction collapses it, so folding an
 * already-extracted page is idempotent on that axis.
 */
export function normalizeForMatch(input: string): NormalizedText {
  const chars: string[] = [];
  const map: number[] = [];
  let pendingSpace = false;
  let lastSource = -1;

  for (let i = 0; i < input.length; i++) {
    const char = input[i] as string;
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
    }
    pendingSpace = false;
    for (const foldedChar of folded) {
      chars.push(foldedChar);
      map.push(i);
    }
    lastSource = i;
  }

  return dehyphenate({ text: chars.join(""), map });
}

/**
 * Translate a half-open range in folded coordinates back to the input's.
 *
 * The end is `map[end - 1] + 1` rather than `map[end]`: the last folded
 * character may be one of several that came from a single input character
 * (a ligature), and the range has to cover all of it.
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
    end: (normalized.map[end - 1] as number) + 1,
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
