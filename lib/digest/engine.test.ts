import { describe, expect, it } from "vitest";
import {
  anchorOverlap,
  assembleDigest,
  coalescedLine,
  detectCollisions,
  pairKey,
  type AnnotationType,
  type DigestAnnotation,
} from "./engine";

let counter = 0;

/** A minimal annotation; every field has a boring default so tests say only what they mean. */
function ann(
  overrides: Partial<DigestAnnotation> & { memberId: string; type: AnnotationType },
): DigestAnnotation {
  counter += 1;
  return {
    id: `a${counter}`,
    paperId: "p1",
    memberName: overrides.memberId === "ana" ? "Ana" : overrides.memberId === "ben" ? "Ben" : "Cara",
    pageIndex: 0,
    start: 100,
    end: 200,
    quote: "the model attends to every position",
    createdAt: 1000 + counter,
    ...overrides,
  };
}

const titles = new Map([
  ["p1", "Attention Is All You Need"],
  ["p2", "Deep Residual Learning"],
]);

describe("pairKey", () => {
  it("is order-free", () => {
    expect(pairKey("critique", "hypothesis")).toBe(pairKey("hypothesis", "critique"));
    expect(pairKey("hypothesis", "critique")).toBe("critique x hypothesis");
  });
});

describe("anchorOverlap", () => {
  it("fires on overlapping ranges on the same page", () => {
    const a = ann({ memberId: "ana", type: "note", start: 100, end: 200 });
    const b = ann({ memberId: "ben", type: "note", start: 150, end: 250, quote: "other" });
    expect(anchorOverlap(a, b)).toBe("range");
  });

  it("does not fire on adjacent ranges", () => {
    const a = ann({ memberId: "ana", type: "note", start: 100, end: 200, quote: "x" });
    const b = ann({ memberId: "ben", type: "note", start: 200, end: 300, quote: "y" });
    expect(anchorOverlap(a, b)).toBeNull();
  });

  it("does not fire across pages when only offsets collide", () => {
    const a = ann({ memberId: "ana", type: "note", pageIndex: 1, quote: "x" });
    const b = ann({ memberId: "ben", type: "note", pageIndex: 4, quote: "y" });
    expect(anchorOverlap(a, b)).toBeNull();
  });

  it("does not fire across papers", () => {
    const a = ann({ memberId: "ana", type: "note", paperId: "p1" });
    const b = ann({ memberId: "ben", type: "note", paperId: "p2" });
    expect(anchorOverlap(a, b)).toBeNull();
  });

  it("falls back to identical quotes at different offsets", () => {
    const a = ann({ memberId: "ana", type: "note", pageIndex: 2, start: 10, end: 40 });
    const b = ann({ memberId: "ben", type: "note", pageIndex: 5, start: 900, end: 930 });
    expect(anchorOverlap(a, b)).toBe("quote");
  });

  it("ignores empty quotes", () => {
    const a = ann({ memberId: "ana", type: "note", pageIndex: 2, quote: "  " });
    const b = ann({ memberId: "ben", type: "note", pageIndex: 5, quote: "" });
    expect(anchorOverlap(a, b)).toBeNull();
  });
});

