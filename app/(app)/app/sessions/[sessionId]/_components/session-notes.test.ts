import { describe, expect, it } from "vitest";
import { ANNOTATION_TYPES } from "../../../library/[paperId]/read/_components/ontology";
import type { AnnotationType } from "../../../library/[paperId]/read/_components/ontology";
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
    const critique = note("c1", "critique");
    const anchored = anchoredIds(
      board({
        inSession: [critique],
        passages: [{ notes: [critique, note("h1", "hypothesis")] }],
      }),
    );
    expect([...anchored].sort()).toEqual(["c1", "h1"]);
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
});
