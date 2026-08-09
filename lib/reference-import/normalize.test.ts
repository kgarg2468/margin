import { describe, expect, it } from "vitest";
import { referenceIdentity } from "./normalize";

describe("referenceIdentity", () => {
  it("matches titles across casing and whitespace differences", () => {
    expect(referenceIdentity("  Shared\n  Margins  ", 2024)).toBe(
      "shared margins\u00002024",
    );
  });

  it("keeps different years and a missing year distinct", () => {
    expect(referenceIdentity("Shared margins", 2023)).not.toBe(
      referenceIdentity("Shared margins", 2024),
    );
    expect(referenceIdentity("Shared margins", undefined)).not.toBe(
      referenceIdentity("Shared margins", 2024),
    );
  });
});
