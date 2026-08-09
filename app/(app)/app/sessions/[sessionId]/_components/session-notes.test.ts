import { describe, expect, it } from "vitest";
import { ANNOTATION_TYPES } from "../../../library/[paperId]/read/_components/ontology";
import type { AnnotationType } from "../../../library/[paperId]/read/_components/ontology";
import { FLOOR } from "./session-board";
import {
  anchoredIds,
  AT_THE_PASSAGE,
  MAX_PASSAGE_CARDS,
  ON_THE_FLOOR,
} from "./session-notes";

/** As much of a note as the anchoring question needs. */
function note(id: string, type: AnnotationType = "note") {
  return { _id: id, type };
}

/** A board with nothing on it, for a test to put one thing on. */
function board(over: {
  inSession?: { _id: string; type: AnnotationType }[];
  replies?: [string, { _id: string; type: AnnotationType }[]][];
  passages?: { notes: { _id: string; type: AnnotationType }[] }[];
}) {
  return {
    inSession: over.inSession ?? [],
    repliesByParent: new Map(over.replies ?? []),
    passages: over.passages ?? [],
  };
}

describe("anchoredIds", () => {
  it("anchors a floor note and the replies drawn under it", () => {
    const parent = note("q1", "open-question");
    const anchored = anchoredIds(
      board({
        inSession: [parent],
        replies: [["q1", [note("r1"), note("r2")]]],
      }),
    );
    expect([...anchored].sort()).toEqual(["q1", "r1", "r2"]);
  });

  it("does not anchor replies to a note the board never draws", () => {
    // Replies are session-scoped but their parent need not be: a reply in this
    // session to a note written on the paper months ago has nothing on screen
    // to jump to.
    const anchored = anchoredIds(
      board({ replies: [["elsewhere-1", [note("r1")]]] }),
    );
    expect(anchored.size).toBe(0);
  });

  it("anchors passage notes only while their card is still drawn", () => {
    const passages = Array.from({ length: MAX_PASSAGE_CARDS + 1 }, (_, i) => ({
      notes: [note(`p${i}`, "hypothesis")],
    }));
    const anchored = anchoredIds(
      board({
        passages,
        inSession: passages.flatMap((passage) => passage.notes),
      }),
    );
    expect(anchored.has("p0")).toBe(true);
    expect(anchored.has(`p${MAX_PASSAGE_CARDS - 1}`)).toBe(true);
    // Past the cap the card is never rendered, so neither is its anchor.
    expect(anchored.has(`p${MAX_PASSAGE_CARDS}`)).toBe(false);
  });

  it("ignores a floor-type note sitting inside a passage group", () => {
    // A passage groups everything written on it, but its card only draws the
    // four types that have no column of their own — the critique on that same
    // sentence is anchored down on the floor instead, once.
    //
    // The critique is deliberately *not* in `inSession` here, which no real
    // grouping would produce: the point is to run the passage loop on its own,
    // where the type guard is the only thing that can decide. With the
    // critique also on the floor — as it always is in real data — the floor
    // loop anchors it either way, and the expectation below would hold with
    // the guard deleted, which is a test that watches nothing.
    const anchored = anchoredIds(
      board({
        passages: [{ notes: [note("c1", "critique"), note("h1", "hypothesis")] }],
      }),
    );
    expect([...anchored].sort()).toEqual(["h1"]);
  });

  it("anchors a floor note whose passage card was never drawn", () => {
    // The same rule from the other side, on data the grouping really makes: a
    // critique written on the four-hundredth passage has no card, and does not
    // need one. It stands in the floor's Critiques column, so the citation
    // pointing at it still lands.
    const critique = note("c1", "critique");
    const passages = Array.from({ length: MAX_PASSAGE_CARDS + 1 }, (_, i) => ({
      notes: [note(`p${i}`, "hypothesis")],
    }));
    passages[MAX_PASSAGE_CARDS]?.notes.push(critique);

    const anchored = anchoredIds(
      board({
        passages,
        inSession: passages.flatMap((passage) => passage.notes),
      }),
    );

    expect(anchored.has("c1")).toBe(true);
    expect(anchored.has(`p${MAX_PASSAGE_CARDS}`)).toBe(false);
  });

  it("anchors nothing when the lab wrote nothing", () => {
    expect(anchoredIds(board({})).size).toBe(0);
  });
});

describe("where a note is drawn", () => {
  it("partitions the ontology — every type has exactly one home", () => {
    // The board's promise is that a note appears exactly once, and
    // `anchoredIds` reads that promise off these two lists. An eighth type
    // added to the ontology and to neither list would render on the board
    // with no anchor while its citations still linked to it.
    expect([...AT_THE_PASSAGE, ...ON_THE_FLOOR].sort()).toEqual(
      ANNOTATION_TYPES.map((style) => style.value).sort(),
    );
  });

  it("draws the floor's columns from the same three types it anchors", () => {
    // The partition above cannot see this. `FLOOR` is what the board actually
    // renders; `ON_THE_FLOOR` is what `anchoredIds` emits anchors for. Move a
    // type between the two lists and the partition still holds — every type
    // still has exactly one home — while the board grows a column whose notes
    // no citation can link to. In order, too: the columns are the order a
    // meeting works down them, and reading it out of one list keeps the
    // comparison honest about which list is the rule.
    expect(FLOOR.map((column) => column.type)).toEqual([...ON_THE_FLOOR]);
  });
});
