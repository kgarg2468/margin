/**
 * The stagger, kept out of the component it belongs to.
 *
 * Not a stylistic split: `scan-sweep.tsx` imports a CSS module, and the unit
 * suite runs in `node` against a Vite transform that would have to resolve that
 * stylesheet through the app's PostCSS config to load the file at all. The
 * arithmetic is the only part worth testing and it has no stylesheet in it, so
 * it sits here — the plain-TypeScript core beside the component that uses it,
 * which is the arrangement `vitest.config.mts` describes.
 */

/**
 * Hosts past this one arrive without a stagger. A shelf is not a countdown;
 * beyond the first handful the delay stops reading as sequence and starts
 * reading as latency.
 */
const STAGGERED = 8;

const STEP_MS = 70;
const OFFSET_MS = 120;

export function sweepDelayMs(index: number): number {
  return OFFSET_MS + Math.min(index, STAGGERED) * STEP_MS;
}
