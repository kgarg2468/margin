import { describe, expect, it } from "vitest";
import { isStillShared } from "./visibility";

const lab = "labs_1";
const row = (
  over: Partial<{
    labId: string;
    visibility: "private" | "lab";
    deletedAt: number;
  }> = {},
) => ({
  labId: lab,
  visibility: "lab" as const,
  ...over,
});

describe("isStillShared", () => {
  it("is true only for a live, lab-visible row of this lab", () => {
    expect(isStillShared(row(), lab)).toBe(true);
  });

  it("is false for gone, withdrawn, private, and another lab's", () => {
    expect(isStillShared(null, lab)).toBe(false);
    expect(isStillShared(row({ deletedAt: 5 }), lab)).toBe(false);
    expect(isStillShared(row({ visibility: "private" }), lab)).toBe(false);
    expect(isStillShared(row({ labId: "labs_2" }), lab)).toBe(false);
  });
});
