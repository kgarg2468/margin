import { describe, expect, it } from "vitest";
import {
  anchorOverlap,
  assembleDigest,
  coalescedLine,
  crossPaperOverlap,
  detectCollisions,
  detectCrossPaperCollisions,
  pairKey,
  MIN_CROSS_PAPER_QUOTE_CHARS,
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

  it("will not call two short identical selections the same passage", () => {
    // "Figure 3" recurs; matching on it would manufacture collisions.
    const a = ann({ memberId: "ana", type: "note", pageIndex: 2, quote: " Figure 3 " });
    const b = ann({ memberId: "ben", type: "note", pageIndex: 5, quote: "Figure 3" });
    expect(a.quote.trim().length).toBeLessThan(20);
    expect(anchorOverlap(a, b)).toBeNull();
  });

  it("still falls back on a long identical selection", () => {
    const quote = "attention is all you need, really";
    expect(quote.length).toBeGreaterThanOrEqual(20);
    const a = ann({ memberId: "ana", type: "note", pageIndex: 2, quote });
    const b = ann({ memberId: "ben", type: "note", pageIndex: 5, quote });
    expect(anchorOverlap(a, b)).toBe("quote");
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

  it("does not promote a collision the recipient had no part in", () => {
    // Ana and Ben converged on a passage. That is a real gold pair — but for
    // Cara it is news about the lab, not news about her, so it coalesces
    // instead of spending one of her five lines.
    const one = ann({ memberId: "ana", type: "hypothesis", createdAt: 10 });
    const two = ann({ memberId: "ben", type: "hypothesis", createdAt: 20 });
    const { items } = assembleDigest({
      recipientId: "cara",
      pool: [one, two],
      delta: [one, two],
      paperTitles: titles,
    });
    expect(detectCollisions([one, two])).toHaveLength(1);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("coalesced");
    expect(items[0]?.annotationIds).toEqual([one.id, two.id]);
    expect(items[0]?.line).toBe(
      "2 new annotations on Attention Is All You Need from 2 members — 2 hypotheses",
    );
  });

  it("still promotes the same collision for the members who are in it", () => {
    const one = ann({ memberId: "ana", type: "hypothesis", createdAt: 10 });
    const two = ann({ memberId: "ben", type: "hypothesis", createdAt: 20 });
    const { items } = assembleDigest({
      recipientId: "ana",
      pool: [one, two],
      delta: [two],
      paperTitles: titles,
    });
    expect(items[0]?.kind).toBe("collision");
    expect(items[0]?.line).toContain("You and Ben both left a hypothesis on the same passage");
  });

  it("accepts precomputed collisions and ranks them the same way", () => {
    const mine = ann({ memberId: "ana", type: "hypothesis", createdAt: 10 });
    const theirs = ann({ memberId: "ben", type: "critique", createdAt: 20 });
    const pool = [mine, theirs];
    const detected = assembleDigest({
      recipientId: "ana",
      pool,
      delta: [theirs],
      paperTitles: titles,
    });
    const supplied = assembleDigest({
      recipientId: "ana",
      pool,
      delta: [theirs],
      paperTitles: titles,
      // Handed in unsorted, as a whole-lab pass would produce it.
      collisions: detectCollisions(pool).reverse(),
    });
    expect(supplied).toEqual(detected);
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

  it("gives each new annotation at most one gold line, and says which", () => {
    // Ben's hypothesis collides with two of Ana's annotations and with Cara's.
    // Cara's is not Ana's business at all; of the two that are, the tie on
    // recency breaks on id, so the critique is the one Ana hears about.
    const bens = ann({ id: "ben-hypothesis", memberId: "ben", type: "hypothesis", createdAt: 500 });
    const critique = ann({ id: "ana-critique", memberId: "ana", type: "critique", createdAt: 1 });
    const method = ann({ id: "ana-method", memberId: "ana", type: "method-note", createdAt: 2 });
    const caras = ann({ id: "cara-hypothesis", memberId: "cara", type: "hypothesis", createdAt: 3 });
    const pool = [bens, critique, method, caras];
    const { items } = assembleDigest({
      recipientId: "ana",
      pool,
      delta: [bens],
      paperTitles: titles,
    });
    // Five gold pairs exist in the pool; exactly one becomes Ana's line.
    expect(detectCollisions(pool)).toHaveLength(5);
    const gold = items.filter((item) => item.kind === "collision");
    expect(gold).toHaveLength(1);
    expect(gold[0]?.pairType).toBe("critique x hypothesis");
    expect(gold[0]?.annotationIds).toEqual([critique.id, bens.id]);
    expect(gold[0]?.line).toContain("You critiqued the passage Ben hypothesised about");
  });

  it("promotes the most recent of a recipient's collisions when the cap bites", () => {
    const mine = ann({ id: "mine", memberId: "ana", type: "hypothesis", createdAt: 1 });
    const older = ann({ id: "older", memberId: "ben", type: "critique", createdAt: 100 });
    const newer = ann({ id: "newer", memberId: "cara", type: "critique", createdAt: 200 });
    const { items } = assembleDigest({
      recipientId: "ana",
      pool: [mine, older, newer],
      delta: [older, newer],
      paperTitles: titles,
      cap: 1,
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.annotationIds).toEqual([mine.id, newer.id]);
  });

  it("counts dropped annotations, not dropped lines", () => {
    const mine = ann({ memberId: "ana", type: "hypothesis", createdAt: 1 });
    const gold = ann({ memberId: "ben", type: "critique", createdAt: 500 });
    // One coalesced line for p2, hiding six annotations behind it.
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
    const { items, droppedCount } = assembleDigest({
      recipientId: "ana",
      pool: [mine, gold, ...chatter],
      delta: [gold, ...chatter],
      paperTitles: titles,
      cap: 1,
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("collision");
    // The dropped p2 line stood for six annotations, and the recipient's own
    // hypothesis inside the kept collision is not news to count.
    expect(droppedCount).toBe(6);
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

/* -------------------------------------------------------------------------
 * Cross-paper collisions (Phase 2)
 * ---------------------------------------------------------------------- */

/** A claim long enough to stand on its own without a paper for context. */
const CLAIM =
  "the residual connection is what makes a very deep network trainable at all";

describe("crossPaperOverlap", () => {
  it("matches the same claim quoted in two different papers", () => {
    const a = ann({ memberId: "ana", type: "hypothesis", paperId: "p1", quote: CLAIM });
    const b = ann({ memberId: "ben", type: "critique", paperId: "p2", quote: CLAIM });
    expect(crossPaperOverlap(a, b)).toBe("quote");
  });

  it("leaves the same paper to anchorOverlap", () => {
    const a = ann({ memberId: "ana", type: "hypothesis", quote: CLAIM });
    const b = ann({ memberId: "ben", type: "critique", quote: CLAIM });
    expect(crossPaperOverlap(a, b)).toBeNull();
    expect(anchorOverlap(a, b)).toBe("range");
  });

  it("holds a cross-paper match to a much longer floor than a within-paper one", () => {
    // Clears the 20-character within-paper fallback and still refuses to link
    // two papers: without a shared document, a clause is not evidence.
    const short = "attention is all you need, really";
    expect(short.length).toBeGreaterThanOrEqual(20);
    expect(short.length).toBeLessThan(MIN_CROSS_PAPER_QUOTE_CHARS);
    const a = ann({
      memberId: "ana",
      type: "hypothesis",
      paperId: "p1",
      pageIndex: 2,
      quote: short,
    });
    const b = ann({
      memberId: "ben",
      type: "critique",
      paperId: "p2",
      pageIndex: 5,
      quote: short,
    });
    expect(crossPaperOverlap(a, b)).toBeNull();
    // The very same selection links two pages *inside* one paper.
    expect(anchorOverlap({ ...a, paperId: "p2" }, b)).toBe("quote");
  });

  it("sees through typesetting: case, whitespace and edge punctuation", () => {
    const a = ann({
      memberId: "ana",
      type: "hypothesis",
      paperId: "p1",
      quote: `  “${CLAIM.replace(" is ", "  is  ")}.”  `,
    });
    const b = ann({
      memberId: "ben",
      type: "critique",
      paperId: "p2",
      quote: CLAIM.toUpperCase(),
    });
    expect(crossPaperOverlap(a, b)).toBe("quote");
  });

  it("does not match two different sentences", () => {
    const a = ann({ memberId: "ana", type: "hypothesis", paperId: "p1", quote: CLAIM });
    const b = ann({
      memberId: "ben",
      type: "critique",
      paperId: "p2",
      quote: CLAIM.replace("residual", "recurrent"),
    });
    expect(crossPaperOverlap(a, b)).toBeNull();
  });
});

describe("detectCrossPaperCollisions", () => {
  it("pairs a gold cell across two papers, oldest half first", () => {
    const older = ann({
      memberId: "ana",
      type: "hypothesis",
      paperId: "p1",
      quote: CLAIM,
      createdAt: 10,
    });
    const newer = ann({
      memberId: "ben",
      type: "critique",
      paperId: "p2",
      quote: CLAIM,
      createdAt: 20,
    });
    const { collisions, capped } = detectCrossPaperCollisions([newer, older]);
    expect(capped).toBe(false);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.a.id).toBe(older.id);
    expect(collisions[0]?.label).toBe("contradiction");
    expect(collisions[0]?.pairType).toBe("critique x hypothesis");
    expect(collisions[0]?.overlap).toBe("quote");
  });

  it("ignores non-gold pairs across papers", () => {
    const { collisions } = detectCrossPaperCollisions([
      ann({ memberId: "ana", type: "note", paperId: "p1", quote: CLAIM }),
      ann({ memberId: "ben", type: "hypothesis", paperId: "p2", quote: CLAIM }),
    ]);
    expect(collisions).toHaveLength(0);
  });

  it("never pairs a member with themselves across their own reading", () => {
    const { collisions } = detectCrossPaperCollisions([
      ann({ memberId: "ana", type: "hypothesis", paperId: "p1", quote: CLAIM }),
      ann({ memberId: "ana", type: "critique", paperId: "p2", quote: CLAIM }),
    ]);
    expect(collisions).toHaveLength(0);
  });

  it("spends nothing on a group that never leaves one paper", () => {
    const { collisions, comparisons } = detectCrossPaperCollisions([
      ann({ memberId: "ana", type: "hypothesis", paperId: "p1", quote: CLAIM }),
      ann({ memberId: "ben", type: "critique", paperId: "p1", quote: CLAIM }),
    ]);
    expect(collisions).toHaveLength(0);
    expect(comparisons).toBe(0);
  });

  it("leaves same-paper pairs inside a mixed group to detectCollisions", () => {
    const pool = [
      ann({ memberId: "ana", type: "hypothesis", paperId: "p1", quote: CLAIM }),
      ann({ memberId: "ben", type: "critique", paperId: "p1", quote: CLAIM }),
      ann({ memberId: "cara", type: "critique", paperId: "p2", quote: CLAIM }),
    ];
    const { collisions, comparisons } = detectCrossPaperCollisions(pool);
    // All three pairs were looked at — the accounting does not hide the one it
    // declined — but only the one that spans papers is this detector's.
    expect(comparisons).toBe(3);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.a.paperId).not.toBe(collisions[0]?.b.paperId);
    // And the same-paper half is still found by the detector that owns it.
    expect(detectCollisions(pool)).toHaveLength(1);
  });

  it("is deterministic — the pool's order changes nothing", () => {
    const pool = [
      ann({ memberId: "ana", type: "hypothesis", paperId: "p1", quote: CLAIM, createdAt: 40 }),
      ann({ memberId: "ben", type: "critique", paperId: "p2", quote: CLAIM, createdAt: 30 }),
      ann({ memberId: "cara", type: "method-note", paperId: "p3", quote: CLAIM, createdAt: 20 }),
    ];
    const forward = detectCrossPaperCollisions(pool);
    const backward = detectCrossPaperCollisions([...pool].reverse());
    expect(forward).toEqual(backward);
    expect(forward.collisions.map((c) => c.label)).toEqual([
      "contradiction",
      "method available",
    ]);
  });

  it("caps the scan and says so, instead of returning a short answer quietly", () => {
    const pool = [
      ann({ memberId: "ana", type: "hypothesis", paperId: "p1", quote: CLAIM, createdAt: 40 }),
      ann({ memberId: "ben", type: "critique", paperId: "p2", quote: CLAIM, createdAt: 30 }),
      ann({ memberId: "cara", type: "method-note", paperId: "p3", quote: CLAIM, createdAt: 20 }),
      ann({ memberId: "dee", type: "definition", paperId: "p4", quote: CLAIM, createdAt: 10 }),
    ];
    const full = detectCrossPaperCollisions(pool);
    expect(full.capped).toBe(false);
    expect(full.comparisons).toBe(6);

    const partial = detectCrossPaperCollisions(pool, 3);
    expect(partial.capped).toBe(true);
    expect(partial.comparisons).toBe(3);
    // The cap cuts the oldest candidates, so a capped scan keeps the freshest
    // pairs — and keeps the same ones however the pool arrived.
    expect(partial.collisions.map((c) => c.label)).toEqual([
      "contradiction",
      "method available",
    ]);
    expect(detectCrossPaperCollisions([...pool].reverse(), 3)).toEqual(partial);
  });
});

describe("assembleDigest across papers", () => {
  /** Ana hypothesised in p1; Ben critiqued the same claim over in p2. */
  const spanning = () => {
    const mine = ann({
      id: "ana-hypothesis",
      memberId: "ana",
      type: "hypothesis",
      paperId: "p1",
      pageIndex: 2,
      quote: CLAIM,
      createdAt: 10,
    });
    const theirs = ann({
      id: "ben-critique",
      memberId: "ben",
      type: "critique",
      paperId: "p2",
      pageIndex: 6,
      quote: CLAIM,
      createdAt: 20,
    });
    return { mine, theirs, pool: [mine, theirs] };
  };

  it("pairs nothing across papers unless asked to", () => {
    const { theirs, pool } = spanning();
    const { items, crossPaperCapped } = assembleDigest({
      recipientId: "ana",
      pool,
      delta: [theirs],
      paperTitles: titles,
    });
    expect(crossPaperCapped).toBe(false);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("coalesced");
    expect(items[0]?.otherPaperId).toBeUndefined();
  });

  it("promotes a cross-paper pair and names both papers in the line", () => {
    const { mine, theirs, pool } = spanning();
    const { items } = assembleDigest({
      recipientId: "ana",
      pool,
      delta: [theirs],
      paperTitles: titles,
      crossPaper: detectCrossPaperCollisions(pool),
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("collision");
    expect(items[0]?.pairType).toBe("critique x hypothesis");
    expect(items[0]?.annotationIds).toEqual([mine.id, theirs.id]);
    // Filed under the recipient's own paper; the far side is named separately
    // so a reader never has to parse the sentence to tell the two apart.
    expect(items[0]?.paperId).toBe("p1");
    expect(items[0]?.otherPaperId).toBe("p2");
    expect(items[0]?.line).toBe(
      "Ben critiqued the passage you hypothesised about — across Attention Is All You Need, p. 3 and Deep Residual Learning, p. 7: “" +
        CLAIM +
        "”",
    );
  });

  it("cites the recipient's own paper first, whichever half they wrote", () => {
    const { mine, pool } = spanning();
    const { items } = assembleDigest({
      recipientId: "ben",
      pool,
      delta: [mine],
      paperTitles: titles,
      crossPaper: detectCrossPaperCollisions(pool),
    });
    expect(items[0]?.paperId).toBe("p2");
    expect(items[0]?.otherPaperId).toBe("p1");
    expect(items[0]?.line).toBe(
      "You critiqued the passage Ana hypothesised about — across Deep Residual Learning, p. 7 and Attention Is All You Need, p. 3: “" +
        CLAIM +
        "”",
    );
  });

  it("is still recipient-relative — a cross-paper pair between two others coalesces", () => {
    const { pool } = spanning();
    const { items } = assembleDigest({
      recipientId: "cara",
      pool,
      delta: pool,
      paperTitles: titles,
      crossPaper: detectCrossPaperCollisions(pool),
    });
    expect(detectCrossPaperCollisions(pool).collisions).toHaveLength(1);
    expect(items.every((item) => item.kind === "coalesced")).toBe(true);
    expect(items.map((item) => item.paperId).sort()).toEqual(["p1", "p2"]);
  });

  it("ranks a cross-paper pair below a same-paper one of equal recency", () => {
    const mine = ann({ id: "mine", memberId: "ana", type: "hypothesis", quote: CLAIM, createdAt: 1 });
    const sameP = ann({
      id: "same-paper",
      memberId: "ben",
      type: "critique",
      quote: "a different sentence in the same margin",
      createdAt: 100,
    });
    const crossP = ann({
      id: "cross-paper",
      memberId: "cara",
      type: "critique",
      paperId: "p2",
      quote: CLAIM,
      createdAt: 100,
    });
    const pool = [mine, sameP, crossP];
    const { items } = assembleDigest({
      recipientId: "ana",
      pool,
      delta: [sameP, crossP],
      paperTitles: titles,
      crossPaper: detectCrossPaperCollisions(pool),
      cap: 1,
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.annotationIds).toEqual([mine.id, sameP.id]);
    expect(items[0]?.otherPaperId).toBeUndefined();
  });

  it("keeps a same-paper pair ahead even when the cross-paper one is newer", () => {
    // Scope outranks recency: a tighter fact is not displaced by a fresher
    // guess. Both pairs still exist; only the budget is contested.
    const mine = ann({ id: "mine2", memberId: "ana", type: "hypothesis", quote: CLAIM, createdAt: 1 });
    const sameP = ann({
      id: "same-paper2",
      memberId: "ben",
      type: "critique",
      quote: "a different sentence in the same margin",
      createdAt: 100,
    });
    const crossP = ann({
      id: "cross-paper2",
      memberId: "cara",
      type: "critique",
      paperId: "p2",
      quote: CLAIM,
      createdAt: 9000,
    });
    const pool = [mine, sameP, crossP];
    const { items } = assembleDigest({
      recipientId: "ana",
      pool,
      delta: [sameP, crossP],
      paperTitles: titles,
      crossPaper: detectCrossPaperCollisions(pool),
    });
    const gold = items.filter((item) => item.kind === "collision");
    expect(gold).toHaveLength(2);
    expect(gold[0]?.annotationIds).toEqual([mine.id, sameP.id]);
    expect(gold[1]?.otherPaperId).toBe("p2");
  });

  it("still gives each new annotation at most one gold line, across both detectors", () => {
    // Ben's critique collides with Ana's hypothesis on the same passage *and*
    // with the same claim she flagged over in p2. One line, and it is the
    // tighter one.
    const here = ann({ id: "ana-here", memberId: "ana", type: "hypothesis", quote: CLAIM, createdAt: 1 });
    const there = ann({
      id: "ana-there",
      memberId: "ana",
      type: "hypothesis",
      paperId: "p2",
      quote: CLAIM,
      createdAt: 5,
    });
    const bens = ann({ id: "ben-critique2", memberId: "ben", type: "critique", quote: CLAIM, createdAt: 100 });
    const pool = [here, there, bens];
    const crossPaper = detectCrossPaperCollisions(pool);
    expect(crossPaper.collisions).toHaveLength(1);
    const { items } = assembleDigest({
      recipientId: "ana",
      pool,
      delta: [bens],
      paperTitles: titles,
      crossPaper,
    });
    const gold = items.filter((item) => item.kind === "collision");
    expect(gold).toHaveLength(1);
    expect(gold[0]?.otherPaperId).toBeUndefined();
    expect(gold[0]?.annotationIds).toEqual([here.id, bens.id]);
  });

  it("carries a capped scan through to the assembled digest", () => {
    const { theirs, pool } = spanning();
    const { crossPaperCapped } = assembleDigest({
      recipientId: "ana",
      pool,
      delta: [theirs],
      paperTitles: titles,
      crossPaper: { ...detectCrossPaperCollisions(pool), capped: true },
    });
    expect(crossPaperCapped).toBe(true);
  });
});
