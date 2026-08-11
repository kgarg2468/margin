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

describe("importReferences, called off part-way", () => {
  const many: ReferenceEntry[] = Array.from({ length: 20 }, (_, index) => ({
    title: `Paper ${index}`,
    authors: [],
    doi: `10.1/p${index}`,
  }));

  it("stops issuing round trips and keeps what already landed", async () => {
    let calls = 0;
    let stop = false;
    const outcomes = await importReferences({
      entries: many,
      selected: many.map((_, index) => index),
      concurrency: 1,
      cancelled: () => stop,
      createFromDoi: async (entry) => {
        calls++;
        // Called off while the fourth is in the air: it is one round trip and
        // is not interruptible, so it still lands and is still reported.
        if (calls === 4) {
          stop = true;
        }
        return { paperId: `doi:${entry.doi}`, alreadyInLibrary: false };
      },
      createFromMetadata: async () => {
        throw new Error("no metadata entry in this batch");
      },
    });

    expect(calls).toBe(4);
    expect(outcomes.size).toBe(4);
    expect(outcomes.get(3)).toEqual({
      status: "added",
      paperId: "doi:10.1/p3",
    });
    // The rest were never sent, so they have no outcome rather than a failure.
    expect(outcomes.has(4)).toBe(false);
  });

  it("does nothing at all when it is called off before the first entry", async () => {
    let calls = 0;
    const outcomes = await importReferences({
      entries: many,
      selected: [0, 1, 2],
      cancelled: () => true,
      createFromDoi: async () => {
        calls++;
        return { paperId: "unreachable", alreadyInLibrary: false };
      },
      createFromMetadata: async () => {
        throw new Error("unreachable");
      },
    });

    expect(calls).toBe(0);
    expect(outcomes.size).toBe(0);
  });

  it("stays called off when a later run resets the flag it was called off with", async () => {
    // The panel's stop flag is shared between runs, so starting a second import
    // sets it back to false while the first one's workers are still looping.
    // The predicate the panel builds is the pair — the flag *or* a generation
    // that has moved past this run — and the second half is the one a new run
    // cannot take back. Composed here exactly as the panel composes it; what is
    // under test is that the queue asks again before each entry rather than
    // reading the answer once, which is what makes the second half bite at all.
    let stopped = false;
    let generation = 1;
    const mine = generation;

    let calls = 0;
    const outcomes = await importReferences({
      entries: many,
      selected: many.map((_, index) => index),
      concurrency: 1,
      cancelled: () => stopped || generation !== mine,
      createFromDoi: async (entry) => {
        calls++;
        if (calls === 3) {
          // Stop pressed, and then a second import started on top of it.
          stopped = true;
          stopped = false;
          generation += 1;
        }
        return { paperId: `doi:${entry.doi}`, alreadyInLibrary: false };
      },
      createFromMetadata: async () => {
        throw new Error("no metadata entry in this batch");
      },
    });

    expect(calls).toBe(3);
    expect(outcomes.size).toBe(3);
    expect(outcomes.has(3)).toBe(false);
  });

  it("runs the whole batch when nothing calls it off", async () => {
    const outcomes = await importReferences({
      entries: many,
      selected: many.map((_, index) => index),
      cancelled: () => false,
      createFromDoi: async (entry) => ({
        paperId: `doi:${entry.doi}`,
        alreadyInLibrary: false,
      }),
      createFromMetadata: async () => {
        throw new Error("no metadata entry in this batch");
      },
    });

    expect(outcomes.size).toBe(many.length);
  });
});

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
