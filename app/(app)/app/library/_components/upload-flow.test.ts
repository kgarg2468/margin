import { describe, expect, it } from "vitest";
import {
  bytesProgress,
  cancelOffer,
  formatBytes,
  isCancellation,
  percentSent,
  stageAnnouncement,
  stageProgress,
} from "./upload-flow";

const MB = 1024 * 1024;

describe("formatBytes", () => {
  it("counts bytes under a kilobyte", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
  });
  it("counts whole kilobytes under a megabyte", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(862_208)).toBe("842 KB");
  });
  it("counts megabytes to one decimal, because papers are megabytes", () => {
    expect(formatBytes(11.4 * MB)).toBe("11.4 MB");
    expect(formatBytes(3.24 * MB)).toBe("3.2 MB");
  });
});

describe("bytesProgress", () => {
  it("reads as a distance travelled", () => {
    expect(bytesProgress(3.2 * MB, 11.4 * MB)).toBe("3.2 MB of 11.4 MB");
  });
  it("says what it can when the total is not known", () => {
    // `lengthComputable === false`, and a browser that also withheld the size.
    // The decimal stays even on a whole megabyte: the readout is tabular and
    // climbing, and a width that changes at 2 MB is a line that jumps.
    expect(bytesProgress(2 * MB, 0)).toBe("2.0 MB sent");
  });
  it("does not divide by an empty file", () => {
    expect(bytesProgress(0, 0)).toBe("0 B sent");
    expect(percentSent(0, 0)).toBeNull();
  });
});

describe("percentSent", () => {
  it("rounds to whole percent", () => {
    expect(percentSent(MB, 4 * MB)).toBe(25);
    expect(percentSent(1, 3)).toBe(33);
  });
  it("never reports past the end", () => {
    expect(percentSent(5 * MB, 4 * MB)).toBe(100);
  });
});

describe("isCancellation", () => {
  it("recognises the platform's own withdrawal", () => {
    expect(isCancellation({ name: "AbortError" })).toBe(true);
    expect(isCancellation(new DOMException("gone", "AbortError"))).toBe(true);
  });
  it("does not swallow a real failure", () => {
    expect(isCancellation(new Error("Upload failed with status 500."))).toBe(false);
    expect(isCancellation(null)).toBe(false);
    expect(isCancellation("AbortError")).toBe(false);
  });
});

describe("cancelOffer", () => {
  it("offers a real abort while bytes or pages are moving", () => {
    expect(cancelOffer({ kind: "reading", pagesDone: 4, pageCount: 340 })).toEqual({
      kind: "abort",
      label: "Stop reading it",
    });
    expect(cancelOffer({ kind: "sending", loaded: 0, total: MB })).toEqual({
      kind: "abort",
      label: "Cancel the upload",
    });
  });
  it("offers an honest abandon where there is nothing left to abort", () => {
    // The mutation is one round trip and cannot be recalled; what can be given
    // back is the form and the truth about what may have landed.
    expect(cancelOffer({ kind: "filing" })).toEqual({
      kind: "abandon",
      label: "Stop waiting",
    });
  });
  it("offers nothing where nothing is happening", () => {
    expect(cancelOffer({ kind: "empty" })).toBeNull();
    expect(cancelOffer({ kind: "read" })).toBeNull();
  });
  it("leaves no waiting stage unabandonable", () => {
    for (const stage of [
      { kind: "reading", pagesDone: 0, pageCount: 0 },
      { kind: "sending", loaded: 0, total: 0 },
      { kind: "filing" },
    ] as const) {
      expect(cancelOffer(stage)).not.toBeNull();
    }
  });
});

describe("stageProgress", () => {
  it("counts pages before the file has opened, and after", () => {
    expect(stageProgress({ kind: "reading", pagesDone: 0, pageCount: 0 })).toBe(
      "Opening the PDF…",
    );
    expect(stageProgress({ kind: "reading", pagesDone: 4, pageCount: 12 })).toBe(
      "Reading page 4 of 12…",
    );
  });
  it("counts bytes while they move", () => {
    expect(stageProgress({ kind: "sending", loaded: 3.2 * MB, total: 11.4 * MB })).toBe(
      "3.2 MB of 11.4 MB",
    );
  });
  it("says what the last wait is for", () => {
    expect(stageProgress({ kind: "filing" })).toBe("Filing it…");
  });
  it("has nothing to say when nothing is in flight", () => {
    expect(stageProgress({ kind: "read" })).toBeNull();
    expect(stageProgress({ kind: "empty" })).toBeNull();
  });
});

describe("stageAnnouncement", () => {
  it("changes once per stage, not once per page or per chunk", () => {
    const reading = [
      stageAnnouncement({ kind: "reading", pagesDone: 1, pageCount: 340 }),
      stageAnnouncement({ kind: "reading", pagesDone: 339, pageCount: 340 }),
    ];
    expect(reading[0]).toBe(reading[1]);
    expect(reading[0]).toBe("Reading the PDF.");
    expect(stageAnnouncement({ kind: "sending", loaded: 1, total: 2 })).toBe(
      "Uploading the PDF.",
    );
    expect(stageAnnouncement({ kind: "filing" })).toBe("Adding the paper.");
    expect(stageAnnouncement({ kind: "read" })).toBe("");
  });
});
