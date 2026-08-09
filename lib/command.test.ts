import { describe, expect, it } from "vitest";
import { fuzzyScore, rankCommands, shortcutLabel } from "./command";

describe("fuzzyScore", () => {
  it("matches subsequences", () => {
    expect(fuzzyScore("gtl", "Go to Library")).not.toBeNull();
  });
  it("rejects non-subsequences", () => {
    expect(fuzzyScore("xyz", "Go to Library")).toBeNull();
  });
  it("prefers word-start matches", () => {
    const wordStart = fuzzyScore("lib", "Go to Library")!;
    const scattered = fuzzyScore("oor", "Go to Library")!;
    expect(wordStart).toBeGreaterThan(scattered);
  });
  it("empty query matches everything at score 0", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });
});

describe("rankCommands", () => {
  it("orders by score and drops non-matches", () => {
    const items = [
      { label: "Go to Sessions" },
      { label: "Go to Library" },
      { label: "Sign out" },
    ];
    expect(rankCommands("lib", items).map((i) => i.label)).toEqual([
      "Go to Library",
    ]);
  });
  it("searches keywords too", () => {
    const items = [{ label: "Go to Library", keywords: ["papers"] }];
    expect(rankCommands("papers", items)).toHaveLength(1);
  });
});

describe("shortcutLabel", () => {
  it("uses the command glyph on Apple platforms", () => {
    expect(shortcutLabel("MacIntel")).toBe("⌘K");
    expect(shortcutLabel("iPhone")).toBe("⌘K");
    expect(shortcutLabel("macOS")).toBe("⌘K");
  });
  it("spells the modifier out everywhere else", () => {
    expect(shortcutLabel("Win32")).toBe("Ctrl K");
    expect(shortcutLabel("Linux x86_64")).toBe("Ctrl K");
    expect(shortcutLabel("")).toBe("Ctrl K");
  });
});
