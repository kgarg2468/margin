import { describe, expect, it } from "vitest";
import {
  SWEEP_DURATION,
  SWEEP_LEAD_IN,
  SWEEP_PERIOD,
  sweepAt,
  sweepEnvelope,
} from "./sweep";

/**
 * What is worth asserting here is the part a screenshot cannot show: that the
 * scene is idle for most of its life, that it wakes up exactly when the next
 * sweep is due, and that the sleep it reports is long enough to be worth
 * taking and short enough not to miss the front.
 */

describe("sweepAt", () => {
  it("holds still through the lead-in and asks to be woken when it ends", () => {
    const state = sweepAt(0);
    expect(state.running).toBe(false);
    expect(state.sleep).toBeCloseTo(SWEEP_LEAD_IN);
    expect(sweepAt(SWEEP_LEAD_IN - 0.4).sleep).toBeCloseTo(0.4);
  });

  it("runs for exactly the sweep's duration, then rests for the remainder", () => {
    expect(sweepAt(SWEEP_LEAD_IN).running).toBe(true);
    expect(sweepAt(SWEEP_LEAD_IN + SWEEP_DURATION - 0.01).running).toBe(true);
    // A hair past the end rather than exactly on it: `LEAD_IN + DURATION` is
    // not representable, so the boundary itself lands on whichever side the
    // rounding falls, and which side that is has no bearing on anything.
    const rested = sweepAt(SWEEP_LEAD_IN + SWEEP_DURATION + 0.01);
    expect(rested.running).toBe(false);
    expect(rested.sleep).toBeCloseTo(SWEEP_PERIOD - SWEEP_DURATION - 0.01);
  });

  it("advances the phase across the sweep and repeats every period", () => {
    const half = sweepAt(SWEEP_LEAD_IN + SWEEP_DURATION / 2);
    expect(half.phase).toBeCloseTo(0.5);
    const next = sweepAt(SWEEP_LEAD_IN + SWEEP_PERIOD + SWEEP_DURATION / 2);
    expect(next.running).toBe(true);
    expect(next.phase).toBeCloseTo(half.phase);
  });

  it("spends most of the period asleep, which is the whole point", () => {
    // Sampled rather than reasoned about, because the claim in the PR body is
    // a duty cycle and this is the number behind it.
    let running = 0;
    const samples = 900;
    for (let i = 0; i < samples; i += 1) {
      if (sweepAt(SWEEP_LEAD_IN + (i * SWEEP_PERIOD) / samples).running) {
        running += 1;
      }
    }
    expect(running / samples).toBeCloseTo(SWEEP_DURATION / SWEEP_PERIOD, 2);
  });

  it("treats a clock that has gone strange as one that has not started", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -12]) {
      const state = sweepAt(bad);
      expect(state.running).toBe(false);
      expect(state.sleep).toBeGreaterThan(0);
    }
  });
});

describe("sweepEnvelope", () => {
  it("is silent outside the sweep and never negative inside it", () => {
    expect(sweepEnvelope(0)).toBe(0);
    expect(sweepEnvelope(1)).toBe(0);
    for (let phase = 0; phase <= 1; phase += 0.02) {
      expect(sweepEnvelope(phase)).toBeGreaterThanOrEqual(0);
      expect(sweepEnvelope(phase)).toBeLessThanOrEqual(1);
    }
  });

  it("reaches full brightness early and decays for the rest of the sweep", () => {
    // The attack is over by 6% of the sweep; from there it is release alone.
    expect(sweepEnvelope(0.06)).toBeCloseTo(0.94 * 0.94, 3);
    expect(sweepEnvelope(0.03)).toBeLessThan(sweepEnvelope(0.06));
    // Monotonic after the attack: the front never brightens again on its way out.
    let previous = sweepEnvelope(0.1);
    for (let phase = 0.12; phase < 1; phase += 0.02) {
      const value = sweepEnvelope(phase);
      expect(value).toBeLessThan(previous);
      previous = value;
    }
  });
});
