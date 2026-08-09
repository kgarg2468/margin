import { describe, expect, it } from "vitest";
import type { TextAnchor } from "./anchor";
import { createAnchor, resolveAnchor } from "./anchor";
import { RECOVERY_MIN_CONFIDENCE, recoverAnchor } from "./recover";

/**
 * The passage a note was written on, and the page of the preprint it sat on.
 * Every case below is the same annotation meeting a copy of the paper that
 * paginates differently.
 */
const PASSAGE = "Serotonin release tracked patch value, not reward rate.";

const WRITTEN_ON =
  "We recorded from the dorsal raphe nucleus during foraging. " +
  PASSAGE +
  " In a second cohort we replicated the effect under satiety.";

/** A page of the same paper that has nothing to do with the passage. */
function filler(pageIndex: number): string {
  return (
    "Grid cells in the medial entorhinal cortex fire in a hexagonal lattice. " +
    `This is page ${pageIndex} of the published copy, and it is about something else.`
  );
}

/** The passage as the published copy sets it, wherever it ended up. */
function carrying(pageIndex: number): string {
  return `Continued from the preceding page. ${PASSAGE} ${filler(pageIndex)}`;
}

const PINNED_TO = 3;

function anchorOnWrittenPage(): TextAnchor {
  const at = WRITTEN_ON.indexOf(PASSAGE);
  const anchor = createAnchor(WRITTEN_ON, at, at + PASSAGE.length, PINNED_TO);
  if (anchor === null) {
    throw new Error("no anchor");
  }
  return anchor;
}

/**
 * A document that records which pages were opened, in order.
 *
 * The order is half of what is being tested: "bounded and lazy" is a claim
 * about which pages are never read, and it is not observable from the answer.
 */
function published(pages: (string | null)[]) {
  const consulted: number[] = [];
  return {
    pageCount: pages.length,
    consulted,
    load: (pageIndex: number) => {
      consulted.push(pageIndex);
      return pages[pageIndex] ?? null;
    },
  };
}