describe("detectCollisions", () => {
  it("fires each of the five gold cells", () => {
    const cells: [AnnotationType, AnnotationType, string][] = [
      ["hypothesis", "hypothesis", "convergent theorizing"],
      ["hypothesis", "critique", "contradiction"],
      ["open-question", "definition", "possible answer"],
      ["connection-to-own-work", "connection-to-own-work", "project collision"],
      ["hypothesis", "method-note", "method available"],
    ];
    for (const [left, right, label] of cells) {
      const found = detectCollisions([
        ann({ memberId: "ana", type: left }),
        ann({ memberId: "ben", type: right }),
      ]);
      expect(found).toHaveLength(1);
      expect(found[0]?.label).toBe(label);
    }
  });

  it("ignores non-gold pairs, including anything with an untyped note", () => {
    expect(
      detectCollisions([
        ann({ memberId: "ana", type: "note" }),
        ann({ memberId: "ben", type: "hypothesis" }),
      ]),
    ).toHaveLength(0);
    expect(
      detectCollisions([
        ann({ memberId: "ana", type: "critique" }),
        ann({ memberId: "ben", type: "critique" }),
      ]),
    ).toHaveLength(0);
  });

  it("never collides a member with themselves", () => {
    expect(
      detectCollisions([
        ann({ memberId: "ana", type: "hypothesis" }),
        ann({ memberId: "ana", type: "critique" }),
      ]),
    ).toHaveLength(0);
  });

  it("requires the passages to be the same, not just the paper", () => {
    expect(
      detectCollisions([
        ann({ memberId: "ana", type: "hypothesis", start: 0, end: 50, quote: "one" }),
        ann({ memberId: "ben", type: "critique", start: 800, end: 900, quote: "two" }),
      ]),
    ).toHaveLength(0);
  });

  it("orders the pair oldest-first and stores the sorted matrix key", () => {
    const older = ann({ memberId: "ana", type: "hypothesis", createdAt: 10 });
    const newer = ann({ memberId: "ben", type: "critique", createdAt: 20 });
    const [collision] = detectCollisions([newer, older]);
    expect(collision?.a.id).toBe(older.id);
    expect(collision?.pairType).toBe("critique x hypothesis");
  });

  it("is deterministic — newest collision first", () => {
    const pool = [
      ann({ memberId: "ana", type: "hypothesis", createdAt: 10 }),
      ann({ memberId: "ben", type: "critique", createdAt: 20 }),
      ann({ memberId: "cara", type: "method-note", createdAt: 30 }),
    ];
    const found = detectCollisions(pool);
    expect(found.map((c) => c.label)).toEqual(["method available", "contradiction"]);
    expect(detectCollisions([...pool].reverse()).map((c) => c.label)).toEqual(
      found.map((c) => c.label),
    );
  });
});

describe("coalescedLine", () => {
  it("counts annotations, members and types with real plurals", () => {
    const line = coalescedLine(
      [
        ann({ memberId: "ana", type: "hypothesis" }),
        ann({ memberId: "ben", type: "hypothesis" }),
        ann({ memberId: "ben", type: "critique" }),
      ],
      "Attention Is All You Need",
    );
    expect(line).toBe(
      "3 new annotations on Attention Is All You Need from 2 members — 2 hypotheses, 1 critique",
    );
  });

  it("says one thing in the singular", () => {
    const line = coalescedLine(
      [ann({ memberId: "ana", type: "open-question" })],
      "Deep Residual Learning",
    );
    expect(line).toBe(
      "1 new annotation on Deep Residual Learning from 1 member — 1 open question",
    );
  });
});

