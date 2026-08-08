/**
 * Passage anchors: creating them, and finding them again.
 *
 * This is the piece `.context/architecture-decision.md` calls core IP. An
 * annotation is worthless if it cannot say which sentence it is about a year
 * later, against a PDF that may not be byte-identical to the one it was written
 * on — a preprint swapped for the version of record, a re-extraction under a
 * newer pdf.js, a page whose two columns were read in a different order.
 *
 * The shape is W3C Web Annotation's, and the redundancy is the point:
 *
 * - a `TextQuoteSelector` (`quote`, plus `prefix`/`suffix` context), which
 *   survives the text moving, and
 * - a `TextPositionSelector` (`start`/`end` offsets into the page's extracted
 *   text), which is exact and free when nothing moved.
 *
 * `resolveAnchor` walks them in cost order and never trusts one without
 * checking it against another. It reports *how* it found the passage and how
 * sure it is, because a margin note re-anchored by fuzzy match at 0.8 is a
 * different object to one that landed on its recorded offset, and the reader
 * should be able to say so.
 */

import {
  foldedOffset,
  normalizeForMatch,
  sourceRange,
} from "./normalize";
import { DEFAULT_MIN_SCORE, fuzzyFind } from "./fuzzy";

/**
 * Long enough to identify any passage a person selects on purpose; short
 * enough that a thousand annotations stay a small table. A longer drag is
 * clipped rather than stored, so `quote` and `start`/`end` always agree.
 */
export const MAX_QUOTE_LENGTH = 300;

/** Characters of context either side. Enough to separate repeated sentences. */
export const CONTEXT_LENGTH = 32;

/**
 * Fewer characters than this and there is nothing to re-anchor with.
 *
 * "the" occurs eighty times on a page; an anchor holding it says almost
 * nothing about which "the" was meant, and every layer below — exact search,
 * context disambiguation, fuzzy alignment — degenerates into a coin toss. A
 * selection this small is a mis-drag, so `createAnchor` refuses it and the
 * server refuses it again.
 */
export const MIN_QUOTE_CHARS = 4;

/**
 * Above this length a quote is specific enough that finding it at its recorded
 * offset is evidence in itself.
 *
 * Below it, the offsets need a second opinion: see `resolveAnchor`, step 1.
 */
export const POSITION_TRUST_CHARS = 12;

/** Characters that are not whitespace — the only ones that carry identity. */
export function significantLength(text: string): number {
  let count = 0;
  for (const char of text) {
    if (!WHITESPACE.test(char)) {
      count++;
    }
  }
  return count;
}

/** The selector pair, exactly as `convex/schema.ts` stores it. */
export type TextAnchor = {
  quote: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
  pageIndex: number;
};

/**
 * Which selector actually found the passage, in descending order of trust:
 *
 * - `position` — the recorded offsets still hold the recorded quote.
 * - `quote` — the quote occurs exactly once, elsewhere.
 * - `context` — the quote occurs several times and `prefix`/`suffix` picked one.
 * - `fuzzy` — nothing matched verbatim; the nearest passage was aligned.
 */
export type AnchorMethod = "position" | "quote" | "context" | "fuzzy";

export type ResolvedAnchor = {
  /** Half-open range in the page text the anchor was resolved against. */
  start: number;
  end: number;
  method: AnchorMethod;
  /** 0–1. Only `position` and a unique `quote` ever reach 1. */
  confidence: number;
  /** The passage could not be told apart from another candidate. */
  ambiguous: boolean;
};

export type ResolveOptions = {
  /** Similarity below which a fuzzy match is refused and the anchor orphaned. */
  minScore?: number;
  /**
   * Whether the recorded offsets address the same string this `pageText` is.
   *
   * Defaults to true. A caller that knows the text it holds was reconstructed
   * differently from the one the anchor was written against — the reader
   * comparing a rendered pdf.js text layer against the extracted page, say —
   * passes `false`, and the position fast path is skipped in favour of the
   * selectors that do not depend on offsets meaning anything.
   */
  trustPosition?: boolean;
};

/** A page's worth of occurrences is plenty; a quote that common is ambiguous anyway. */
const MAX_EXACT_CANDIDATES = 64;

const WHITESPACE = /\s/;

