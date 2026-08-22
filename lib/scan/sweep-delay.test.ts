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

  it("keeps the whole entrance inside a second", () => {
    // Sweep duration is 1.15s; the last row starting near a second in means the
    // shelf is still lighting up two seconds after it is readable, which is the
    // failure mode the cap exists to prevent.
    expect(sweepDelayMs(Number.MAX_SAFE_INTEGER)).toBeLessThan(1000);
  });
});
