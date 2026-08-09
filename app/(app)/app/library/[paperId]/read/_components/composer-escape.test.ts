import { describe, expect, it } from "vitest";
import { composerEscape } from "./composer-escape";

/**
 * One key, several things it could plausibly mean, and exactly one answer per
 * situation. The property under test is the *order*: this used to be settled by
 * which listener happened to be registered first on `document`, which is not a
 * thing a product decision should rest on.
 */

const REST = { menuOpen: false, confirming: false, body: "" };

describe("Escape with nothing in the way", () => {
  it("closes an empty composer", () => {
    expect(composerEscape(REST)).toBe("close");
  });

  it("closes a composer holding only whitespace, which is not a draft", () => {
    expect(composerEscape({ ...REST, body: "   \n  " })).toBe("close");
  });
});

describe("Escape with something written", () => {
  it("asks before throwing it away", () => {
    expect(composerEscape({ ...REST, body: "the effect size is" })).toBe(
      "ask-before-discarding",
    );
  });

  it("takes back the question rather than answering it", () => {
    expect(
      composerEscape({ menuOpen: false, confirming: true, body: "a note" }),
    ).toBe("cancel-confirm");
  });
});

describe("Escape with the mention menu open", () => {
  it("closes the menu and nothing else", () => {
    expect(composerEscape({ ...REST, menuOpen: true })).toBe("close-menu");
  });

  it("closes the menu even when there is a draft behind it", () => {
    // The bug this replaces: one Escape dismissed the roster *and* discarded
    // the half-written note underneath it.
    expect(
      composerEscape({ menuOpen: true, confirming: false, body: "as @Sar" }),
    ).toBe("close-menu");
  });

  it("closes the menu before it revisits a question already on screen", () => {
    expect(
      composerEscape({ menuOpen: true, confirming: true, body: "a note" }),
    ).toBe("close-menu");
  });
});
