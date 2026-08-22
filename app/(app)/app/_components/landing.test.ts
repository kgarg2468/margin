import { describe, expect, it } from "vitest";
import { landOnShelf } from "./landing";

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