/**
 * Build an anchor for the half-open selection `[start, end)` of `pageText`.
 *
 * Returns `null` for a selection with nothing to anchor to — a stray click, a
 * drag that only crossed whitespace, or a handful of characters too short to
 * identify a passage (`MIN_QUOTE_CHARS`). Callers treat that as "nothing to
 * annotate" rather than as an error.
 */
export function createAnchor(
  pageText: string,
  start: number,
  end: number,
  pageIndex: number,
): TextAnchor | null {
  const length = pageText.length;
  let from = Math.max(0, Math.min(length, Math.min(start, end)));
  let to = Math.max(0, Math.min(length, Math.max(start, end)));

  // A quote that begins or ends in whitespace is a quote that re-anchors badly:
  // the edges are exactly where two typesettings disagree.
  while (from < to && WHITESPACE.test(pageText[from] as string)) {
    from++;
  }
  while (to > from && WHITESPACE.test(pageText[to - 1] as string)) {
    to--;
  }
  if (to === from) {
    return null;
  }
  if (to - from > MAX_QUOTE_LENGTH) {
    to = from + MAX_QUOTE_LENGTH;
  }
  if (significantLength(pageText.slice(from, to)) < MIN_QUOTE_CHARS) {
    return null;
  }

  return {
    quote: pageText.slice(from, to),
    prefix: pageText.slice(Math.max(0, from - CONTEXT_LENGTH), from),
    suffix: pageText.slice(to, Math.min(length, to + CONTEXT_LENGTH)),
    start: from,
    end: to,
    pageIndex,
  };
}

/** Length of the longest shared tail of two strings. */
function sharedTail(a: string, b: string): number {
  let shared = 0;
  while (
    shared < a.length &&
    shared < b.length &&
    a[a.length - 1 - shared] === b[b.length - 1 - shared]
  ) {
    shared++;
  }
  return shared;
}

/** Length of the longest shared head of two strings. */
function sharedHead(a: string, b: string): number {
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) {
    shared++;
  }
  return shared;
}

function exactOccurrences(
  pageText: string,
  quote: string,
): { hits: number[]; truncated: boolean } {
  const hits: number[] = [];
  let at = pageText.indexOf(quote);
  while (at !== -1 && hits.length < MAX_EXACT_CANDIDATES) {
    hits.push(at);
    at = pageText.indexOf(quote, at + 1);
  }
  // There is at least one more copy than we looked at, so "the best of these"
  // is not the same claim as "the best on the page".
  return { hits, truncated: at !== -1 };
}

/**
 * How well the text around `[start, end)` matches a recorded context.
 * Counted in characters, so a longer agreement wins over a shorter one.
 */
function contextScoreAt(
  prefix: string,
  suffix: string,
  text: string,
  start: number,
  end: number,
): number {
  const before = text.slice(Math.max(0, start - prefix.length), start);
  const after = text.slice(end, end + suffix.length);
  return sharedTail(prefix, before) + sharedHead(suffix, after);
}

/** `contextScoreAt` for an occurrence of the anchor's own quote. */
function contextScore(
  anchor: TextAnchor,
  pageText: string,
  at: number,
): number {
  return contextScoreAt(
    anchor.prefix,
    anchor.suffix,
    pageText,
    at,
    at + anchor.quote.length,
  );
}

/**
 * Find an anchor's passage in a page of extracted text.
 *
 * `null` means orphaned: the passage is not in this page in any recognisable
 * form. That is a real state — the reader shows those annotations in the rail
 * under "unanchored", with their quote, rather than dropping them.
 */
