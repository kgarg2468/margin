import { describe, expect, it } from "vitest";
import {
  indexByLabel,
  issueLabels,
  labelAt,
  normalizeLabel,
  scanLabels,
} from "./labels";

describe("issueLabels", () => {
  it("numbers material from A1 in the order it is laid out", () => {
    const labelled = issueLabels([{ _id: "a" }, { _id: "b" }]);
    expect(labelled.map((one) => one.label)).toEqual(["A1", "A2"]);
    expect(labelled[0]?._id).toBe("a");
  });

  it("indexes back by label, so a citation resolves to the row it named", () => {
    const byLabel = indexByLabel(issueLabels([{ _id: "a" }, { _id: "b" }]));
    expect(byLabel.get("A2")?._id).toBe("b");
    expect(byLabel.get("A3")).toBeUndefined();
  });

  it("is 1-based, because the prompt says [A1] and never [A0]", () => {
    expect(labelAt(0)).toBe("A1");
  });
});

describe("normalizeLabel", () => {
  it("accepts the shapes a model writes for one ref", () => {
    expect(normalizeLabel("[A12]")).toBe("A12");
    expect(normalizeLabel(" a12 ")).toBe("A12");
    expect(normalizeLabel("A007")).toBe("A7");
  });

  it("rejects a ref field that is a sentence", () => {
    // A `refs` entry is a claim about one label. "A1 and also A2" is not one
    // label, and reading a label out of it would be inventing the model's
    // meaning rather than checking it.
    expect(normalizeLabel("A1 and also A2")).toBeUndefined();
    expect(normalizeLabel(7)).toBeUndefined();
    expect(normalizeLabel(null)).toBeUndefined();
  });
});

describe("scanLabels", () => {
  it("finds labels in prose and in a list, bracketed or bare", () => {
    expect(scanLabels("The lab said this [A3], and also A11.")).toEqual([
      "A3",
      "A11",
    ]);
    expect(scanLabels(["A1", "[A2]"])).toEqual(["A1", "A2"]);
  });

  it("returns nothing for anything that is not text or a list of it", () => {
    expect(scanLabels({ a: 1 })).toEqual([]);
    expect(scanLabels(undefined)).toEqual([]);
  });

  it("does not read a label out of a longer word", () => {
    expect(scanLabels("DNA12 is not a citation")).toEqual([]);
  });
});
