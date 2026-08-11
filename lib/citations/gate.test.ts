import { describe, expect, it } from "vitest";
import { citedPaperIds, gateItems, resolveCitations } from "./gate";

const material = new Map([
  ["A1", { id: "ann_1", paperId: "pap_1" }],
  ["A2", { id: "ann_2", paperId: "pap_1" }],
  ["A3", { id: "ann_3", paperId: "pap_2" }],
]);
const resolve = (label: string) => material.get(label);
const limits = { maxItems: 6, maxChars: 600 };

describe("resolveCitations", () => {
  it("resolves what it can and reports that it saw a label nobody issued", () => {
    const { resolved, sawUnknown } = resolveCitations(["A1", "A9"], resolve);
    expect(resolved.map((one) => one.id)).toEqual(["ann_1"]);
    expect(sawUnknown).toBe(true);
  });

  it("keeps one row once, however many times it is cited", () => {
    const { resolved, sawUnknown } = resolveCitations(["A1", "A1"], resolve);
    expect(resolved).toHaveLength(1);
    expect(sawUnknown).toBe(false);
  });

  it("keeps one row once when two labels name it, if told what one row is", () => {
    // Identity is the default because labels are normally one-to-one with
    // rows. A caller that unions two questions' material can hand the same
    // note two labels, and storing it twice would double it in every count
    // the reader is shown — so `keyOf` is what "the same row" means.
    const twice = new Map([
      ["A1", { id: "ann_1", paperId: "pap_1" }],
      ["A2", { id: "ann_1", paperId: "pap_1" }],
    ]);
    const { resolved } = resolveCitations(
      ["A1", "A2"],
      (label) => twice.get(label),
      (one) => one.id,
    );
    expect(resolved.map((one) => one.id)).toEqual(["ann_1"]);
  });
});

describe("citedPaperIds", () => {
  it("derives papers from the citations, deduped, in first-cited order", () => {
    expect(
      citedPaperIds([
        { paperId: "pap_2" },
        { paperId: "pap_1" },
        { paperId: "pap_2" },
      ]),
    ).toEqual(["pap_2", "pap_1"]);
  });
});

describe("gateItems", () => {
  it("keeps an item that cites real labels, and derives its papers", () => {
    const gated = gateItems(
      [{ text: "The lab wrote about this [A1].", citations: ["A1"] }],
      resolve,
      limits,
    );
    expect(gated?.items).toEqual([
      {
        text: "The lab wrote about this [A1].",
        citedAnnotationIds: ["ann_1"],
        citedPaperIds: ["pap_1"],
      },
    ]);
    expect(gated?.droppedForCitation).toBe(0);
  });

  it("reads citations out of the list and out of the sentence", () => {
    // An item whose stored citations omit a label its prose rests on is an
    // item that label's withdrawal cannot redact.
    const gated = gateItems(
      [{ text: "[A2] extends [A1].", citations: ["A1"] }],
      resolve,
      limits,
    );
    expect(gated?.items[0]?.citedAnnotationIds).toEqual(["ann_1", "ann_2"]);
  });

  it("drops the whole item when it cites a label nobody issued", () => {
    const gated = gateItems(
      [{ text: "As shown [A9].", citations: ["A9"] }],
      resolve,
      limits,
    );
    expect(gated?.items).toEqual([]);
    expect(gated?.droppedForCitation).toBe(1);
  });

  it("drops an item whose labels are only partly real", () => {
    // The rule §3.8 actually asks for, and the one the case above cannot
    // pin: this item resolves A1, so a gate that only checked "cited
    // something real" would store it — half-grounded, with no way for a
    // scientist to tell which half. Fail closed on the whole item.
    const gated = gateItems(
      [{ text: "Grounded and not [A1].", citations: ["A1", "A9"] }],
      resolve,
      limits,
    );
    expect(gated?.items).toEqual([]);
    expect(gated?.droppedForCitation).toBe(1);
  });

  it("drops an item that cites nothing, and one with no text", () => {
    const gated = gateItems(
      [
        { text: "A claim with no source.", citations: [] },
        { text: "   ", citations: ["A1"] },
        { text: "Kept [A3].", citations: ["A3"] },
      ],
      resolve,
      limits,
    );
    expect(gated?.items.map((one) => one.text)).toEqual(["Kept [A3]."]);
    expect(gated?.droppedForCitation).toBe(2);
  });

  it("counts a non-object entry as a drop rather than ignoring it", () => {
    const gated = gateItems(["nonsense"], resolve, limits);
    expect(gated?.droppedForCitation).toBe(1);
  });

  it("caps the item count and the text length", () => {
    const many = Array.from({ length: 9 }, () => ({
      text: "x".repeat(700),
      citations: ["A1"],
    }));
    const gated = gateItems(many, resolve, limits);
    expect(gated?.items).toHaveLength(6);
    expect(gated?.items[0]?.text).toHaveLength(600);
  });

  it("returns null — not an empty gate — for output that is not a list", () => {
    // The caller turns this into a loud refusal. A gate that answered "no
    // items" to unreadable output would be indistinguishable from a model
    // that had nothing to say.
    expect(gateItems({ items: [] }, resolve, limits)).toBeNull();
    expect(gateItems(undefined, resolve, limits)).toBeNull();
  });
});
