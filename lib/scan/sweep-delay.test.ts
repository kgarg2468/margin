import { describe, expect, it } from "vitest";
import { HOVER_SWEEP_MS, SWEEP_MS, sweepDelayMs } from "./sweep-delay";

/**
 * What a shelf's entrance may cost, from the frame it mounts to the last row at
 * rest. A budget rather than a measurement, and the reason the stagger is
 * capped at all: past about this a library stops reading as arriving and starts
 * reading as still loading.
 *
 * It lives here and not beside the durations because it is the assertion, not
 * the product — nothing renders against it, and a budget the component could
 * import would eventually be mistaken for a timing.
 */
const ENTRANCE_BUDGET_MS = 2000;

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

  it("finishes the whole entrance inside its budget, however long the shelf is", () => {
    // The real total now, not just the start of it: the last row waits out the
    // capped delay and then sweeps for its full duration, and both halves are
    // values this test imports rather than copies. Lengthening either one in
    // `sweep-delay.ts` moves this number, which is the whole reason the
    // stylesheet stopped holding the durations.
    const lastRowAtRest = sweepDelayMs(Number.MAX_SAFE_INTEGER) + SWEEP_MS;

    expect(lastRowAtRest).toBeLessThan(ENTRANCE_BUDGET_MS);
  });

  it("answers a glance faster than it announces an arrival", () => {
    // Not a stylistic preference. A hover pass outlasting an entrance would
    // still be crossing a row after the reader had finished with it, which
    // turns a response into a distraction.
    expect(HOVER_SWEEP_MS).toBeLessThan(SWEEP_MS);
  });
});
