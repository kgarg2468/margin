import { describe, expect, it } from "vitest";
import {
  offerIsTabbable,
  pageKeyTarget,
  tabStopPage,
} from "./page-navigation";

const PAPER = { pageCount: 37 };

describe("moving through the paper", () => {
  it("goes a page on with Page Down", () => {
    expect(pageKeyTarget("PageDown", { current: 4, ...PAPER })).toBe(5);
  });

  it("goes a page back with Page Up", () => {
    expect(pageKeyTarget("PageUp", { current: 4, ...PAPER })).toBe(3);
  });

  it("goes to the first and last pages", () => {
    expect(pageKeyTarget("Home", { current: 20, ...PAPER })).toBe(0);
    expect(pageKeyTarget("End", { current: 20, ...PAPER })).toBe(36);
  });

  it("stops at the covers rather than running off them", () => {
    expect(pageKeyTarget("PageUp", { current: 0, ...PAPER })).toBe(0);
    expect(pageKeyTarget("PageDown", { current: 36, ...PAPER })).toBe(36);
  });
});

describe("keys this navigation has no opinion about", () => {
  it("leaves the arrows to the caret, which is how a passage gets selected", () => {
    expect(pageKeyTarget("ArrowDown", { current: 4, ...PAPER })).toBeNull();
    expect(pageKeyTarget("ArrowUp", { current: 4, ...PAPER })).toBeNull();
  });

  it("leaves Tab, Escape and everything else alone", () => {
    for (const key of ["Tab", "Escape", "a", " ", "Enter"]) {
      expect(pageKeyTarget(key, { current: 4, ...PAPER })).toBeNull();
    }
  });
});

describe("a paper that has not loaded", () => {
  it("has nowhere to go", () => {
    expect(pageKeyTarget("PageDown", { current: 0, pageCount: 0 })).toBeNull();
  });
});

describe("where the one stop sits", () => {
  it("is on the page being read", () => {
    expect(tabStopPage({ current: 12, ...PAPER })).toBe(12);
  });

  it("falls back to the last page when the paper got shorter under it", () => {
    // A second document loaded into the same reader, and the page the
    // observer last reported is off the end of it.
    expect(tabStopPage({ current: 40, ...PAPER })).toBe(36);
  });

  it("gives an unloaded paper no stop at all rather than page zero", () => {
    expect(tabStopPage({ current: 0, pageCount: 0 })).toBeNull();
  });
});

describe("the offer to annotate a selection", () => {
  it("is a stop while its selection is the one on screen", () => {
    expect(offerIsTabbable({ onPageBeingRead: true })).toBe(0);
  });

  it("leaves the tab order once the reader has paged away from it", () => {
    // Measured: left tabbable, it sat off-screen at viewport top −739, Tab
    // reached it, focusing it scrolled the paper back a page, and the paper's
    // own roving stop — its ancestor, and so ahead of it in the order — was
    // skipped. One stale affordance ate the one stop the paper has.
    expect(offerIsTabbable({ onPageBeingRead: false })).toBe(-1);
  });
});
