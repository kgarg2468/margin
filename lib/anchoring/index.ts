/**
 * Passage anchoring.
 *
 * The module `.context/architecture-decision.md` calls core IP: W3C Web
 * Annotation-style redundant selectors over a PDF's extracted text, with fuzzy
 * re-anchoring for when the file underneath changes.
 *
 * - `anchor.ts` — make an anchor from a selection; find it again later.
 * - `normalize.ts` — the two normalizations, and the offset maps between them.
 * - `fuzzy.ts` — bounded approximate search, the last resort.
 * - `segments.ts` — text-item offsets ⇄ page-text offsets (DOM-free, tested).
 * - `text-layer.ts` — the adapter that reads a rendered pdf.js text layer.
 */

export type {
  AnchorMethod,
  ResolveOptions,
  ResolvedAnchor,
  TextAnchor,
} from "./anchor";
export {
  CONTEXT_LENGTH,
  MAX_QUOTE_LENGTH,
  createAnchor,
  resolveAnchor,
} from "./anchor";

export type { FuzzyMatch, FuzzyOptions } from "./fuzzy";
export { DEFAULT_MIN_SCORE, fuzzyFind } from "./fuzzy";

export type { NormalizedText } from "./normalize";
export {
  foldedOffset,
  normalizeForMatch,
  normalizePdfText,
  sourceRange,
} from "./normalize";

export type { Segment, SegmentIndex } from "./segments";
export { indexSegments, offsetInText, pointInSegments } from "./segments";

export type { TextLayerIndex } from "./text-layer";
export {
  indexTextLayer,
  offsetsForRange,
  rangeForOffsets,
} from "./text-layer";
