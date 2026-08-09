import { describe, expect, it } from "vitest";
import { ruleOpacity, washOpacity } from "./mark-alpha";

/**
 * The numbers are multipliers over a wash token that is itself 20% (a typed
 * note) or 30% (a plain highlight), so what these tests are really asserting is
 * the *order* — a resting passage must be plainly there, an active one must be
 * plainly more so, and a passage the reader had to reason its way back to must
 * always read as less certain than one it found where it was left.
 */

describe("how much ink a mark carries", () => {
  it("shows a resting passage at more than half strength", () => {
    // 0.5 was the old value: 20% wash * 0.5 = a 10% tint, three times fainter
    // than the reaction chip on the card pointing at it.
    expect(washOpacity({ drifted: false, active: false })).toBeGreaterThan(0.7);
  });

  it("gives an active passage the wash at full strength", () => {
    expect(washOpacity({ drifted: false, active: true })).toBe(1);
  });

  it("keeps a drifted passage fainter than a certain one, in both states", () => {
    expect(washOpacity({ drifted: true, active: false })).toBeLessThan(
      washOpacity({ drifted: false, active: false }),
    );
    expect(washOpacity({ drifted: true, active: true })).toBeLessThan(
      washOpacity({ drifted: false, active: true }),
    );
  });

  it("makes activation legible for a drifted passage too", () => {
    expect(washOpacity({ drifted: true, active: true })).toBeGreaterThan(
      washOpacity({ drifted: true, active: false }),
    );
  });

  it("never asks for an opacity outside the range one can have", () => {
    for (const drifted of [true, false]) {
      for (const active of [true, false]) {
        const value = washOpacity({ drifted, active });
        expect(value).toBeGreaterThan(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("the under-rule", () => {
  it("is drawn at full strength only when the note is active", () => {
    expect(ruleOpacity({ active: true })).toBe(1);
    expect(ruleOpacity({ active: false })).toBeLessThan(1);
  });
});
