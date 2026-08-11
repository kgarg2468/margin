"use client";

import { readableError } from "@/app/(app)/app/_components/errors";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  findWithinBatchDuplicates,
  importReferences,
  type ReferenceImportOutcome,
} from "@/lib/reference-import/import";
import {
  parseReferenceImport,
  type ReferenceEntry,
  type ReferenceFormat,
} from "@/lib/reference-import";
import {
  chipClass,
  errorClass,
  labelClass,
  primaryButtonClass,
  secondaryButtonClass,
  textareaClass,
} from "@/lib/ui";
import { useAction, useMutation } from "convex/react";
import { useEffect, useRef, useState } from "react";

type Preview = {
  format: ReferenceFormat;
  entries: ReferenceEntry[];
  sourceName: string | null;
};

export function ReferenceImport({
  labId,
  onAdded,
  onBusy,
}: {
  labId: Id<"labs">;
  onAdded?: () => void;
  /**
   * A running import holds the panel open. It is the longest wait of the three
   * — one round trip per selected reference — and the one whose abandonment
   * costs most, because the outcomes list is the only record of which entries
   * landed and which did not.
   */
  onBusy?: (busy: boolean) => void;
}) {
  const createFromDoi = useAction(api.papers.createFromDoi);
  const createFromMetadata = useMutation(api.papers.createFromMetadata);
  const fileInput = useRef<HTMLInputElement>(null);
  const keptOpen = useRef(false);

  const [source, setSource] = useState("");
  const [sourceName, setSourceName] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [outcomes, setOutcomes] = useState<
    Map<number, ReferenceImportOutcome>
  >(new Map());
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onBusy?.(importing);
  }, [importing, onBusy]);

  function prepare(text: string, name: string | null) {
    setError(null);
    try {
      const parsed = parseReferenceImport(text, name ?? undefined);
      setPreview({ ...parsed, sourceName: name });
      setSelected(new Set(parsed.entries.map((_, index) => index)));
      setOutcomes(new Map());
    } catch (caught) {
      setPreview(null);
      setSelected(new Set());
      setOutcomes(new Map());
      setError(
        caught instanceof Error
          ? caught.message
          : "Margin couldn't read that reference export.",
      );
    }
  }

  async function readFile(file: File | undefined) {
    if (file === undefined) {
      return;
    }
    if (!/\.(?:bib|ris)$/i.test(file.name)) {
      setError("Choose a .bib or .ris export from your reference manager.");
      return;
    }
    try {
      const text = await file.text();
      setSource(text);
      setSourceName(file.name);
      prepare(text, file.name);
    } catch {
      setError("Margin couldn't read that file. Try exporting it again.");
    }
  }

  function startOver() {
    setSource("");
    setSourceName(null);
    setPreview(null);
    setSelected(new Set());
    setOutcomes(new Map());
    setImporting(false);
    setError(null);
  }

  async function confirmImport() {
    if (preview === null || selected.size === 0) {
      return;
    }
    setImporting(true);
    setError(null);
    setOutcomes(new Map());

    const results = await importReferences({
      entries: preview.entries,
      selected: [...selected].sort((left, right) => left - right),
      createFromDoi: async (entry) => {
        if (entry.doi === undefined) {
          throw new Error("This reference has no DOI.");
        }
        return await createFromDoi({ labId, doi: entry.doi });
      },
      createFromMetadata: async (entry) => {
        return await createFromMetadata({
          labId,
          title: entry.title,
          authors: entry.authors.length > 0 ? entry.authors : undefined,
          year: entry.year,
          venue: entry.venue,
          abstract: entry.abstract,
          sourceUrl: entry.url,
        });
      },
      onOutcome: (index, outcome) => {
        if (outcome.status === "added" && !keptOpen.current) {
          keptOpen.current = true;
          onAdded?.();
        }
        setOutcomes((current) => {
          const next = new Map(current);
          next.set(index, outcome);
          return next;
        });
      },
    });

    setImporting(false);
    setOutcomes(results);
  }

  const withinBatchDuplicates =
    preview === null
      ? new Map<number, number>()
      : findWithinBatchDuplicates(preview.entries, selected);

  return (
    <div
      role="tabpanel"
      id="add-paper-panel-references"
      aria-labelledby="add-paper-tab-references"
      tabIndex={0}
      className="flex flex-col gap-5"
    >
      {preview === null ? (
        <>
          <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
            Export BibTeX or RIS from Zotero, Paperpile, or EndNote. Paste the
            export below, or choose the file; you can review every record
            before anything enters the lab.
          </p>

          <div className="flex flex-col gap-2">
            <label htmlFor="reference-import-text" className={labelClass}>
              BibTeX or RIS
            </label>
            <textarea
              id="reference-import-text"
              rows={9}
              value={source}
              onChange={(event) => {
                setSource(event.target.value);
                setSourceName(null);
                setError(null);
              }}
              placeholder="Paste an @article{…} entry or a TY  - JOUR record"
              spellCheck={false}
              className={`${textareaClass} font-mono`}
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={source.trim().length === 0}
              onClick={() => prepare(source, sourceName)}
              className={primaryButtonClass}
            >
              Preview references
            </button>
            <span className="font-sans text-xs text-ink-faint">or</span>
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                void readFile(event.dataTransfer.files[0]);
              }}
              className={`${secondaryButtonClass} ${
                dragging ? "border-accent bg-highlight" : ""
              }`}
            >
              Choose or drop a .bib/.ris file
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".bib,.ris,application/x-research-info-systems"
              tabIndex={-1}
              className="sr-only"
              onChange={(event) => {
                void readFile(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <p className="font-serif text-lg text-ink-strong">
                {preview.entries.length}{" "}
                {preview.entries.length === 1 ? "reference" : "references"}{" "}
                ready to review
              </p>
              <p className="font-sans text-xs text-ink-faint">
                {preview.sourceName ??
                  (preview.format === "bibtex" ? "Pasted BibTeX" : "Pasted RIS")}
              </p>
            </div>
            {outcomes.size === 0 && (
              <div className="flex gap-4">
                <button
                  type="button"
                  disabled={importing}
                  onClick={() =>
                    setSelected(
                      new Set(preview.entries.map((_, index) => index)),
                    )
                  }
                  className="tap-target font-sans text-xs text-accent underline-offset-4 hover:underline"
                >
                  Select all
                </button>
                <button
                  type="button"
                  disabled={importing}
                  onClick={() => setSelected(new Set())}
                  className="tap-target font-sans text-xs text-accent underline-offset-4 hover:underline"
                >
                  Clear
                </button>
              </div>
            )}
          </div>

          <ul className="flex flex-col divide-y divide-rule border-y border-rule">
            {preview.entries.map((entry, index) => {
              const outcome = outcomes.get(index);
              const withinBatchDuplicate = withinBatchDuplicates.has(index);
              const details = [
                entry.authors.join(", "),
                entry.year?.toString(),
                entry.doi === undefined ? undefined : `DOI ${entry.doi}`,
              ].filter((value): value is string => Boolean(value));
              return (
                <li key={index} className="py-4">
                  <label className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={selected.has(index)}
                      disabled={importing || outcomes.size > 0}
                      onChange={(event) => {
                        setSelected((current) => {
                          const next = new Set(current);
                          if (event.target.checked) {
                            next.add(index);
                          } else {
                            next.delete(index);
                          }
                          return next;
                        });
                      }}
                      className="mt-1 size-4 accent-accent"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block font-serif text-base leading-snug text-ink-strong">
                        {entry.title}
                      </span>
                      {details.length > 0 && (
                        <span className="mt-1 block font-sans text-xs leading-relaxed text-ink-muted">
                          {details.join(" · ")}
                        </span>
                      )}
                    </span>
                    {outcome !== undefined ? (
                      <Outcome outcome={outcome} />
                    ) : withinBatchDuplicate ? (
                      <span className={chipClass}>Skipped duplicate</span>
                    ) : null}
                  </label>
                </li>
              );
            })}
          </ul>

          {importing && (
            <p role="status" className="font-sans text-sm text-ink-muted">
              Importing {outcomes.size} of {selected.size}…
            </p>
          )}

          <div className="flex flex-wrap items-center gap-4">
            {outcomes.size === 0 ? (
              <button
                type="button"
                disabled={importing || selected.size === 0}
                onClick={() => void confirmImport()}
                className={primaryButtonClass}
              >
                {importing
                  ? "Adding references…"
                  : `Add ${selected.size} ${selected.size === 1 ? "reference" : "references"}`}
              </button>
            ) : (
              <ImportSummary outcomes={outcomes} />
            )}
            <button
              type="button"
              disabled={importing}
              onClick={startOver}
              className={secondaryButtonClass}
            >
              {outcomes.size > 0 ? "Import another export" : "Start over"}
            </button>
          </div>
        </>
      )}

      {error !== null && (
        <p role="alert" className={errorClass}>
          {error}
        </p>
      )}
    </div>
  );
}

function Outcome({ outcome }: { outcome: ReferenceImportOutcome }) {
  if (outcome.status === "added") {
    return <span className={chipClass}>Added</span>;
  }
  if (outcome.status === "duplicate") {
    return <span className={chipClass}>Skipped duplicate</span>;
  }
  return (
    <span className="max-w-48 text-right font-sans text-xs text-ink-muted">
      Failed · {readableError(outcome.error, "This reference couldn't be added.")}
    </span>
  );
}

function ImportSummary({
  outcomes,
}: {
  outcomes: Map<number, ReferenceImportOutcome>;
}) {
  const counts = { added: 0, duplicate: 0, failed: 0 };
  for (const outcome of outcomes.values()) {
    counts[outcome.status]++;
  }
  const parts = [
    `${counts.added} added`,
    counts.duplicate > 0 ? `${counts.duplicate} skipped duplicate` : null,
    counts.failed > 0 ? `${counts.failed} failed` : null,
  ].filter((part): part is string => part !== null);

  return (
    <p aria-live="polite" className="font-serif text-base text-ink">
      {parts.join(" · ")}
    </p>
  );
}
