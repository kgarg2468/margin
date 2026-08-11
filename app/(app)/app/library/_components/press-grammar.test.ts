import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The library was the last surface where a quiet control was inert under the
 * finger. Every button in it was drawn from the same inline string as the
 * prose links beside it — `text-accent underline-offset-4 hover:underline` —
 * so nothing in the row distinguished "this goes somewhere" from "this changes
 * the page you are on", and neither of them acknowledged a press.
 *
 * A source check rather than a render check, for the reason the reader's copy
 * of this file gives: there is nothing to render in a node test and nothing to
 * assert about it if there were.
 */

const LANE = join(process.cwd(), "app/(app)/app/library");

const PRESSABLE = [
  "page.tsx",
  "_components/add-paper.tsx",
  "_components/pdf-dropzone.tsx",
  "_components/pdf-panel.tsx",
];

function source(file: string): string {
  return readFileSync(join(LANE, file), "utf8");
}

describe("the library lane's controls", () => {
  // Either spelling counts, and they say the same thing: the utility by name,
  // or the `lib/ui` export that now carries it (asserted below). What neither
  // of them is, is the bare inline idiom this file was written to catch.
  it.each(PRESSABLE)("%s uses the shared press grammar", (file) => {
    expect(source(file)).toMatch(/pressable|linkButtonClass/);
  });

  it.each(PRESSABLE)("%s states no duration the motion budget doesn't name", (file) => {
    expect(source(file)).not.toMatch(/duration-200\b/);
  });

  it.each(PRESSABLE)("%s has no hand-rolled press left in it", (file) => {
    expect(source(file)).not.toContain("scale-[0.96]");
  });
});

describe("the quiet control vocabulary", () => {
  it("carries the press grammar in lib/ui, not at each call site", () => {
    // `ConfirmAction` had to write `linkButtonClass + pressable + tap-target`
    // out by hand because the export didn't offer it. The export offers it now.
    const ui = readFileSync(join(process.cwd(), "lib/ui.ts"), "utf8");
    const declaration = /export const linkButtonClass =([\s\S]*?);/.exec(ui);
    expect(declaration).not.toBeNull();
    expect(declaration?.[1]).toContain("pressable");
  });
});
