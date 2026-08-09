import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import type { Doc, Id } from "./_generated/dataModel";
import { sessionTitleFrom } from "./sessions";
import {
  cleanTemplateName,
  cleanTemplateNotes,
  requireNameFree,
  requireRoom,
} from "./sessionTemplates";

/**
 * What a saved meeting shape is allowed to be, and what it does to the session
 * it is applied to.
 *
 * Both halves are here because they are one question asked twice. A template
 * is only worth anything if the thing that comes out the other end is the
 * thing the lab saved — so the rules that decide what may be stored
 * (`cleanTemplateName`, `cleanTemplateNotes`, `requireNameFree`) and the rule
 * that decides what a session gets when one is applied (`sessionTitleFrom`,
 * which lives in `sessions.ts` because it is a fact about sessions) are tested
 * against each other rather than in two files that could drift.
 *
 * The cases worth writing down are the ones a browser will not show you. A
 * name collision that is only a difference of case renders as two identical
 * rows in a picker, which looks like a bug in the picker. An agenda whose
 * blank lines were collapsed still looks like an agenda. And a template title
 * quietly overriding a typed one is invisible until the week somebody types
 * one and it does not take.
 */

const template = (
  id: string,
  name: string,
): Doc<"sessionTemplates"> => ({
  _id: id as Id<"sessionTemplates">,
  _creationTime: 0,
  labId: "lab_1" as Id<"labs">,
  name,
  presenterNotes: "Background, figure, limitations.",
  createdBy: "user_1" as Id<"users">,
});

describe("cleanTemplateName", () => {
  it("collapses the whitespace a paste brings with it", () => {
    expect(cleanTemplateName("  Methods   week \n")).toBe("Methods week");
  });

  it("refuses a name that is only whitespace", () => {
    // Not silently defaulted to "Untitled": a shape nobody can name is a shape
    // nobody will find again, and the picker is the entire interface.
    expect(() => cleanTemplateName("   ")).toThrow(ConvexError);
  });

  it("truncates rather than refuses a long one", () => {
    // The opposite call to the one `cleanTemplateNotes` makes, deliberately. A
    // name is a label and losing its tail costs nothing; an agenda is the
    // content and losing its tail is losing the thing you saved.
    const long = cleanTemplateName("x".repeat(200));
    expect(long).toHaveLength(60);
  });
});

describe("cleanTemplateNotes", () => {
  it("keeps the line breaks — an agenda is an outline", () => {
    const agenda = "15m background\n20m methods\n10m what we'd do next";
    expect(cleanTemplateNotes(`\n${agenda}\n  `)).toBe(agenda);
  });

  it("refuses an empty agenda", () => {
    expect(() => cleanTemplateNotes("  \n ")).toThrow(ConvexError);
  });

  it("refuses an over-long agenda instead of silently cutting it", () => {
    expect(() => cleanTemplateNotes("x".repeat(4_001))).toThrow(ConvexError);
  });

  it("says where the longer ceiling is, since that is the fix", () => {
    // Someone hitting this wanted to save one meeting's prep as a template.
    // The refusal should point at the field that does take it — the session's
    // own presenter notes — rather than only stating a number.
    try {
      cleanTemplateNotes("x".repeat(5_000));
      expect.unreachable("that agenda should not have been accepted");
    } catch (caught) {
      expect(caught).toBeInstanceOf(ConvexError);
      expect((caught as ConvexError<string>).data).toContain("20000");
    }
  });

  it("takes an agenda right up to the ceiling", () => {
    expect(cleanTemplateNotes("x".repeat(4_000))).toHaveLength(4_000);
  });
});

describe("requireNameFree", () => {
  const existing = [template("a", "Methods week"), template("b", "Preprints")];

  it("refuses a name the lab already uses", () => {
    expect(() => requireNameFree(existing, "Preprints")).toThrow(ConvexError);
  });

  it("refuses one that differs only in case", () => {
    // The picker draws "methods week" and "Methods week" identically, and a
    // member choosing between them is guessing.
    expect(() => requireNameFree(existing, "methods WEEK")).toThrow(
      ConvexError,
    );
  });

  it("lets a template keep its own name", () => {
    expect(() =>
      requireNameFree(existing, "Preprints", "b" as Id<"sessionTemplates">),
    ).not.toThrow();
  });

  it("lets a template fix its own capitalization", () => {
    expect(() =>
      requireNameFree(existing, "PrePrints", "b" as Id<"sessionTemplates">),
    ).not.toThrow();
  });

  it("still refuses renaming one onto another", () => {
    expect(() =>
      requireNameFree(existing, "Methods week", "b" as Id<"sessionTemplates">),
    ).toThrow(ConvexError);
  });

  it("allows anything into an empty lab", () => {
    expect(() => requireNameFree([], "Methods week")).not.toThrow();
  });
});

describe("requireRoom", () => {
  const shapes = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      template(`t${index}`, `Shape ${index}`),
    );

  it("lets a lab with room save another", () => {
    expect(() => requireRoom(shapes(11))).not.toThrow();
  });

  it("refuses the thirteenth", () => {
    // The boundary, written down: twelve is the cap, so a lab holding twelve
    // is full. A `>` here instead of `>=` would let a thirteenth through and
    // nothing else in the suite would notice.
    expect(() => requireRoom(shapes(12))).toThrow(ConvexError);
  });

  it("reads the same for a lab already over the cap", () => {
    // `labTemplates` takes one past the ceiling precisely so this is
    // detectable rather than saturated — the check should refuse whether the
    // lab has just reached the cap or was somehow already past it.
    expect(() => requireRoom(shapes(13))).toThrow(ConvexError);
  });

  it("says what the cap is, since the fix is deleting one", () => {
    try {
      requireRoom(shapes(12));
      expect.unreachable("a full lab should not have room");
    } catch (caught) {
      expect(caught).toBeInstanceOf(ConvexError);
      expect((caught as ConvexError<string>).data).toContain("12");
    }
  });

  it("allows anything into an empty lab", () => {
    expect(() => requireRoom([])).not.toThrow();
  });
});

describe("sessionTitleFrom", () => {
  it("prefers what the person typed", () => {
    expect(sessionTitleFrom("Retraction postmortem", "Methods week")).toBe(
      "Retraction postmortem",
    );
  });

  it("falls back to the template's when nothing was typed", () => {
    expect(sessionTitleFrom(undefined, "Methods week")).toBe("Methods week");
  });

  it("treats a blank typed title as nothing typed", () => {
    // The form's title input is optional and starts empty; a user who tabbed
    // through it has not overridden anything.
    expect(sessionTitleFrom("   ", "Methods week")).toBe("Methods week");
  });

  it("leaves the session untitled when neither has one", () => {
    // Untitled is the common case and not a gap — the session is known by its
    // paper.
    expect(sessionTitleFrom(undefined, undefined)).toBeUndefined();
  });

  it("cleans whichever one wins", () => {
    expect(sessionTitleFrom(undefined, "  Methods   week  ")).toBe(
      "Methods week",
    );
    expect(sessionTitleFrom("  Journal   club  ", undefined)).toBe(
      "Journal club",
    );
  });
});
