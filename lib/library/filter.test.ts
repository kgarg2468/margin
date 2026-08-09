import { describe, expect, it } from "vitest";
import type { FilterablePaper, LibraryFilter } from "./filter";
import {
  applyLibraryFilter,
  describeFilter,
  emptyFilter,
  filtersEqual,
  isEmptyFilter,
  matchesFilter,
  matchesText,
  toggleTag,
} from "./filter";

function paper(
  id: string,
  overrides: Partial<FilterablePaper> = {},
): FilterablePaper {
  return {
    _id: id,
    title: `Paper ${id}`,
    ingestStatus: "ready",
    ...overrides,
  };
}

const franklin = paper("a", {
  title: "Molecular structure of nucleic acids",
  authors: ["Rosalind Franklin", "Raymond Gosling"],
  year: 1953,
  venue: "Nature",
  tags: ["foundational", "methods"],
});
const attention = paper("b", {
  title: "Attention is all you need",
  year: 2017,
  tags: ["methods"],
  ingestStatus: "needs-pdf",
});
const untagged = paper("c", { title: "A paper nobody tagged", year: 2024 });
const replication = paper("d", {
  title: "Replication crisis",
  tags: ["methods", "replication"],
});

const shelf: FilterablePaper[] = [franklin, attention, untagged, replication];

function filter(overrides: Partial<LibraryFilter> = {}): LibraryFilter {
  return { ...emptyFilter, ...overrides };
}

describe("isEmptyFilter", () => {
  it("is true only for the whole shelf", () => {
    expect(isEmptyFilter(emptyFilter)).toBe(true);
    expect(isEmptyFilter(filter({ tags: ["methods"] }))).toBe(false);
    expect(isEmptyFilter(filter({ collectionId: "k1" }))).toBe(false);
    expect(isEmptyFilter(filter({ ingestStatus: "ready" }))).toBe(false);
  });
});

describe("matchesFilter", () => {
  it("ANDs tags — a filter narrows, it does not widen", () => {
    const both = filter({ tags: ["methods", "replication"] });
    expect(matchesFilter(replication, both, null)).toBe(true);
    expect(matchesFilter(attention, both, null)).toBe(false);
  });

  it("compares tags in canonical form on both sides", () => {
    expect(
      matchesFilter(
        paper("x", { tags: ["  Methods "] }),
        filter({ tags: ["METHODS"] }),
        null,
      ),
    ).toBe(true);
  });

  it("holds a paper to the ingest state that was asked for", () => {
    expect(matchesFilter(attention, filter({ ingestStatus: "needs-pdf" }), null)).toBe(
      true,
    );
    expect(matchesFilter(franklin, filter({ ingestStatus: "needs-pdf" }), null)).toBe(
      false,
    );
  });

  it("keeps only what the collection holds", () => {
    const inCollection = filter({ collectionId: "k1" });
    expect(matchesFilter(franklin, inCollection, new Set(["a", "d"]))).toBe(true);
    expect(matchesFilter(attention, inCollection, new Set(["a", "d"]))).toBe(false);
  });

  it("matches nothing when the named collection is gone", () => {
    // Not "everything": a filter pointing at a deleted shelf has not become
    // the empty filter, it has become a question with no answer.
    const orphaned = filter({ collectionId: "deleted" });
    expect(shelf.some((row) => matchesFilter(row, orphaned, null))).toBe(false);
  });
});

describe("matchesText", () => {
  it("takes every word, from any field", () => {
    expect(matchesText(franklin, "franklin 1953")).toBe(true);
    expect(matchesText(franklin, "nucleic nature")).toBe(true);
    expect(matchesText(franklin, "franklin 1954")).toBe(false);
  });

  it("ignores case and surrounding space", () => {
    expect(matchesText(attention, "  ATTENTION ")).toBe(true);
  });

  it("reads tags too, so a mark you can see is a word you can type", () => {
    expect(matchesText(replication, "replication")).toBe(true);
  });

  it("is not a filter at all when the box is empty", () => {
    expect(shelf.every((row) => matchesText(row, "   "))).toBe(true);
  });
});

describe("applyLibraryFilter", () => {
  it("leaves the shelf alone, in its own order, when nothing is selected", () => {
    expect(
      applyLibraryFilter(shelf, { filter: emptyFilter }).map((row) => row._id),
    ).toEqual(["a", "b", "c", "d"]);
  });

  it("intersects the filter with the text box", () => {
    const result = applyLibraryFilter(shelf, {
      filter: filter({ tags: ["methods"] }),
      text: "replication",
    });
    expect(result.map((row) => row._id)).toEqual(["d"]);
  });

  it("hands a collection back in the collection's order, not the library's", () => {
    const result = applyLibraryFilter(shelf, {
      filter: filter({ collectionId: "k1" }),
      collectionPaperIds: ["d", "a"],
    });
    expect(result.map((row) => row._id)).toEqual(["d", "a"]);
  });

  it("still narrows a collection by tag and by text", () => {
    const result = applyLibraryFilter(shelf, {
      filter: filter({ collectionId: "k1", tags: ["foundational"] }),
      collectionPaperIds: ["d", "a", "b"],
    });
    expect(result.map((row) => row._id)).toEqual(["a"]);
  });

  it("drops a paper the collection lists but the library no longer has", () => {
    const result = applyLibraryFilter(shelf, {
      filter: filter({ collectionId: "k1" }),
      collectionPaperIds: ["gone", "a"],
    });
    expect(result.map((row) => row._id)).toEqual(["a"]);
  });
});

describe("toggleTag", () => {
  it("adds, then takes back", () => {
    const on = toggleTag(emptyFilter, "Methods");
    expect(on.tags).toEqual(["methods"]);
    expect(toggleTag(on, "methods").tags).toEqual([]);
  });

  it("ignores something that was never a tag", () => {
    expect(toggleTag(emptyFilter, "   ")).toEqual(emptyFilter);
  });
});

describe("filtersEqual", () => {
  it("does not care what order the tags were picked in", () => {
    expect(
      filtersEqual(
        filter({ tags: ["a", "b"] }),
        filter({ tags: ["b", "a"] }),
      ),
    ).toBe(true);
  });

  it("separates filters that ask different questions", () => {
    expect(
      filtersEqual(filter({ tags: ["a"] }), filter({ tags: ["a", "b"] })),
    ).toBe(false);
    expect(
      filtersEqual(filter({ collectionId: "k1" }), filter({ collectionId: "k2" })),
    ).toBe(false);
    expect(
      filtersEqual(filter({ ingestStatus: "ready" }), emptyFilter),
    ).toBe(false);
  });
});

describe("describeFilter", () => {
  it("says what is on screen, the way a person would", () => {
    expect(
      describeFilter(filter({ collectionId: "k1", tags: ["methods"] }), {
        collectionName: "Foundational",
      }),
    ).toBe("Foundational · #methods");
  });

  it("names the whole shelf rather than saying nothing", () => {
    expect(describeFilter(emptyFilter)).toBe("Everything");
  });

  it("is honest about a collection that has been deleted", () => {
    expect(describeFilter(filter({ collectionId: "k1" }))).toBe(
      "a deleted collection",
    );
  });

  it("spells an ingest state out", () => {
    expect(describeFilter(filter({ ingestStatus: "needs-pdf" }))).toBe(
      "needs a PDF",
    );
  });
});
