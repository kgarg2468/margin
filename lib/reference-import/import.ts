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
  ) => Promise<{ paperId: string }>;
  onOutcome?: (index: number, outcome: ReferenceImportOutcome) => void;
  concurrency?: number;
};

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
  const completed = new Map<number, ReferenceImportOutcome>();
  let cursor = 0;

  async function worker() {
    while (cursor < pending.length) {
      const index = pending[cursor];
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
          outcome = { status: "added", paperId: result.paperId };
        }
      } catch (error) {
        outcome = { status: "failed", error };
      }
      completed.set(index, outcome);
      onOutcome?.(index, outcome);
    }
  }

  const workerCount = Math.min(
    pending.length,
    Math.max(1, Math.floor(concurrency)),
  );
  await Promise.all(Array.from({ length: workerCount }, worker));

  return new Map(
    pending.flatMap((index) => {
      const outcome = completed.get(index);
      return outcome === undefined ? [] : [[index, outcome] as const];
    }),
  );
}
