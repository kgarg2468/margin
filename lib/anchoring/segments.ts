/**
 * The bridge between what the browser lets you select and what an anchor
 * addresses.
 *
 * pdf.js's text layer is a pile of absolutely-positioned `<span>`s, one per
 * text item, sitting invisibly over the rendered canvas. A selection there is a
 * DOM range: (text node, offset in that node). An anchor, though, is a pair of
 * character offsets into the *extracted page text* — a single normalized string
 * that `lib/pdf/extract.ts` built by concatenating the same items with a space
 * between them and collapsing whitespace.
 *
 * Converting between the two is the hard part of the reader, and it is hard in
 * a boring way: whitespace collapse means the two strings have different
 * lengths, so nothing can be computed by arithmetic. This module builds the map
 * explicitly, one character at a time, and keeps it.
 *
 * It is deliberately DOM-free. It takes segments — strings, plus a flag for
 * whether extraction would have put a break before each one — so that the
 * mapping can be tested exhaustively without a browser. `text-layer.ts` is the
 * thin adapter that pulls segments out of a real text layer.
 */

/**
 * One run of text. `break` marks the start of a new pdf.js text item, which
 * extraction separated from the previous one with a space.
 */
export type Segment = { text: string; break: boolean };

export type SegmentIndex = {
  /**
   * The page text these segments produce — identical to what
   * `normalizePdfText` produced at ingest for the same items.
   */
  text: string;
  /** For character `i` of `text`: which segment it came from. */
  segment: number[];
  /** For character `i` of `text`: its offset inside that segment. */
  offset: number[];
  /** For segment `s`: the first index of `text` it produced, or -1. */
  firstIndex: number[];
  /** For segment `s`: the last index of `text` it produced, or -1. */
  lastIndex: number[];
};

const WHITESPACE = /\s/;

/**
 * Build the page text and the offset map.
 *
 * The collapse rule mirrors extraction exactly: runs of whitespace — including
 * the synthetic break between two items — become one space, and the string is
 * trimmed at both ends. A collapsed space is attributed to the position just
 * past the last character that survived, which keeps offsets strictly
 * increasing inside a segment and makes the reverse lookup a binary search.
 */
export function indexSegments(segments: readonly Segment[]): SegmentIndex {
  const chars: string[] = [];
  const segment: number[] = [];
  const offset: number[] = [];
  const firstIndex: number[] = new Array(segments.length).fill(-1);
  const lastIndex: number[] = new Array(segments.length).fill(-1);

  let pendingSpace = false;
  let lastSegment = -1;
  let lastOffset = -1;

  for (let s = 0; s < segments.length; s++) {
    const current = segments[s] as Segment;
    if (current.break && chars.length > 0) {
      pendingSpace = true;
    }
    for (let i = 0; i < current.text.length; i++) {
      const char = current.text[i] as string;
      if (WHITESPACE.test(char)) {
        pendingSpace = true;
        continue;
      }
      if (pendingSpace && chars.length > 0) {
        // Belongs to whatever came before it, one past its last character.
        chars.push(" ");
        segment.push(lastSegment);
        offset.push(lastOffset + 1);
        if (lastSegment >= 0) {
          lastIndex[lastSegment] = chars.length - 1;
        }
      }
      pendingSpace = false;
      chars.push(char);
      segment.push(s);
      offset.push(i);
      if (firstIndex[s] === -1) {
        firstIndex[s] = chars.length - 1;
      }
      lastIndex[s] = chars.length - 1;
      lastSegment = s;
      lastOffset = i;
    }
  }

  return { text: chars.join(""), segment, offset, firstIndex, lastIndex };
}

/** First index of `text` at or after a segment, or `text.length` if there is none. */
function forwardFrom(index: SegmentIndex, from: number): number {
  for (let s = from; s < index.firstIndex.length; s++) {
    const first = index.firstIndex[s] as number;
    if (first !== -1) {
      return first;
    }
  }
  return index.text.length;
}

/** One past the last index of `text` at or before a segment, or 0. */
function backwardFrom(index: SegmentIndex, from: number): number {
  for (let s = from; s >= 0; s--) {
    const last = index.lastIndex[s] as number;
    if (last !== -1) {
      return last + 1;
    }
  }
  return 0;
}

/**
 * Turn a point in a segment — the DOM's (node, offset) — into an offset in the
 * page text.
 *
 * `side` decides what to do when the point lands on whitespace that the
 * collapse removed: the start of a selection moves forward to the next real
 * character, the end moves back to the previous one. That is what makes a
 * dragged selection produce the passage a reader thinks they highlighted rather
 * than one padded with the spaces at its edges.
 */
export function offsetInText(
  index: SegmentIndex,
  segmentNumber: number,
  charOffset: number,
  side: "start" | "end",
): number {
  return snap(index, rawOffsetInText(index, segmentNumber, charOffset, side), side);
}

/**
 * Every space in the page text stands for a run of whitespace that the collapse
 * removed, so a boundary that landed on one landed on nothing a reader meant to
 * select. Move it to the nearest real character on the side it is facing.
 */
function snap(index: SegmentIndex, at: number, side: "start" | "end"): number {
  if (side === "start") {
    let start = at;
    while (start < index.text.length && index.text[start] === " ") {
      start++;
    }
    return start;
  }
  let end = at;
  while (end > 0 && index.text[end - 1] === " ") {
    end--;
  }
  return end;
}

function rawOffsetInText(
  index: SegmentIndex,
  segmentNumber: number,
  charOffset: number,
  side: "start" | "end",
): number {
  const segments = index.firstIndex.length;
  if (segments === 0 || segmentNumber < 0) {
    return 0;
  }
  if (segmentNumber >= segments) {
    return index.text.length;
  }

  const first = index.firstIndex[segmentNumber] as number;
  const last = index.lastIndex[segmentNumber] as number;
  if (first === -1 || last === -1) {
    // A segment that contributed nothing — all whitespace, or empty.
    return side === "start"
      ? forwardFrom(index, segmentNumber + 1)
      : backwardFrom(index, segmentNumber - 1);
  }

  // `offset` is strictly increasing across [first, last], so: binary search for
  // the first index of the segment at or past `charOffset`.
  let low = first;
  let high = last + 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((index.offset[mid] as number) < charOffset) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  if (side === "start") {
    return low <= last ? low : forwardFrom(index, segmentNumber + 1);
  }
  return low > first ? low : backwardFrom(index, segmentNumber - 1);
}

/**
 * The inverse: where in the segments does character `textOffset` live.
 * `null` for an offset outside the text.
 */
export function pointInSegments(
  index: SegmentIndex,
  textOffset: number,
): { segment: number; offset: number } | null {
  if (textOffset < 0 || textOffset >= index.text.length) {
    return null;
  }
  return {
    segment: index.segment[textOffset] as number,
    offset: index.offset[textOffset] as number,
  };
}
