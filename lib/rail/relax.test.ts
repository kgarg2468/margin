import { describe, expect, it } from "vitest";
import { relaxColumn, type RelaxItem } from "./relax";

/**
 * The property worth holding here is not "cards do not overlap" — the greedy
 * pass this replaces managed that. It is *where the error goes*. A typesetter
 * pushing down a run of six notes hands the whole accumulated shove to the
 * sixth; the pass below spreads it, so no note is far from its passage and the
 * middle of a crowded run stays where it belongs. The tests are written as
 * statements about displacement rather than about coordinates, because the
 * coordinates are only interesting as evidence.
 */

const GAP = 10;

function item(id: string, wanted: number, height = 100): RelaxItem {
  return { id, wanted, height };
}

describe("a column with room in it", () => {
  it("leaves every card exactly where its passage is", () => {
    const { placements } = relaxColumn(
      [item("a", 0), item("b", 200), item("c", 500)],
      { gap: GAP },
    );
    expect(placements.map((p) => p.top)).toEqual([0, 200, 500]);
    expect(placements.map((p) => p.drift)).toEqual([0, 0, 0]);
  });

  it("reports the bottom of the last card as the height it needs", () => {
    const { contentHeight } = relaxColumn([item("a", 0), item("b", 500)], {
      gap: GAP,
    });
    expect(contentHeight).toBe(600);
  });

  it("takes cards in any order and returns them in document order", () => {
    const { placements } = relaxColumn(
      [item("c", 500), item("a", 0), item("b", 200)],
      { gap: GAP },
    );
    expect(placements.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("breaks a tie by id, so a re-render cannot reshuffle the margin", () => {
    const first = relaxColumn([item("b", 40), item("a", 40)], { gap: GAP });
    const second = relaxColumn([item("a", 40), item("b", 40)], { gap: GAP });
    expect(first.placements.map((p) => p.id)).toEqual(["a", "b"]);
    expect(second.placements.map((p) => p.id)).toEqual(["a", "b"]);
  });
});

describe("two cards that want the same line", () => {
  it("splits the displacement instead of shoving one of them down twice as far", () => {
    const { placements } = relaxColumn([item("a", 200), item("b", 200)], {
      gap: GAP,
    });
    const [a, b] = placements;
    expect(a?.top).toBe(145);
    expect(b?.top).toBe(255);
    expect(a?.drift).toBe(-55);
    expect(b?.drift).toBe(55);
  });

  it("keeps the gap between them", () => {
    const { placements } = relaxColumn(
      [{ id: "a", wanted: 200, height: 60 }, { id: "b", wanted: 205, height: 140 }],
      { gap: GAP },
    );
    const [a, b] = placements;
    expect((b?.top ?? 0) - ((a?.top ?? 0) + 60)).toBe(GAP);
  });
});

describe("a crowded run", () => {
  const run = relaxColumn(
    ["a", "b", "c", "d", "e"].map((id) => item(id, 500)),
    { gap: GAP },
  );

  it("centres the run on the passage rather than hanging it below", () => {
    expect(run.placements.map((p) => p.top)).toEqual([280, 390, 500, 610, 720]);
  });

  it("gives no single card more than its share of the error", () => {
    const worst = Math.max(...run.placements.map((p) => Math.abs(p.drift)));
    // The greedy pass put the last card 440px from its passage. Nothing here
    // is more than half that.
    expect(worst).toBe(220);
  });

  it("grows the column to hold what it placed", () => {
    expect(run.contentHeight).toBe(820);
  });
});

describe("the top of the rail", () => {
  it("never lifts a card above the first line of the paper", () => {
    const { placements } = relaxColumn([item("a", 0), item("b", 20)], {
      gap: GAP,
      floor: 0,
    });
    expect(placements.map((p) => p.top)).toEqual([0, 110]);
  });

  it("still keeps the gap when the floor is what is doing the pushing", () => {
    const { placements } = relaxColumn(
      [item("a", -300), item("b", -300)],
      { gap: GAP, floor: 0 },
    );
    expect(placements.map((p) => p.top)).toEqual([0, 110]);
  });

  it("honours a floor that is not zero", () => {
    const { placements } = relaxColumn([item("a", 0)], { gap: GAP, floor: 24 });
    expect(placements[0]?.top).toBe(24);
  });
});

describe("the shape of the answer, at the size a paper can actually reach", () => {
  const many = Array.from({ length: 1000 }, (_, index) =>
    item(String(index).padStart(4, "0"), Math.floor(index / 3) * 40, 70),
  );
  const { placements, contentHeight } = relaxColumn(many, { gap: GAP });

  it("places every card once", () => {
    expect(placements).toHaveLength(1000);
    expect(new Set(placements.map((p) => p.id)).size).toBe(1000);
  });

  it("never overlaps two cards", () => {
    for (let i = 1; i < placements.length; i++) {
      const above = placements[i - 1];
      const below = placements[i];
      expect(below?.top ?? 0).toBeGreaterThanOrEqual((above?.top ?? 0) + 70 + GAP);
    }
  });

  it("reports a height that contains the last card", () => {
    expect(contentHeight).toBe((placements.at(-1)?.top ?? 0) + 70);
  });
});

describe("nothing to place", () => {
  it("is not an error", () => {
    expect(relaxColumn([])).toEqual({ placements: [], contentHeight: 0 });
  });
});
