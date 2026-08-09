import { describe, expect, it } from "vitest";
import {
  composerEscape,
  composerFocusOut,
  composerHandlesEscape,
  dismissalAsksFirst,
  escapeBelongsTo,
} from "./composer-escape";

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
 * The other way a sheet closes: Base UI decided to dismiss it. Escape arrives
 * here too and is sent on to the ordering above; every other reason is a
 * dismissal nobody asked for, and the note in the box has to survive it.
 */
describe("a dismissal that would take the note with it", () => {
  it("asks before an outside press throws a written note away", () => {
    expect(dismissalAsksFirst("outside-press", "the effect size is")).toBe(true);
  });

  it("asks when focus leaves the sheet, which is the same loss by another name", () => {
    // The row that shipped without a guard: `focus-out` fell past the two
    // named reasons and closed the composer, and the note went with it.
    expect(dismissalAsksFirst("focus-out", "the effect size is")).toBe(true);
  });

  it("asks for a reason nobody here has heard of", () => {
    // `reason` is a string as far as this file is concerned, and the cost of
    // being wrong is somebody's writing. So the rule is stated the safe way
    // round: everything asks, and Escape is the one exception because it is
    // already answered above.
    expect(dismissalAsksFirst("close-press", "a note")).toBe(true);
  });

  it("leaves Escape to the ordering that already owns it", () => {
    expect(dismissalAsksFirst("escape-key", "a note")).toBe(false);
  });

  it("closes without a question when there is nothing to lose", () => {
    expect(dismissalAsksFirst("outside-press", "")).toBe(false);
    expect(dismissalAsksFirst("focus-out", "   \n ")).toBe(false);
  });
});

/**
 * Which surface the key belongs to, asked before what it means. The ordering
 * above only applies when the composer is the thing on top — and "on top" is
 * not the same question as "focused".
 */
describe("reading the surface off the key press", () => {
  const NOTHING_ELSE = {
    insideComposer: false,
    insideSurface: false,
    otherSurfaceOpen: false,
  };

  it("is the composer's when the key landed in its own sheet", () => {
    expect(escapeBelongsTo({ ...NOTHING_ELSE, insideComposer: true })).toBe(
      "composer",
    );
  });

  it("stays the composer's even with something else open", () => {
    // Not reachable while the palette holds focus, and stated this way round
    // on purpose: a false positive on "something else is open" must never be
    // able to stop Escape working inside the sheet you are typing in.
    expect(
      escapeBelongsTo({
        insideComposer: true,
        insideSurface: true,
        otherSurfaceOpen: true,
      }),
    ).toBe("composer");
  });

  it("belongs to the surface the key was pressed in", () => {
    expect(escapeBelongsTo({ ...NOTHING_ELSE, insideSurface: true })).toBe(
      "surface-above",
    );
  });

  it("belongs to a surface above even when the key landed on nothing", () => {
    // The row that shipped wrong: click the palette's own padding and focus
    // goes to <body>, which is under no dialog at all — so the composer read
    // it as the page, called it its own, and swallowed the palette's Escape.
    expect(escapeBelongsTo({ ...NOTHING_ELSE, otherSurfaceOpen: true })).toBe(
      "surface-above",
    );
  });

  it("is the page when nothing at all is layered over the composer", () => {
    expect(escapeBelongsTo(NOTHING_ELSE)).toBe("page");
  });
});

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

/**
 * The same question asked of focus instead of of a key — and the three rows
 * that were, between them, wrong in both directions at once.
 */
describe("focus leaving the sheet", () => {
  it("says nothing when another surface takes focus, and keeps the draft", () => {
    // BP-1/BP-3: ⌘K raised "Throw this note away?" merely because focus moved
    // into the palette. Nobody was leaving the note — a layer arrived over it.
    expect(composerFocusOut("surface-above", "half-written note one")).toBe(
      "cancel-silently",
    );
  });

  it("asks before letting a written note go to the page", () => {
    // ADD-1: five Tabs walked out to `<body>` and the question never came.
    expect(composerFocusOut("page", "the effect size is")).toBe(
      "ask-before-discarding",
    );
  });

  it("closes on the way out when there is nothing to lose", () => {
    expect(composerFocusOut("page", "")).toBe("close");
    expect(composerFocusOut("page", "  \n ")).toBe("close");
  });

  it("is not a departure at all while focus is still in the sheet", () => {
    // Tabbing from the box to the chips fires the same event.
    expect(composerFocusOut("composer", "a note")).toBe("stay");
    expect(composerFocusOut("composer", "")).toBe("stay");
  });

  it("does not ask a surface above about the body, either way", () => {
    // Deliberately the same answer empty or not: a palette over the sheet is
    // not a decision about the note, so neither closing it nor questioning it
    // is something to do behind the reader's back.
    expect(composerFocusOut("surface-above", "")).toBe("cancel-silently");
  });
});
