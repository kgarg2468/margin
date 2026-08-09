import { describe, expect, it } from "vitest";
import { importReferences } from "./import";
import type { ReferenceEntry } from "./types";

const entries: ReferenceEntry[] = [
  { title: "DOI paper", authors: [], doi: "10.1/one" },
  { title: "Metadata paper", authors: ["Ada Lovelace"] },
  { title: "Duplicate", authors: [], doi: "10.1/duplicate" },
  { title: "Failure", authors: [] },
  { title: "Metadata duplicate", authors: [] },
];

describe("importReferences", () => {
  it("routes DOI and metadata entries and reports each outcome independently", async () => {
    const updates: Array<[number, string]> = [];
    const failure = new Error("mutation failed");
    const outcomes = await importReferences({
      entries,
      selected: [0, 1, 2, 3, 4],
      createFromDoi: async (entry) => ({
        paperId: `doi:${entry.doi}`,
        alreadyInLibrary: entry.doi === "10.1/duplicate",
      }),
      createFromMetadata: async (entry) => {
        if (entry.title === "Failure") {
          throw failure;
        }
        return {
          paperId: `metadata:${entry.title}`,
          alreadyInLibrary: entry.title === "Metadata duplicate",
        };
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
        [
          4,
          {
            status: "duplicate",
            paperId: "metadata:Metadata duplicate",
          },
        ],
      ]),
    );
    expect(updates).toHaveLength(5);
  });

  it("skips repeated DOI-less identities within one batch", async () => {
    const imported: string[] = [];
    const repeated: ReferenceEntry[] = [
      { title: "Shared   Margins", authors: [], year: 2024 },
      { title: "shared\nmargins", authors: [], year: 2024 },
      { title: "Shared Margins", authors: [], year: 2023 },
    ];

    const outcomes = await importReferences({
      entries: repeated,
      selected: [0, 1, 2],
      createFromDoi: async () => {
        throw new Error("not expected");
      },
      createFromMetadata: async (entry) => {
        imported.push(`${entry.title}:${entry.year}`);
        return { paperId: `paper:${entry.year}`, alreadyInLibrary: false };
      },
    });

    expect(imported).toEqual([
      "Shared   Margins:2024",
      "Shared Margins:2023",
    ]);
    expect(outcomes).toEqual(
      new Map([
        [0, { status: "added", paperId: "paper:2024" }],
        [1, { status: "duplicate", paperId: "paper:2024" }],
        [2, { status: "added", paperId: "paper:2023" }],
      ]),
    );
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
        return { paperId: "paper:one", alreadyInLibrary: false };
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
        return { paperId: entry.title, alreadyInLibrary: false };
      },
    });

    expect(peak).toBe(3);
  });
});
