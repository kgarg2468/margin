/**
 * Bounded approximate substring search.
 *
 * The last resort of the re-anchoring chain: the quote is not where the anchor
 * says it is, and it is not anywhere in the page verbatim either, so the two
 * versions of the paper genuinely differ — a word was added in review, an
 * author's name was corrected, a footnote marker moved into the sentence. What
 * is left is to find the passage that is *most nearly* the quote and say how
 * near it got.
 *
 * The primitive is a semi-global alignment: full Levenshtein cost along the
 * needle, free gaps at both ends of the haystack. That is the textbook exact
 * answer to "where in this text does this string most nearly occur", and unlike
 * a sliding window it cannot miss a match that shifted by a few characters.
 *
 * Everything here is about keeping that O(needle × haystack) DP inside a
 * budget, because it runs once per annotation per page in a reader that also
 * has a PDF to paint:
 *
 * - An early exit after any row whose minimum already exceeds the distance
 *   the caller would accept. Row minima are non-decreasing down the matrix, so
 *   this is sound, and it is what makes the common "not here at all" case cheap.
 * - A cell budget. Under it, the DP runs over the whole page — exact, simple,
 *   ~2 ms for a quote against a normal page. Over it (a huge page, a long
 *   quote), the search falls back to seeding on literal substrings of the
 *   needle and running the same DP inside a band around each hit. That can miss
 *   a match with no intact 24-character run, which is the documented price of a
 *   hard bound.
 */

export type FuzzyMatch = {
  /** Half-open range in the haystack. */
  start: number;
  end: number;
  /** Levenshtein distance between the needle and the matched range. */
  distance: number;
  /** `1 - distance / needle.length`, clamped to 0. */
  score: number;
};

export type FuzzyOptions = {
  /** Reject matches below this similarity. */
  minScore?: number;
  /** Break ties between equally good matches by proximity to this offset. */
  preferNear?: number;
  /** Cells of the DP matrix the whole-haystack pass may use. */
  maxCells?: number;
};

export const DEFAULT_MIN_SCORE = 0.72;

/**
 * ~2 M cells is a few milliseconds of `Int32Array` arithmetic. A 300-character
 * quote against a 6 000-character page — a dense two-column page of a paper —
 * is 1.8 M, so the whole-haystack pass covers the real corpus and the seeded
 * fallback is for the pathological tail.
 */
export const DEFAULT_MAX_CELLS = 2_000_000;

/** Literal runs of the needle used to seed the fallback. */
const SEED_LENGTH = 24;
const MAX_SEED_HITS = 16;
const MAX_WINDOWS = 12;

type Alignment = { start: number; end: number; distance: number };

/**
 * Best alignment of `needle` anywhere in `haystack`, or `null` if every
 * alignment costs more than `maxDistance`.
 *
 * Two rows of the matrix and two rows of "where did the path reaching this cell
 * begin", which is how the start of the match comes back without a traceback
 * matrix.
 */
function align(
  haystack: string,
  needle: string,
  maxDistance: number,
  preferNear: number | undefined,
): Alignment | null {
  const rows = needle.length;
  const columns = haystack.length;
  if (rows === 0 || columns === 0) {
    return null;
  }

  let cost = new Int32Array(columns + 1);
  let origin = new Int32Array(columns + 1);
  let nextCost = new Int32Array(columns + 1);
  let nextOrigin = new Int32Array(columns + 1);

  // Row 0: a match may begin at any column for free.
  for (let column = 0; column <= columns; column++) {
    origin[column] = column;
  }

  for (let row = 1; row <= rows; row++) {
    const needleCode = needle.charCodeAt(row - 1);
    nextCost[0] = row;
    nextOrigin[0] = 0;
    let rowMinimum = row;

    for (let column = 1; column <= columns; column++) {
      const substitute =
        (cost[column - 1] as number) +
        (haystack.charCodeAt(column - 1) === needleCode ? 0 : 1);
      let best = substitute;
      let bestOrigin = origin[column - 1] as number;

      const deleteNeedleChar = (cost[column] as number) + 1;
      if (deleteNeedleChar < best) {
        best = deleteNeedleChar;
        bestOrigin = origin[column] as number;
      }
      const skipHaystackChar = (nextCost[column - 1] as number) + 1;
      if (skipHaystackChar < best) {
        best = skipHaystackChar;
        bestOrigin = nextOrigin[column - 1] as number;
      }

      nextCost[column] = best;
      nextOrigin[column] = bestOrigin;
      if (best < rowMinimum) {
        rowMinimum = best;
      }
    }

    // Row minima only ever grow, so once the whole row is out of budget no
    // alignment below it can come back into it.
    if (rowMinimum > maxDistance) {
      return null;
    }

    [cost, nextCost] = [nextCost, cost];
    [origin, nextOrigin] = [nextOrigin, origin];
  }

  let bestColumn = -1;
  let bestDistance = maxDistance + 1;
  for (let column = 1; column <= columns; column++) {
    const distance = cost[column] as number;
    if (distance > maxDistance || distance > bestDistance) {
      continue;
    }
    if (distance < bestDistance) {
      bestDistance = distance;
      bestColumn = column;
      continue;
    }
    // Equal cost. Without a preference the leftmost match wins, which keeps
    // the function deterministic.
    if (preferNear !== undefined && bestColumn >= 0) {
      if (
        Math.abs(column - preferNear) < Math.abs(bestColumn - preferNear)
      ) {
        bestColumn = column;
      }
    }
  }
  if (bestColumn < 0) {
    return null;
  }

  return {
    start: origin[bestColumn] as number,
    end: bestColumn,
    distance: bestDistance,
  };
}

