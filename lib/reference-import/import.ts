import { referenceIdentity } from "./normalize";
import type { ReferenceEntry } from "./types";

export type ReferenceImportOutcome =
  | { status: "added"; paperId: string }
  | { status: "duplicate"; paperId: string }
  | { status: "failed"; error: unknown };

type ImportReferencesOptions = {
  entries: ReferenceEntry[];
  selected: number[];
  createFromDoi: (
    entry: ReferenceEntry,
  ) => Promise<{ paperId: string; alreadyInLibrary: boolean }>;
  createFromMetadata: (
    entry: ReferenceEntry,
  ) => Promise<{ paperId: string; alreadyInLibrary: boolean }>;
  onOutcome?: (index: number, outcome: ReferenceImportOutcome) => void;
  concurrency?: number;
};

/** Later DOI-less records with the same title and year point to the first. */
export function findWithinBatchDuplicates(
  entries: ReferenceEntry[],
  selected: Iterable<number>,
): Map<number, number> {
  const firstByIdentity = new Map<string, number>();
  const duplicates = new Map<number, number>();
  for (const index of selected) {
    const entry = entries[index];
    if (entry === undefined || entry.doi !== undefined) {
      continue;
    }
    const identity = referenceIdentity(entry.title, entry.year);
    const first = firstByIdentity.get(identity);
    if (first === undefined) {
      firstByIdentity.set(identity, index);
    } else {
      duplicates.set(index, first);
    }
  }
  return duplicates;
}

/** Import a selection without letting one bad record cancel its neighbours. */
export async function importReferences({
  entries,
  selected,
  createFromDoi,
  createFromMetadata,
  onOutcome,
  concurrency = 3,
}: ImportReferencesOptions): Promise<Map<number, ReferenceImportOutcome>> {
  const pending = selected.filter((index) => entries[index] !== undefined);
  const duplicates = findWithinBatchDuplicates(entries, pending);
  const queued = pending.filter((index) => !duplicates.has(index));
  const completed = new Map<number, ReferenceImportOutcome>();
  let cursor = 0;

  async function worker() {
    while (cursor < queued.length) {
      const index = queued[cursor];
      cursor++;
      if (index === undefined) {
        continue;
      }
      const entry = entries[index];
      if (entry === undefined) {
        continue;
      }

      let outcome: ReferenceImportOutcome;
      try {
        if (entry.doi !== undefined) {
          const result = await createFromDoi(entry);
          outcome = {
            status: result.alreadyInLibrary ? "duplicate" : "added",
            paperId: result.paperId,
          };
        } else {
          const result = await createFromMetadata(entry);
          outcome = {
            status: result.alreadyInLibrary ? "duplicate" : "added",
            paperId: result.paperId,
          };
        }
      } catch (error) {
        outcome = { status: "failed", error };
      }
      completed.set(index, outcome);
      onOutcome?.(index, outcome);
    }
  }

  const workerCount = Math.min(
    queued.length,
    Math.max(1, Math.floor(concurrency)),
  );
  await Promise.all(Array.from({ length: workerCount }, worker));

  for (const [index, firstIndex] of duplicates) {
    const firstOutcome = completed.get(firstIndex);
    if (firstOutcome === undefined) {
      continue;
    }
    const outcome: ReferenceImportOutcome =
      firstOutcome.status === "failed"
        ? firstOutcome
        : { status: "duplicate", paperId: firstOutcome.paperId };
    completed.set(index, outcome);
    onOutcome?.(index, outcome);
  }

  return new Map(
    pending.flatMap((index) => {
      const outcome = completed.get(index);
      return outcome === undefined ? [] : [[index, outcome] as const];
    }),
  );
}
