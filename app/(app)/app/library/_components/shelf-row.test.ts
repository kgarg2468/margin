import { describe, expect, it } from "vitest";
import { shelfRow } from "./shelf-row";

describe("shelfRow", () => {
  it("gives a readable paper two destinations and two links", () => {
    const row = shelfRow({ ingestStatus: "ready", hasPdf: true });
    expect(row.titleOpensReader).toBe(true);
    expect(row.record).toEqual({ label: "Open its record", tone: "quiet" });
  });

  it("never leaves two links pointing at the record", () => {
    // The regression this file exists to prevent: before #A3 the title and
    // the action below it both resolved to /app/library/{id} for every paper
    // that was not yet readable, which is every paper for its first seconds.
    for (const paper of [
      { ingestStatus: "pending", hasPdf: true },
      { ingestStatus: "extracting", hasPdf: true },
      { ingestStatus: "failed", hasPdf: true },
      { ingestStatus: "needs-pdf", hasPdf: false },
      { ingestStatus: "ready", hasPdf: false },
    ] as const) {
      const row = shelfRow(paper);
      expect(row.titleOpensReader).toBe(false);
      expect(row.record.tone).toBe("named");
    }
  });

  it("names the missing preparation rather than chipping it", () => {
    expect(shelfRow({ ingestStatus: "needs-pdf", hasPdf: false }).record.label).toBe(
      "This paper still needs its PDF →",
    );
    expect(shelfRow({ ingestStatus: "failed", hasPdf: true }).record.label).toBe(
      "Its text wouldn’t come out — see why →",
    );
    expect(shelfRow({ ingestStatus: "extracting", hasPdf: true }).record.label).toBe(
      "Finish preparing this paper →",
    );
  });

  it("treats a missing file as the gap to name, whatever the status says", () => {
    // `ready` with no PDF is reachable (the record can be created before the
    // file arrives) and "finish preparing" would not say which half is missing.
    expect(shelfRow({ ingestStatus: "ready", hasPdf: false }).record.label).toBe(
      "This paper still needs its PDF →",
    );
    expect(shelfRow({ ingestStatus: "failed", hasPdf: false }).record.label).toBe(
      "This paper still needs its PDF →",
    );
  });
});