/** Every occurrence of `seed`, up to a cap so a one-letter seed can't blow up. */
function seedHits(haystack: string, seed: string): number[] {
  const hits: number[] = [];
  let from = 0;
  while (hits.length < MAX_SEED_HITS) {
    const at = haystack.indexOf(seed, from);
    if (at === -1) {
      break;
    }
    hits.push(at);
    from = at + 1;
  }
  return hits;
}

/**
 * The bounded fallback: align only inside bands around places where a literal
 * run of the needle occurs.
 */
function alignSeeded(
  haystack: string,
  needle: string,
  maxDistance: number,
  preferNear: number | undefined,
): Alignment | null {
  const seedLength = Math.min(SEED_LENGTH, needle.length);
  const seedStarts = [
    0,
    Math.max(0, (needle.length - seedLength) >> 1),
    Math.max(0, needle.length - seedLength),
  ];

  const candidates = new Set<number>();
  for (const seedStart of seedStarts) {
    const seed = needle.slice(seedStart, seedStart + seedLength);
    for (const at of seedHits(haystack, seed)) {
      candidates.add(Math.max(0, at - seedStart));
    }
  }
  if (candidates.size === 0) {
    return null;
  }

  // Seeds that landed within a few characters of each other describe the same
  // window; running the DP three times over it would only cost more.
  const starts = [...candidates].sort((a, b) => a - b);
  const windows: number[] = [];
  for (const start of starts) {
    const previous = windows[windows.length - 1];
    if (previous === undefined || start - previous > 8) {
      windows.push(start);
    }
  }

  const band = maxDistance + 8;
  let best: Alignment | null = null;
  for (const start of windows.slice(0, MAX_WINDOWS)) {
    const from = Math.max(0, start - band);
    const to = Math.min(haystack.length, start + needle.length + band);
    const local = align(
      haystack.slice(from, to),
      needle,
      maxDistance,
      preferNear === undefined ? undefined : preferNear - from,
    );
    if (local === null) {
      continue;
    }
    const shifted: Alignment = {
      start: local.start + from,
      end: local.end + from,
      distance: local.distance,
    };
    if (best === null || shifted.distance < best.distance) {
      best = shifted;
    }
  }
  return best;
}

/**
 * Find the range of `haystack` that most nearly spells `needle`, or `null` if
 * nothing comes close enough.
 *
 * Both strings are expected to have been folded by `normalizeForMatch`
 * already — this function does no normalization of its own, so that the caller
 * keeps the offset map it needs to translate the answer back.
 */
export function fuzzyFind(
  haystack: string,
  needle: string,
  options: FuzzyOptions = {},
): FuzzyMatch | null {
  if (needle.length === 0 || haystack.length === 0) {
    return null;
  }

  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const maxCells = options.maxCells ?? DEFAULT_MAX_CELLS;
  const maxDistance = Math.floor(needle.length * (1 - minScore));
  if (maxDistance < 0) {
    return null;
  }

  const cells = (needle.length + 1) * (haystack.length + 1);
  const alignment =
    cells <= maxCells
      ? align(haystack, needle, maxDistance, options.preferNear)
      : alignSeeded(haystack, needle, maxDistance, options.preferNear);

  if (alignment === null || alignment.end <= alignment.start) {
    return null;
  }

  const score = 1 - alignment.distance / needle.length;
  if (score < minScore) {
    return null;
  }
  return {
    start: alignment.start,
    end: alignment.end,
    distance: alignment.distance,
    score,
  };
}
