import { describe, expect, it } from "vitest";
import { ownPrivateNotes, tallyContributors, type MarginRow } from "./prep";

let counter = 0;

/** A row of the margin as `annotations.listForPaper` hands it over. */
function row(overrides: Partial<MarginRow> & { memberId: string }): MarginRow {
  counter += 1;
  return {
    _id: `a${counter}`,
    authorName: overrides.memberId === "ana" ? "Ana Ruiz" : "Ben Okafor",
    mine: false,
    type: "note",
    visibility: "lab",
    deleted: false,
    body: "",
    anchor: { pageIndex: 0, quote: "a passage" },
    ...overrides,
  };
}

describe("tallyContributors", () => {
  it("counts what each member wrote, by type", () => {
    const rows = [
      row({ memberId: "ana", type: "critique" }),
      row({ memberId: "ana", type: "critique" }),
      row({ memberId: "ana", type: "open-question" }),
      row({ memberId: "ben", type: "hypothesis" }),
    ];
    const [ana, ben] = tallyContributors(rows);
    expect(ana?.name).toBe("Ana Ruiz");
    expect(ana?.total).toBe(3);
    expect(ana?.counts).toEqual([
      { type: "critique", count: 2 },
      { type: "open-question", count: 1 },
    ]);
    expect(ben?.total).toBe(1);
  });

  it("counts replies — four sharp replies is having done the reading", () => {
    const parent = row({ memberId: "ana", type: "critique" });
    const rows = [
      parent,
      row({ memberId: "ben", type: "note", parentId: parent._id }),
      row({ memberId: "ben", type: "note", parentId: parent._id }),
    ];
    expect(tallyContributors(rows)[0]?.total).toBe(2);
  });

  it("never emits a member with a count of zero", () => {
    // The constitution protects the member who did not write. A roster with an
    // empty column beside a name is the artifact it exists to prevent, so the
    // lab's membership is never consulted and a zero has no way to appear.
    const rows = [row({ memberId: "ana", type: "note" })];
    const tally = tallyContributors(rows);
    expect(tally).toHaveLength(1);
    expect(tally.every((one) => one.total > 0)).toBe(true);
  });

  it("ignores private notes, including the caller's own", () => {
    const rows = [
      row({ memberId: "ana", type: "note" }),
      row({ memberId: "ana", type: "critique", visibility: "private", mine: true }),
    ];
    const [ana] = tallyContributors(rows);
    expect(ana?.total).toBe(1);
    expect(ana?.counts).toEqual([{ type: "note", count: 1 }]);
  });

  it("ignores withdrawn notes", () => {
    const rows = [
      row({ memberId: "ana", type: "note" }),
      row({ memberId: "ana", type: "note", deleted: true }),
    ];
    expect(tallyContributors(rows)[0]?.total).toBe(1);
  });

  it("drops a member entirely when everything they wrote is gone", () => {
    const rows = [
      row({ memberId: "ana", type: "note" }),
      row({ memberId: "ben", type: "note", deleted: true }),
    ];
    expect(tallyContributors(rows).map((one) => one.memberId)).toEqual(["ana"]);
  });

  it("puts the busiest margin first, and breaks ties by name", () => {
    const rows = [
      row({ memberId: "ben", type: "note" }),
      row({ memberId: "ana", type: "note" }),
      row({ memberId: "ana", type: "note" }),
    ];
    expect(tallyContributors(rows).map((one) => one.memberId)).toEqual([
      "ana",
      "ben",
    ]);

    const tied = [
      row({ memberId: "ben", type: "note" }),
      row({ memberId: "ana", type: "note" }),
    ];
    expect(tallyContributors(tied).map((one) => one.name)).toEqual([
      "Ana Ruiz",
      "Ben Okafor",
    ]);
  });

  it("marks the caller's own row so the panel can say 'You'", () => {
    const rows = [row({ memberId: "ana", type: "note", mine: true })];
    expect(tallyContributors(rows)[0]?.mine).toBe(true);
  });

  it("is empty for an empty margin", () => {
    expect(tallyContributors([])).toEqual([]);
  });
});

describe("ownPrivateNotes", () => {
  it("returns the caller's private notes and nothing else", () => {
    const rows = [
      row({ memberId: "ana", visibility: "private", mine: true, body: "mine" }),
      row({ memberId: "ana", visibility: "lab", mine: true, body: "shared" }),
      row({ memberId: "ben", visibility: "private", mine: false, body: "theirs" }),
    ];
    const own = ownPrivateNotes(rows);
    expect(own).toHaveLength(1);
    expect(own[0]?.body).toBe("mine");
  });

  it("cannot return somebody else's private note even if the flag disagrees", () => {
    // Belt and braces on the one rule that matters: `mine` and `visibility`
    // both have to hold. `listForPaper` never sends another member's private
    // row, and this would not show it if it did.
    const rows = [row({ memberId: "ben", visibility: "private", mine: false })];
    expect(ownPrivateNotes(rows)).toEqual([]);
  });

  it("leaves out withdrawn notes", () => {
    const rows = [
      row({ memberId: "ana", visibility: "private", mine: true, deleted: true }),
    ];
    expect(ownPrivateNotes(rows)).toEqual([]);
  });

  it("leaves out replies", () => {
    const rows = [
      row({
        memberId: "ana",
        visibility: "private",
        mine: true,
        parentId: "a999",
      }),
    ];
    expect(ownPrivateNotes(rows)).toEqual([]);
  });

  it("reads in page order — it is the outline the presenter speaks from", () => {
    const rows = [
      row({
        memberId: "ana",
        visibility: "private",
        mine: true,
        body: "late",
        anchor: { pageIndex: 8, quote: "q" },
      }),
      row({
        memberId: "ana",
        visibility: "private",
        mine: true,
        body: "early",
        anchor: { pageIndex: 1, quote: "q" },
      }),
    ];
    expect(ownPrivateNotes(rows).map((one) => one.body)).toEqual([
      "early",
      "late",
    ]);
  });
});
