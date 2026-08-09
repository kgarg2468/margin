import { describe, expect, it } from "vitest";
import { composerEscape, composerHandlesEscape } from "./composer-escape";

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

/**
 * Which surface the key belongs to, asked before what it means. The ordering
 * above only applies when the composer is the thing on top — and "on top" is
 * not the same question as "focused".
 */
describe("Escape and the surface it belongs to", () => {
  it("answers for an Escape pressed inside the composer's own sheet", () => {
    expect(composerHandlesEscape("composer")).toBe(true);
  });

  it("leaves an Escape alone when something is layered over the composer", () => {
    // The ⌘K palette closes on a `window` listener; Base UI's dismissal runs on
    // `document`, one bubble earlier, and stops the event dead. A composer that
    // answered this Escape would leave the palette open with no way out but the
    // mouse — and would put "Throw this note away?" behind it for good measure.
    expect(composerHandlesEscape("surface-above")).toBe(false);
  });

  it("still answers when the Escape belongs to no surface at all", () => {
    // The row a naive "was it pressed inside my sheet?" test gets wrong. An
    // outside press leaves focus on the page, and the composer is still the
    // topmost thing open: Escape has to keep working there, or a note becomes
    // un-dismissable by keyboard the moment the reader clicks the page.
    expect(composerHandlesEscape("page")).toBe(true);
  });
});
