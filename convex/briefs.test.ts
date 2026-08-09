import { describe, expect, it } from "vitest";
import type { Doc, Id } from "./_generated/dataModel";
import { redactWithdrawn } from "./briefs";
import { WITHDRAWN_ITEM_TEXT } from "./synthesis";

/**
 * What a stored brief is still allowed to say.
 *
 * The assembly itself is tested in `lib/brief/` — it is pure and knows nothing
 * about a database. This covers the other half, which is the half that has a
 * privacy consequence: a brief row is a snapshot of a margin that keeps moving,
 * and every line of it was built out of notes that their authors can withdraw
 * or flip back to private at any point afterwards.
 *
 * The case worth writing down is a collision. Its text names two members and
 * quotes both, so a rule that only redacts when *every* citation has gone would
 * keep serving a withdrawn member's name and passage for as long as the other
 * member's note survived — which is a way around `visibility: "private"` that
 * looks, on the page, exactly like a line that is fine.
 */

const note = (n: number) => `annotation_${n}` as Id<"annotations">;

type Section = Doc<"briefs">["sections"][number];

/** A collision line: two members, two citations, one sentence built from both. */
const collision = (): Section => ({
  key: "collisions",
  heading: "Where the lab disagrees",
  droppedCount: 0,
  items: [
    {
      text: "Ana Ruiz defined a term on the passage Ben Okafor left an open question on",
      annotationIds: [note(1), note(2)],
      pairType: "possible answer",
    },
  ],
});

/** An ordinary one-note line, for contrast. */
const single = (): Section => ({
  key: "open-questions",
  heading: "Open questions",
  droppedCount: 0,
  items: [
    {
      text: "Ben Okafor, p. 4: “what fixes the temperature here?”",
      annotationIds: [note(3)],
    },
  ],
});

const shared = (...ids: Id<"annotations">[]) => new Set(ids);

describe("redactWithdrawn", () => {
  it("leaves a line alone while every note behind it is still shared", () => {
    const [section] = redactWithdrawn([collision()], shared(note(1), note(2)));
    expect(section?.items[0]?.text).toBe(collision().items[0]?.text);
  });

  it("redacts a two-note collision when one of the two is withdrawn", () => {
    const [section] = redactWithdrawn([collision()], shared(note(1)));
    expect(section?.items[0]?.text).toBe(WITHDRAWN_ITEM_TEXT);
  });

  it("redacts whichever half of a collision goes, not a favoured one", () => {
    const [section] = redactWithdrawn([collision()], shared(note(2)));
    expect(section?.items[0]?.text).toBe(WITHDRAWN_ITEM_TEXT);
  });

  it("names neither member once a collision has been redacted", () => {
    const [section] = redactWithdrawn([collision()], shared(note(1)));
    const text = section?.items[0]?.text ?? "";
    expect(text).not.toContain("Ana Ruiz");
    expect(text).not.toContain("Ben Okafor");
  });

  it("redacts when both notes behind a collision have gone", () => {
    const [section] = redactWithdrawn([collision()], shared());
    expect(section?.items[0]?.text).toBe(WITHDRAWN_ITEM_TEXT);
  });

  it("redacts a one-note line when its note has gone", () => {
    const [section] = redactWithdrawn([single()], shared());
    expect(section?.items[0]?.text).toBe(WITHDRAWN_ITEM_TEXT);
  });

  it("keeps the citations on a redacted line, so it can still be counted", () => {
    const [section] = redactWithdrawn([collision()], shared(note(1)));
    expect(section?.items[0]?.annotationIds).toEqual([note(1), note(2)]);
  });

  it("keeps the rest of the item, so the line still reads as a collision", () => {
    const [section] = redactWithdrawn([collision()], shared(note(1)));
    expect(section?.items[0]?.pairType).toBe("possible answer");
  });

  it("redacts one line without touching its neighbours", () => {
    const sections = redactWithdrawn(
      [collision(), single()],
      shared(note(1), note(3)),
    );
    expect(sections[0]?.items[0]?.text).toBe(WITHDRAWN_ITEM_TEXT);
    expect(sections[1]?.items[0]?.text).toBe(single().items[0]?.text);
  });

  it("keeps the section's own fields, so nothing is dropped silently", () => {
    const [section] = redactWithdrawn([collision()], shared(note(1)));
    expect(section?.key).toBe("collisions");
    expect(section?.heading).toBe("Where the lab disagrees");
    expect(section?.droppedCount).toBe(0);
    expect(section?.items).toHaveLength(1);
  });

  it("does not mutate the row it was handed", () => {
    const sections = [collision()];
    redactWithdrawn(sections, shared());
    expect(sections[0]?.items[0]?.text).toBe(collision().items[0]?.text);
  });
});
