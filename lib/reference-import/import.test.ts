import { describe, expect, it } from "vitest";
import { importReferences } from "./import";
import type { ReferenceEntry } from "./types";

const entries: ReferenceEntry[] = [
  { title: "DOI paper", authors: [], doi: "10.1/one" },
  { title: "Metadata paper", authors: ["Ada Lovelace"] },
  { title: "Duplicate", authors: [], doi: "10.1/duplicate" },
  { title: "Failure", authors: [] },
];

describe("importReferences", () => {
  it("routes DOI and metadata entries and reports each outcome independently", async () => {
    const updates: Array<[number, string]> = [];
    const failure = new Error("mutation failed");
    const outcomes = await importReferences({
      entries,
      selected: [0, 1, 2, 3],
      createFromDoi: async (entry) => ({
        paperId: `doi:${entry.doi}`,
        alreadyInLibrary: entry.doi === "10.1/duplicate",
      }),
      createFromMetadata: async (entry) => {
        if (entry.title === "Failure") {
          throw failure;
        }
        return { paperId: `metadata:${entry.title}` };
      },
      onOutcome: (index, outcome) => updates.push([index, outcome.status]),
    });

    expect(outcomes).toEqual(
      new Map([
        [0, { status: "added", paperId: "doi:10.1/one" }],
        [1, { status: "added", paperId: "metadata:Metadata paper" }],
        [
          2,
          { status: "duplicate", paperId: "doi:10.1/duplicate" },
        ],
        [3, { status: "failed", error: failure }],
      ]),
    );
    expect(updates).toHaveLength(4);
  });

  it("imports only selected entries", async () => {
    const imported: string[] = [];
    const outcomes = await importReferences({
      entries,
      selected: [1],
      createFromDoi: async () => {
        throw new Error("not expected");
      },
      createFromMetadata: async (entry) => {
        imported.push(entry.title);
        return { paperId: "paper:one" };
      },
    });

    expect(imported).toEqual(["Metadata paper"]);
    expect([...outcomes.keys()]).toEqual([1]);
  });

  it("limits simultaneous imports", async () => {
    const many = Array.from({ length: 8 }, (_, index) => ({
      title: `Paper ${index}`,
      authors: [],
    }));
    let active = 0;
    let peak = 0;

    await importReferences({
      entries: many,
      selected: many.map((_, index) => index),
      concurrency: 3,
      createFromDoi: async () => {
        throw new Error("not expected");
      },
      createFromMetadata: async (entry) => {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
        return { paperId: entry.title };
      },
    });

    expect(peak).toBe(3);
  });
});