describe("assembleDigest", () => {
  it("promotes a gold collision and addresses the recipient as 'you'", () => {
    const mine = ann({ memberId: "ana", type: "hypothesis", createdAt: 10 });
    const theirs = ann({ memberId: "ben", type: "critique", createdAt: 20 });
    const { items, droppedCount } = assembleDigest({
      recipientId: "ana",
      pool: [mine, theirs],
      delta: [theirs],
      paperTitles: titles,
    });
    expect(droppedCount).toBe(0);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("collision");
    expect(items[0]?.pairType).toBe("critique x hypothesis");
    expect(items[0]?.annotationIds).toEqual([mine.id, theirs.id]);
    expect(items[0]?.line).toBe(
      "Ben critiqued the passage you hypothesised about — Attention Is All You Need, p. 1: “the model attends to every position”",
    );
  });

  it("names both members when the recipient is a bystander", () => {
    const one = ann({ memberId: "ana", type: "hypothesis", createdAt: 10 });
    const two = ann({ memberId: "ben", type: "hypothesis", createdAt: 20 });
    const { items } = assembleDigest({
      recipientId: "cara",
      pool: [one, two],
      delta: [one, two],
      paperTitles: titles,
    });
    expect(items[0]?.line).toContain("Ana and Ben both left a hypothesis on the same passage");
  });

  it("coalesces everything that isn't gold to one line per paper", () => {
    const delta = [
      ann({ memberId: "ben", type: "note", paperId: "p1" }),
      ann({ memberId: "ben", type: "note", paperId: "p1" }),
      ann({ memberId: "cara", type: "critique", paperId: "p2" }),
    ];
    const { items } = assembleDigest({
      recipientId: "ana",
      pool: delta,
      delta,
      paperTitles: titles,
    });
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.kind === "coalesced")).toBe(true);
    expect(items.map((item) => item.paperId).sort()).toEqual(["p1", "p2"]);
  });

  it("never surfaces the recipient's own annotations as news", () => {
    const mine = [
      ann({ memberId: "ana", type: "note" }),
      ann({ memberId: "ana", type: "hypothesis" }),
    ];
    const { items } = assembleDigest({
      recipientId: "ana",
      pool: mine,
      delta: [],
      paperTitles: titles,
    });
    expect(items).toHaveLength(0);
  });

  it("caps at five items and records what it dropped", () => {
    const mine = ann({ memberId: "ana", type: "hypothesis", createdAt: 1 });
    // Seven different members each critique Ana's passage: seven gold pairs.
    const critiques = Array.from({ length: 7 }, (_, i) =>
      ann({ memberId: `m${i}`, type: "critique", createdAt: 100 + i }),
    );
    const { items, droppedCount } = assembleDigest({
      recipientId: "ana",
      pool: [mine, ...critiques],
      delta: critiques,
      paperTitles: titles,
    });
    expect(items).toHaveLength(5);
    expect(droppedCount).toBe(2);
    expect(items.every((item) => item.kind === "collision")).toBe(true);
  });

  it("puts gold ahead of coalesced when the cap bites", () => {
    const mine = ann({ memberId: "ana", type: "hypothesis", createdAt: 1 });
    const gold = ann({ memberId: "ben", type: "critique", createdAt: 500 });
    const chatter = Array.from({ length: 6 }, (_, i) =>
      ann({
        memberId: "cara",
        type: "note",
        paperId: "p2",
        start: 1000 + i * 10,
        end: 1005 + i * 10,
        quote: `chatter ${i}`,
        createdAt: 900 + i,
      }),
    );
    const { items } = assembleDigest({
      recipientId: "ana",
      pool: [mine, gold, ...chatter],
      delta: [gold, ...chatter],
      paperTitles: titles,
    });
    expect(items[0]?.kind).toBe("collision");
    expect(items).toHaveLength(2);
  });

  it("gives each new annotation at most one gold line", () => {
    // Ben's hypothesis collides with a critique, a method note and another
    // hypothesis. It should still be news exactly once.
    const bens = ann({ memberId: "ben", type: "hypothesis", createdAt: 500 });
    const pool = [
      bens,
      ann({ memberId: "ana", type: "critique", createdAt: 1 }),
      ann({ memberId: "ana", type: "method-note", createdAt: 2 }),
      ann({ memberId: "cara", type: "hypothesis", createdAt: 3 }),
    ];
    const { items } = assembleDigest({
      recipientId: "ana",
      pool,
      delta: [bens],
      paperTitles: titles,
    });
    expect(items.filter((item) => item.kind === "collision")).toHaveLength(1);
  });

  it("falls back gracefully when a paper title is missing", () => {
    const delta = [ann({ memberId: "ben", type: "note", paperId: "p9" })];
    const { items } = assembleDigest({
      recipientId: "ana",
      pool: delta,
      delta,
      paperTitles: titles,
    });
    expect(items[0]?.line).toContain("this paper");
  });
});