export function resolveAnchor(
  anchor: TextAnchor,
  pageText: string,
  options: ResolveOptions = {},
): ResolvedAnchor | null {
  const { quote } = anchor;
  if (quote.length === 0 || pageText.length === 0) {
    return null;
  }

  // 1. The recorded offsets, verified against the recorded quote. The overwhelmingly
  //    common case — same file, same extraction — and it costs one comparison.
  //
  //    Finding the quote at its offset is not on its own proof that this is the
  //    passage: a short quote occurs all over a page, and an offset that has
  //    gone stale — a reflowed column, a re-extraction — can land on a copy of
  //    the words in a different sentence and be believed at confidence 1. So
  //    the offset has to be corroborated by something, either the context
  //    either side agreeing at all, or the quote being long enough that its
  //    presence at that exact offset is not a coincidence. Uncorroborated, the
  //    fast path is skipped and the slower selectors decide, which they are
  //    perfectly able to do.
  if (
    options.trustPosition !== false &&
    anchor.start >= 0 &&
    pageText.startsWith(quote, anchor.start) &&
    (contextScore(anchor, pageText, anchor.start) > 0 ||
      significantLength(quote) >= POSITION_TRUST_CHARS)
  ) {
    return {
      start: anchor.start,
      end: anchor.start + quote.length,
      method: "position",
      confidence: 1,
      ambiguous: false,
    };
  }

  // 2. The text moved but is otherwise intact.
  const { hits, truncated } = exactOccurrences(pageText, quote);
  if (hits.length === 1) {
    const at = hits[0] as number;
    return {
      start: at,
      end: at + quote.length,
      method: "quote",
      confidence: 1,
      ambiguous: false,
    };
  }

  // 3. Several copies of the same sentence — a running header, a repeated
  //    definition, a table label. This is what the context selectors are for.
  if (hits.length > 1) {
    let best = hits[0] as number;
    let bestScore = contextScore(anchor, pageText, best);
    let tied = false;
    for (const at of hits.slice(1)) {
      const score = contextScore(anchor, pageText, at);
      if (score > bestScore) {
        best = at;
        bestScore = score;
        tied = false;
      } else if (score === bestScore) {
        // Equal context. Fall back to the position selector as a tie-break and
        // record that the answer was a guess.
        tied = true;
        if (Math.abs(at - anchor.start) < Math.abs(best - anchor.start)) {
          best = at;
        }
      }
    }
    // A truncated candidate list is only safe to pick from when one copy
    // actually won on context: "the best of the first 64" is otherwise a
    // statement about the search, not about the page.
    const decided = !tied && bestScore > 0;
    const ambiguous = tied || (truncated && !decided);
    return {
      start: best,
      end: best + quote.length,
      method: "context",
      confidence: ambiguous ? 0.6 : 0.95,
      ambiguous,
    };
  }

  // 4. The passage is not here verbatim. Fold both sides — case, accents,
  //    ligatures, curly quotes, line-break hyphenation — and align.
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const haystack = normalizeForMatch(pageText);
  const needle = normalizeForMatch(quote);
  if (needle.text.length === 0) {
    return null;
  }

  const match = fuzzyFind(haystack.text, needle.text, {
    minScore,
    preferNear: foldedOffset(haystack, anchor.end),
  });
  if (match === null) {
    return null;
  }

  // The alignment cost alone cannot separate two copies of the same sentence —
  // a repeated definition, a caption running across every figure — and it is
  // the reason the anchor carries prefix and suffix at all. Fold them the same
  // way the page was folded and let them break the tie, exactly as step 3 does
  // for exact matches.
  //
  // Folded as one string and then cut, rather than folded separately: the
  // folding trims, so `normalizeForMatch(prefix)` loses the space between the
  // context and the quote — the very character the comparison starts at.
  const context = normalizeForMatch(
    anchor.prefix + anchor.quote + anchor.suffix,
  );
  const prefix = context.text.slice(
    0,
    foldedOffset(context, anchor.prefix.length),
  );
  const suffix = context.text.slice(
    foldedOffset(context, anchor.prefix.length + anchor.quote.length),
  );
  const scoreOf = (candidate: { start: number; end: number }) =>
    contextScoreAt(prefix, suffix, haystack.text, candidate.start, candidate.end);

  let chosen = match as { start: number; end: number; distance: number };
  let chosenContext = scoreOf(match);
  let separated = true;
  for (const alternative of match.alternatives) {
    const context = scoreOf(alternative);
    if (context > chosenContext) {
      chosen = alternative;
      chosenContext = context;
      separated = true;
    } else if (context === chosenContext) {
      separated = false;
    }
  }

  // Near-tied on distance *and* unseparated by context is the honest
  // definition of "could be either one".
  const runnerUp = match.runnerUpDistance;
  const ambiguous =
    runnerUp !== null && runnerUp - match.distance <= 1 && !separated;

  const range = sourceRange(haystack, chosen.start, chosen.end);
  if (range === null) {
    return null;
  }
  const score = 1 - chosen.distance / needle.text.length;

  return {
    start: range.start,
    end: range.end,
    method: "fuzzy",
    // Never 1: a fold matched, the characters did not. The reader uses the gap
    // to mark a note as having drifted.
    confidence: Math.min(ambiguous ? 0.6 : 0.95, Math.max(0, score)),
    ambiguous,
  };
}
