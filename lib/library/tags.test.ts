import { describe, expect, it } from "vitest";
import {
  MAX_TAGS_PER_PAPER,
  MAX_TAG_LENGTH,
  normalizeTag,
  normalizeTags,
  parseTagInput,
  suggestTags,
  tagVocabulary,
} from "./tags";

/**
 * The property that matters here is not any single conversion — it is that
 * every path into a tag lands on the same canonical string. A vocabulary is
 * only a vocabulary if two people typing the same word get the same label.
 */

describe("normalizeTag", () => {
  it("lands the ways people type one label on the same string", () => {
    const forms = ["Methods", "methods ", "  METHODS", "\tMethods\n", "MeThOdS"];
    expect(new Set(forms.map(normalizeTag))).toEqual(new Set(["methods"]));
  });

  it("collapses inner whitespace rather than deleting it", () => {
    expect(normalizeTag("open   question")).toBe("open question");
  });

  it("keeps punctuation a label legitimately carries", () => {
    expect(normalizeTag("Bayes' rule")).toBe("bayes' rule");
    expect(normalizeTag("single-cell")).toBe("single-cell");
    expect(normalizeTag("n=1")).toBe("n=1");
  });

  it("turns a comma into a separator's worth of space, never a tag character", () => {
    // A comma inside a stored tag would be a label `parseTagInput` could never
    // reproduce, so it cannot survive normalization.
    expect(normalizeTag("methods, stats")).toBe("methods stats");
    expect(normalizeTag("methods, stats")).not.toContain(",");
  });

  it("rejects what was never a tag", () => {
    expect(normalizeTag("")).toBe("");
    expect(normalizeTag("   ")).toBe("");
    expect(normalizeTag("\n\t")).toBe("");
  });

  it("cuts to the cap without leaving a trailing space", () => {
    const long = `${"a".repeat(MAX_TAG_LENGTH)} and then some more words`;
    const tag = normalizeTag(long);
    expect(tag).toHaveLength(MAX_TAG_LENGTH);
    expect(tag).toBe(tag.trim());

    // The cut lands mid-word here, which is where the second trim earns itself.
    const cutMidGap = `${"a".repeat(MAX_TAG_LENGTH - 1)} bcd`;
    expect(normalizeTag(cutMidGap)).toBe("a".repeat(MAX_TAG_LENGTH - 1));
  });

  it("is idempotent", () => {
    for (const input of ["  Methods ", "OPEN   Question", "a,b", "x".repeat(80)]) {
      expect(normalizeTag(normalizeTag(input))).toBe(normalizeTag(input));
    }
  });
});

describe("normalizeTags", () => {
  it("dedupes the same label typed differently, keeping the first spelling's place", () => {
    expect(normalizeTags(["Methods", "stats", "methods ", "STATS"])).toEqual([
      "methods",
      "stats",
    ]);
  });

  it("drops blanks instead of storing them", () => {
    expect(normalizeTags(["", "  ", "methods", "\n"])).toEqual(["methods"]);
  });

  it("caps a paper's marks", () => {
    const many = Array.from({ length: MAX_TAGS_PER_PAPER + 5 }, (_, i) => `t${i}`);
    expect(normalizeTags(many)).toHaveLength(MAX_TAGS_PER_PAPER);
    expect(normalizeTags(many).at(-1)).toBe(`t${MAX_TAGS_PER_PAPER - 1}`);
  });

  it("counts duplicates against nothing — twelve distinct labels still fit", () => {
    const withDupes = [
      ...Array.from({ length: MAX_TAGS_PER_PAPER }, (_, i) => `t${i}`).flatMap(
        (tag) => [tag, tag.toUpperCase()],
      ),
    ];
    expect(normalizeTags(withDupes)).toHaveLength(MAX_TAGS_PER_PAPER);
  });
});

describe("parseTagInput", () => {
  it("separates on commas and newlines but not on spaces", () => {
    expect(parseTagInput("methods, open question\nstats")).toEqual([
      "methods",
      "open question",
      "stats",
    ]);
  });

  it("survives the trailing comma someone leaves while still typing", () => {
    expect(parseTagInput("methods, ")).toEqual(["methods"]);
  });
});

describe("tagVocabulary", () => {
  const papers = [
    { tags: ["methods", "stats"] },
    { tags: ["Methods", "replication"] },
    { tags: ["methods"] },
    { tags: undefined },
    { tags: ["stats"] },
  ];

  it("counts a label however it was typed", () => {
    expect(tagVocabulary(papers)).toEqual([
      { tag: "methods", count: 3 },
      { tag: "stats", count: 2 },
      { tag: "replication", count: 1 },
    ]);
  });

  it("breaks ties alphabetically, so the list holds still", () => {
    const tied = [{ tags: ["zebra"] }, { tags: ["alpha"] }, { tags: ["mid"] }];
    expect(tagVocabulary(tied).map(({ tag }) => tag)).toEqual([
      "alpha",
      "mid",
      "zebra",
    ]);
  });

  it("has nothing to say about an untagged shelf", () => {
    expect(tagVocabulary([{ tags: [] }, {}])).toEqual([]);
  });
});

describe("suggestTags", () => {
  const vocabulary = tagVocabulary([
    { tags: ["methods", "method-note"] },
    { tags: ["methods"] },
    { tags: ["stats", "cheap methodology"] },
  ]);

  it("offers the commonest labels before anything is typed", () => {
    expect(suggestTags(vocabulary, "", { limit: 2 })).toEqual([
      "methods",
      "cheap methodology",
    ]);
  });

  it("puts prefix matches ahead of matches from inside the word", () => {
    expect(suggestTags(vocabulary, "meth")).toEqual([
      "methods",
      "method-note",
      "cheap methodology",
    ]);
  });

  it("does not offer a label the paper already wears", () => {
    expect(suggestTags(vocabulary, "meth", { exclude: ["Methods"] })).toEqual([
      "method-note",
      "cheap methodology",
    ]);
  });

  it("matches on the canonical form of what is being typed", () => {
    expect(suggestTags(vocabulary, "  METH ")).toContain("methods");
  });

  it("offers nothing rather than everything when nothing matches", () => {
    expect(suggestTags(vocabulary, "qqq")).toEqual([]);
  });
});
