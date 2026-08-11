import { describe, expect, it } from "vitest";
import { allCitationsShared, redactWhenAnyWithdrawn } from "./redaction";

const REDACTED = "A line here rested on notes that are no longer shared.";
type Item = { text: string; ids: string[] };
const apply = (items: Item[], shared: Set<string>) =>
  redactWhenAnyWithdrawn(
    items,
    shared,
    (item: Item) => item.ids,
    (item: Item) => ({ ...item, text: REDACTED }),
  );

describe("allCitationsShared", () => {
  it("is all-or-nothing", () => {
    expect(allCitationsShared(["a", "b"], new Set(["a", "b"]))).toBe(true);
    expect(allCitationsShared(["a", "b"], new Set(["a"]))).toBe(false);
  });

  it("is true for an item that cites nothing, which callers must not have", () => {
    // Vacuous by construction. Both callers forbid empty citations upstream;
    // this documents that the predicate itself has no opinion about it.
    expect(allCitationsShared([], new Set())).toBe(true);
  });
});

describe("redactWhenAnyWithdrawn", () => {
  it("replaces the text when one of several citations has gone", () => {
    // The rule synthesis is deliberately laxer than: an item drawn from A and
    // B still carries A's substance in its sentence after A is withdrawn.
    const { items, redactedCount } = apply(
      [{ text: "Both notes point at the incubation step.", ids: ["a", "b"] }],
      new Set(["b"]),
    );
    expect(items[0]?.text).toBe(REDACTED);
    expect(redactedCount).toBe(1);
  });

  it("leaves an item whose every citation survives, and keeps the ids", () => {
    const { items, redactedCount } = apply(
      [{ text: "Still true.", ids: ["a"] }],
      new Set(["a"]),
    );
    expect(items[0]).toEqual({ text: "Still true.", ids: ["a"] });
    expect(redactedCount).toBe(0);
  });

  it("keeps the citations on a redacted item, so a client reaches the same verdict", () => {
    const { items } = apply([{ text: "Gone.", ids: ["a"] }], new Set());
    expect(items[0]?.ids).toEqual(["a"]);
  });
});
