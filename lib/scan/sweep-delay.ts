/**
 * The sweep's timings, kept out of both the component and the stylesheet.
 *
 * Two separations, and the second is the load-bearing one.
 *
 * Away from the component is forced: `scan-sweep.tsx` imports a CSS module, and
 * the unit suite runs in `node` against a Vite transform that would have to
 * resolve that stylesheet through the app's PostCSS config to load the file at
 * all. The arithmetic is the only part worth testing and it has no stylesheet in
 * it, so it sits here — the plain-TypeScript core beside the component that uses
 * it, which is the arrangement `vitest.config.mts` describes.
 *
 * Away from the stylesheet is the point. The durations below were literals in
 * `scan-sweep.module.css`, which meant nothing could state what a shelf's
 * entrance actually costs without copying one of them into a second file, where
 * nothing would check the copy was still true. A test written that way asserts
 * its own copy rather than the product — which is precisely how the entrance
 * test came to be named for a bound it did not hold. So the durations are
 * declared here and handed down as custom properties, exactly as the delay
 * already was: this file is the value of record, the CSS is a consumer, and the
 * entrance total becomes arithmetic a test can do rather than a claim a comment
 * can make.
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

/** One pass across a host as it appears. */
export const SWEEP_MS = 1150;

/**
 * And one under the pointer, shorter on purpose: the two are different
 * sentences. An arrival is announced, a glance is answered — and a hover pass
 * that took as long as an entrance would still be crossing the row after the
 * reader had already decided about it.
 */
export const HOVER_SWEEP_MS = 900;
