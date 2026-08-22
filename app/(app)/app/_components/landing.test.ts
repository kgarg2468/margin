import { describe, expect, it } from "vitest";
import type { ImportedPaper } from "./landing";
import { landOnShelf } from "./landing";

/** A paper `shares.importFromShare` handed back, in one of its three states. */
function imported(overrides: Partial<ImportedPaper> = {}): ImportedPaper {
  return { paperId: "p1", ready: true, hasPdf: true, ...overrides };
}

describe("where a solo library lands", () => {
  it("opens the add panel on the arrival that created the library", () => {
    expect(landOnShelf(true).destination).toBe("/app/library?add=1");
  });

  it("leaves it shut for somebody coming back", () => {
    expect(landOnShelf(false).destination).toBe("/app/library");
  });
});

describe("spending the just-created signal", () => {
  it("does not open the panel a second time on a later visit to /app", () => {
    // The reported sequence, and the reason this is not a formality: the
    // provider holding the signal lives in the layout and outlives this page.
    // A member who was just provisioned, closed the add panel, read something,
    // and then came back to `/app` without reloading used to meet a signal that
    // was still true — and watch the panel they dismissed reopen over a library
    // that by then had papers on it.
    const first = landOnShelf(true);
    expect(first.destination).toBe("/app/library?add=1");

    const second = landOnShelf(first.justCreatedAfter);
    expect(second.destination).toBe("/app/library");
  });

  it("is spent by the arrival that used it, not by the next one", () => {
    expect(landOnShelf(true).justCreatedAfter).toBe(false);
  });

  it("stays spent however many times somebody comes back", () => {
    let justCreated = true;
    const seen: string[] = [];
    for (let visit = 0; visit < 4; visit++) {
      const landing = landOnShelf(justCreated);
      seen.push(landing.destination);
      justCreated = landing.justCreatedAfter;
    }

    expect(seen).toEqual([
      "/app/library?add=1",
      "/app/library",
      "/app/library",
      "/app/library",
    ]);
  });
});

/**
 * P7's half: a reader who arrived on a share link came for one paper, and the
 * arrival has to end on it. The three destinations are three genuinely
 * different states of the thing that just landed, not three shades of one.
 */
describe("where a paper from a share link lands", () => {
  it("opens the reader when the file and its text both came across", () => {
    expect(landOnShelf(false, imported()).destination).toBe(
      "/app/library/p1/read",
    );
  });

  it("stops at the record when there is a file but no text layer yet", () => {
    // The reader for a paper with no extracted text is a document with dead
    // margins — nothing can anchor. The record is where extraction starts, so
    // it is where somebody who cannot annotate yet should be standing.
    expect(
      landOnShelf(false, imported({ ready: false })).destination,
    ).toBe("/app/library/p1");
  });

  it("lands on the shelf when the sharer kept the file back", () => {
    // Nothing to open. The paper is on the shelf, visibly wanting its PDF,
    // which is the state the add-paper flow already knows how to finish.
    expect(
      landOnShelf(false, imported({ ready: false, hasPdf: false })).destination,
    ).toBe("/app/library");
  });

  it("outranks the add panel on the arrival that made the library", () => {
    // Both are true of the same arrival — the account is new *and* it came in
    // holding a paper. Opening a form to add a paper over the paper they just
    // added would be answering a question they have already answered.
    const landing = landOnShelf(true, imported());
    expect(landing.destination).toBe("/app/library/p1/read");
    expect(landing.justCreatedAfter).toBe(false);
  });

  it("spends the just-created signal even though the panel never opened", () => {
    // Otherwise it is still standing on the next visit to `/app`, and the panel
    // springs open over a shelf that by then has the imported paper on it.
    const first = landOnShelf(true, imported());
    expect(landOnShelf(first.justCreatedAfter).destination).toBe(
      "/app/library",
    );
  });

  it("leaves an ordinary arrival exactly where it was", () => {
    // The parameter is optional and defaults to nothing imported, so every
    // caller that predates P7 keeps its answer.
    expect(landOnShelf(true, null).destination).toBe("/app/library?add=1");
    expect(landOnShelf(false, null).destination).toBe("/app/library");
  });
});
