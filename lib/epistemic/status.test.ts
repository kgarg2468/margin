import { describe, expect, it } from "vitest";
import {
  checkTransition,
  EPISTEMIC_STATUSES,
  STATUS_MARKS,
  statusLine,
  statusWord,
  supersessionLine,
  type EpistemicStatus,
} from "./status";

/**
 * The properties worth holding here are the ones a screenshot cannot show.
 *
 * A status that renders is easy. What is hard, and what a lab's memory is
 * eventually judged on, is the coherence of the reference: a note marked
 * superseded must always say what superseded it, a note marked anything else
 * must never carry a dangling pointer, and a supersession whose target has
 * gone must read as a redaction rather than as a bare word. The other property
 * is that no transition is forbidden — a lab that changes its mind twice is a
 * lab using the feature correctly, and a rule table that refused the second
 * move would be this module deciding what the lab is allowed to think.
 */

const SELF = "annotation_self";
const OTHER = "annotation_other";

function transition(
  overrides: Partial<Parameters<typeof checkTransition>[0]> = {},
) {
  return checkTransition({
    self: SELF,
    current: null,
    currentSupersededBy: null,
    next: "accepted",
    supersededBy: null,
    ...overrides,
  });
}

describe("the vocabulary", () => {
  it("names every status exactly once", () => {
    expect(STATUS_MARKS.map((mark) => mark.value)).toEqual([
      ...EPISTEMIC_STATUSES,
    ]);
  });

  it("gives each one a word and a meaning", () => {
    for (const mark of STATUS_MARKS) {
      expect(mark.word.length).toBeGreaterThan(0);
      expect(mark.meaning.length).toBeGreaterThan(0);
      expect(statusWord(mark.value)).toBe(mark.word);
    }
  });
});

describe("the line a card wears", () => {
  it("is one word for the three that are not references", () => {
    for (const value of ["accepted", "disputed", "resolved"] as const) {
      expect(statusLine({ value })).toBe(statusWord(value));
      expect(supersessionLine({ value, by: "Nadia Okafor" })).toBeNull();
    }
  });

  it("names the author of the note that replaced this one", () => {
    expect(statusLine({ value: "superseded", by: "Nadia Okafor" })).toBe(
      "Superseded by Nadia Okafor's note",
    );
  });

  it("says a withdrawn replacement is gone rather than dropping it", () => {
    const line = statusLine({ value: "superseded", by: null, redacted: true });
    expect(line).toBe("Superseded by a note that is no longer shared");
    // The failure this guards is the quiet one: a redacted citation rendering
    // as the bare word, which reads as a complete fact rather than a withheld
    // one.
    expect(line).not.toBe("Superseded");
  });

  it("does not claim a withdrawal when the target is merely not in view", () => {
    expect(statusLine({ value: "superseded" })).toBe("Superseded");
    expect(statusLine({ value: "superseded", by: "" })).toBe("Superseded");
    expect(supersessionLine({ value: "superseded" })).toBeNull();
  });

  it("hands the margin the verdict and the citation apart", () => {
    // The card sets them in two registers, so a change that folded them back
    // into one string would quietly re-typeset the word as body text.
    const mark = { value: "superseded", by: "Nadia Okafor" } as const;
    expect(statusWord(mark.value)).toBe("Superseded");
    expect(supersessionLine(mark)).toBe("by Nadia Okafor's note");
    expect(statusLine(mark)).toBe(
      `${statusWord(mark.value)} ${supersessionLine(mark) ?? ""}`,
    );
  });
});

describe("transitions", () => {
  it("allows every pair, in both directions", () => {
    const states: (EpistemicStatus | null)[] = [null, ...EPISTEMIC_STATUSES];
    for (const current of states) {
      for (const next of states) {
        const check = transition({
          current,
          currentSupersededBy: current === "superseded" ? OTHER : null,
          next,
          supersededBy: next === "superseded" ? OTHER : null,
        });
        expect(check.ok, `${current} → ${next}`).toBe(true);
      }
    }
  });

  it("takes a mark off", () => {
    const check = transition({ current: "disputed", next: null });
    expect(check).toEqual({ ok: true, changed: true });
  });

  it("reports the state a note is already in as no change", () => {
    expect(transition({ current: "accepted", next: "accepted" })).toEqual({
      ok: true,
      changed: false,
    });
    expect(transition({ current: null, next: null })).toEqual({
      ok: true,
      changed: false,
    });
  });

  it("counts re-pointing a supersession as a change", () => {
    expect(
      transition({
        current: "superseded",
        currentSupersededBy: OTHER,
        next: "superseded",
        supersededBy: "annotation_third",
      }),
    ).toEqual({ ok: true, changed: true });
  });

  it("refuses a supersession that names nothing", () => {
    const check = transition({ next: "superseded", supersededBy: null });
    expect(check.ok).toBe(false);
  });

  it("refuses a reference on any other word", () => {
    for (const next of [null, "accepted", "disputed", "resolved"] as const) {
      expect(transition({ next, supersededBy: OTHER }).ok).toBe(false);
    }
  });

  it("refuses a note that supersedes itself", () => {
    const check = transition({ next: "superseded", supersededBy: SELF });
    expect(check.ok).toBe(false);
    if (check.ok) {
      throw new Error("unreachable");
    }
    expect(check.reason).toMatch(/itself/);
  });
});
