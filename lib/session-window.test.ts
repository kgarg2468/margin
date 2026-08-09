import { describe, expect, it } from "vitest";
import { MAX_EARLY_START_MS, awayProse, startWindow } from "./session-window";

const HOUR = 3_600_000;

describe("startWindow", () => {
  it("opens exactly at the 24h boundary", () => {
    const now = 1_000_000_000_000;
    expect(startWindow(now + MAX_EARLY_START_MS, now).canStart).toBe(true);
    expect(startWindow(now + MAX_EARLY_START_MS + 1, now).canStart).toBe(false);
  });
  it("is one-sided: late is always startable", () => {
    const now = 1_000_000_000_000;
    expect(startWindow(now - 90 * 24 * HOUR, now).canStart).toBe(true);
  });
  it("reports how long until the window opens", () => {
    const now = 1_000_000_000_000;
    const { msUntilOpen } = startWindow(now + 25 * HOUR, now);
    expect(msUntilOpen).toBe(HOUR);
  });
  it("has nothing left to wait for once the window is open", () => {
    const now = 1_000_000_000_000;
    expect(startWindow(now - HOUR, now).msUntilOpen).toBe(0);
  });
});

describe("awayProse", () => {
  it("speaks hours under two days", () => {
    expect(awayProse(25 * HOUR)).toBe("about 25 hours away");
  });
  it("speaks days from two days up", () => {
    expect(awayProse(72 * HOUR)).toBe("about 3 days away");
  });
  it("counts one hour singular", () => {
    expect(awayProse(HOUR)).toBe("about 1 hour away");
  });
});
