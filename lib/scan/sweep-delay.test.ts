import { describe, expect, it } from "vitest";
import { sweepDelayMs } from "./sweep-delay";

/**
 * The stagger is the only arithmetic in the effect, and the only part of it a
 * browser will not tell you is wrong. Everything else — the tint, the taper,
 * the cancellation between band and ruling — is visible in one screenshot; a
 * cap that quietly stopped capping shows up only on a shelf big enough that
 * nobody screenshots it, as a library that takes seconds to finish arriving.
 */
describe("sweepDelayMs", () => {
  it("gives the first host a lead-in rather than starting on the frame it mounts", () => {
    // Zero would light the row in the same frame the list paints, which reads
    // as a flash on the page rather than as light arriving over it.
    expect(sweepDelayMs(0)).toBeGreaterThan(0);
  });

  it("steps by a constant while the sequence is still legible", () => {
    const steps = [0, 1, 2, 3, 4].map((i) => sweepDelayMs(i + 1) - sweepDelayMs(i));
    expect(new Set(steps).size).toBe(1);
    expect(steps[0]).toBeGreaterThan(0);
  });

  it("stops staggering, so a long shelf does not arrive by appointment", () => {
    // The cap is the point: past it every remaining row shares one delay, and
    // a hundred-paper library finishes its entrance in the same beat a nine-
    // paper one does.
    expect(sweepDelayMs(200)).toBe(sweepDelayMs(8));
    expect(sweepDelayMs(8)).toBeGreaterThan(sweepDelayMs(7));
  });

  it("starts the last row inside a second, however long the shelf is", () => {
    // The start, and only the start. The sweep itself runs for 1.15s on top of
    // whatever this returns (`scan-sweep.module.css`), so the capped delay of
    // 680ms means the shelf actually stops moving around 1.83s — and *that* is
    // the number the cap is chosen against, since the failure mode is a library
    // still lighting up long after it became readable.
    //
    // The total is deliberately not asserted. Pinning it here would mean
    // copying the duration out of the stylesheet into this file, where nothing
    // checks the copy is still true — a second claim resting on nothing, which
    // is the exact defect this test was rewritten to remove. The honest fix is
    // structural rather than a better assertion: if the component set a
    // `--scan-duration` that the stylesheet consumed, the duration would have
    // one home, and the entrance total would become checkable arithmetic. That
    // needs the component and the stylesheet, which this change is fenced out
    // of; see the PR discussion.
    expect(sweepDelayMs(Number.MAX_SAFE_INTEGER)).toBeLessThan(1000);
  });
});
