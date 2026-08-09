import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The reader is the last place in the app still holding the pre-#61 press
 * grammar, and the reason it held on is that a duration and a scale in a class
 * string look like styling rather than like a decision. They are a decision:
 * 200ms is past the point where a press still reads as having registered, and
 * `active:scale-[0.96]` transitions `transform`, which the shared utility
 * deliberately leaves free so a card can translate itself while being pressed.
 *
 * A source check rather than a render check, because there is nothing to render
 * in a node test and nothing to assert about it if there were.
 */

const HERE = join(
  process.cwd(),
  "app/(app)/app/library/[paperId]/read/_components",
);

const PRESSABLE = [
  "reader.tsx",
  "type-chips.tsx",
  "reactions.tsx",
  "epistemic-status.tsx",
];

function source(file: string): string {
  return readFileSync(join(HERE, file), "utf8");
}

describe("the reader's pressable controls", () => {
  it.each(PRESSABLE)("%s uses the shared press grammar", (file) => {
    expect(source(file)).toContain("pressable");
  });

  it.each(PRESSABLE)("%s has no hand-rolled press left in it", (file) => {
    expect(source(file)).not.toContain("scale-[0.96]");
  });
});

describe("the whole reader", () => {
  it.each([...PRESSABLE, "annotation-card.tsx"])(
    "%s states no duration the motion budget does not name",
    (file) => {
      // --dur-press / --dur-hover / --dur-enter / --dur-exit, or the rail's
      // 300ms typesetting slide, which is a layout re-flow and not a press.
      expect(source(file)).not.toMatch(/duration-200\b/);
    },
  );
});