describe("recoverAnchor", () => {
  it("finds the passage on the following page and says where it went", async () => {
    const anchor = anchorOnWrittenPage();
    const republished = carrying(4);
    const doc = published([
      filler(0),
      filler(1),
      filler(2),
      filler(3),
      republished,
      filler(5),
    ]);

    const found = await recoverAnchor(anchor, doc.load, {
      pageCount: doc.pageCount,
    });

    expect(found?.pageIndex).toBe(4);
    expect(found?.offset).toBe(1);
    expect(found?.resolved.method).toBe("quote");
    expect(
      republished.slice(found?.resolved.start, found?.resolved.end),
    ).toBe(PASSAGE);
  });

  it("finds the passage on the preceding page", async () => {
    const anchor = anchorOnWrittenPage();
    const doc = published([
      filler(0),
      filler(1),
      carrying(2),
      filler(3),
      filler(4),
      filler(5),
    ]);

    const found = await recoverAnchor(anchor, doc.load, {
      pageCount: doc.pageCount,
    });

    expect(found?.pageIndex).toBe(2);
    expect(found?.offset).toBe(-1);
  });

  it("never re-reads the page the anchor is pinned to", async () => {
    // The caller has already tried that page and been told no; that miss is
    // the entire reason this function was called.
    const anchor = anchorOnWrittenPage();
    const doc = published([
      filler(0),
      filler(1),
      filler(2),
      carrying(3),
      carrying(4),
      filler(5),
    ]);

    const found = await recoverAnchor(anchor, doc.load, {
      pageCount: doc.pageCount,
    });

    expect(doc.consulted).not.toContain(PINNED_TO);
    expect(found?.pageIndex).toBe(4);
  });

  it("reaches two pages out only after both neighbours have missed", async () => {
    const anchor = anchorOnWrittenPage();
    const doc = published([
      filler(0),
      filler(1),
      filler(2),
      filler(3),
      filler(4),
      carrying(5),
    ]);

    const found = await recoverAnchor(anchor, doc.load, {
      pageCount: doc.pageCount,
    });

    expect(found?.pageIndex).toBe(5);
    expect(found?.offset).toBe(2);
    // Both sides of the near ring, then both sides of the far one. Nothing else.
    expect(doc.consulted).toEqual([2, 4, 1, 5]);
  });

  it("reads no further once a neighbour has answered", async () => {
    const anchor = anchorOnWrittenPage();
    const doc = published([
      filler(0),
      carrying(1),
      filler(2),
      filler(3),
      carrying(4),
      filler(5),
    ]);

    const found = await recoverAnchor(anchor, doc.load, {
      pageCount: doc.pageCount,
    });

    // Page 1 also has it, two pages back — but a passage that drifted by one
    // is the better answer, and the far ring is never opened.
    expect(found?.pageIndex).toBe(4);
    expect(doc.consulted).toEqual([2, 4]);
  });

  it("gives up rather than guess when both neighbours carry the passage", async () => {
    // A running definition, a repeated caption, boilerplate in a template: the
    // words are on both sides and no evidence here can say which one the note
    // was about. An unanchored note keeps its own words in the rail and says
    // so; a note on the wrong sentence is a false claim nobody can catch.
    const anchor = anchorOnWrittenPage();
    const doc = published([
      filler(0),
      carrying(1),
      carrying(2),
      filler(3),
      carrying(4),
      filler(5),
    ]);

    const found = await recoverAnchor(anchor, doc.load, {
      pageCount: doc.pageCount,
    });

    expect(found).toBeNull();
    // And it did not then fall through to the far ring, where page 1 would
    // have looked like a clean single answer.
    expect(doc.consulted).toEqual([2, 4]);
  });

  it("stops two pages out rather than searching the paper", async () => {
    const anchor = anchorOnWrittenPage();
    const doc = published([
      carrying(0),
      filler(1),
      filler(2),
      filler(3),
      filler(4),
      filler(5),
    ]);

    expect(
      await recoverAnchor(anchor, doc.load, { pageCount: doc.pageCount }),
    ).toBeNull();
    expect(doc.consulted).toEqual([2, 4, 1, 5]);
  });

  it("returns nothing when the passage is not in this file at all", async () => {
    const anchor = anchorOnWrittenPage();
    const doc = published([0, 1, 2, 3, 4, 5].map(filler));

    expect(
      await recoverAnchor(anchor, doc.load, { pageCount: doc.pageCount }),
    ).toBeNull();
  });

  it("does not read past either cover", async () => {
    const anchor = { ...anchorOnWrittenPage(), pageIndex: 0 };
    const doc = published([filler(0), filler(1), carrying(2)]);

    const found = await recoverAnchor(anchor, doc.load, {
      pageCount: doc.pageCount,
    });

    expect(found?.pageIndex).toBe(2);
    expect(doc.consulted).toEqual([1, 2]);
  });

  it("reads nothing at all for a paper with one page", async () => {
    const anchor = { ...anchorOnWrittenPage(), pageIndex: 0 };
    const doc = published([WRITTEN_ON]);

    expect(
      await recoverAnchor(anchor, doc.load, { pageCount: doc.pageCount }),
    ).toBeNull();
    expect(doc.consulted).toEqual([]);
  });

  it("skips a page it could not read instead of failing the recovery", async () => {
    const anchor = anchorOnWrittenPage();
    const doc = published([filler(0), filler(1), null, filler(3), carrying(4)]);

    const found = await recoverAnchor(anchor, doc.load, {
      pageCount: doc.pageCount,
    });

    expect(found?.pageIndex).toBe(4);
  });

  it("does not believe the recorded offsets on somebody else's page", async () => {
    // The anchor starts at character 0 of the page it was written on, and the
    // page it drifted onto happens to open with the same sentence quoted in
    // passing. The offsets are meaningless here — they address a different
    // string — and taking them would put the note on the mention rather than
    // on the passage, at confidence 1.
    const written =
      "The dorsal raphe nucleus is the principal source of forebrain serotonin, we found.";
    const quote =
      "The dorsal raphe nucleus is the principal source of forebrain serotonin";
    const anchor = createAnchor(written, 0, quote.length, PINNED_TO);
    if (anchor === null) {
      throw new Error("no anchor");
    }
    expect(anchor.start).toBe(0);

    const drifted =
      `${quote} is a claim we return to below. ` +
      "Methods are unchanged from the preceding section. " +
      `${quote}, we found.`;
    const doc = published([
      filler(0),
      filler(1),
      filler(2),
      filler(3),
      drifted,
      filler(5),
    ]);

    const found = await recoverAnchor(anchor, doc.load, {
      pageCount: doc.pageCount,
    });

    expect(found?.pageIndex).toBe(4);
    expect(found?.resolved.method).toBe("context");
    expect(found?.resolved.start).toBe(drifted.lastIndexOf(quote));
  });

  it("refuses a neighbouring match it would only have been fairly sure of", async () => {
    // On the anchor's own page a match like this is worth drawing with a
    // dashed rule: the note was written there. On a page nobody claimed, the
    // match is the only evidence there is, so the bar is higher.
    const anchor = anchorOnWrittenPage();
    const rewritten =
      "Continued from the preceding page. " +
      "Serotonin release tracked patch quality, not the reward rate.";
    const doc = published([
      filler(0),
      filler(1),
      filler(2),
      filler(3),
      rewritten,
      filler(5),
    ]);

    // The resolver on its own does find something here — this is about the
    // extra confidence cross-page recovery demands, not about a missing match.
    const direct = resolveAnchor(anchor, rewritten, { trustPosition: false });
    expect(direct?.method).toBe("fuzzy");
    expect(direct?.confidence).toBeGreaterThan(0);
    expect(direct?.confidence).toBeLessThan(RECOVERY_MIN_CONFIDENCE);

    expect(
      await recoverAnchor(anchor, doc.load, { pageCount: doc.pageCount }),
    ).toBeNull();
  });

  it("recovers a passage the publisher re-set, when it is clearly the one", async () => {
    // Curly quotes and an em dash for a hyphen: the same sentence, one page on.
    const preprint = 'The "Hebbian" rule - roughly, fire together, wire together.';
    const anchor = createAnchor(preprint, 0, preprint.length - 1, PINNED_TO);
    if (anchor === null) {
      throw new Error("no anchor");
    }
    const doc = published([
      filler(0),
      filler(1),
      filler(2),
      filler(3),
      "Section 2. The “Hebbian” rule — roughly, fire together, wire together. And so on.",
      filler(5),
    ]);

    const found = await recoverAnchor(anchor, doc.load, {
      pageCount: doc.pageCount,
    });

    expect(found?.pageIndex).toBe(4);
    expect(found?.resolved.method).toBe("fuzzy");
    expect(found?.resolved.confidence).toBeGreaterThanOrEqual(
      RECOVERY_MIN_CONFIDENCE,
    );
  });

  it("honours a caller that wants a tighter or wider ring", async () => {
    const anchor = anchorOnWrittenPage();
    const pages = [
      filler(0),
      filler(1),
      filler(2),
      filler(3),
      filler(4),
      carrying(5),
    ];

    const near = published([...pages]);
    expect(
      await recoverAnchor(anchor, near.load, {
        pageCount: near.pageCount,
        radius: 1,
      }),
    ).toBeNull();
    expect(near.consulted).toEqual([2, 4]);

    const wide = published([...pages]);
    expect(
      (
        await recoverAnchor(anchor, wide.load, {
          pageCount: wide.pageCount,
          radius: 2,
        })
      )?.pageIndex,
    ).toBe(5);
  });
});
