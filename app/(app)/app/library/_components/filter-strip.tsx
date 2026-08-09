"use client";

import { ConfirmAction } from "@/app/(app)/app/_components/confirm-action";
import { readableError } from "@/app/(app)/app/_components/errors";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { IngestStatusFilter, LibraryFilter } from "@/lib/library/filter";
import {
  describeFilter,
  emptyFilter,
  filtersEqual,
  isEmptyFilter,
  toggleTag,
} from "@/lib/library/filter";
import {
  errorClass,
  eyebrowClass,
  inputClass,
  keycapClass,
  linkButtonClass,
  selectClass,
} from "@/lib/ui";
import { useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import type { RefObject } from "react";
import { TagMark } from "./marks";

/**
 * The card-catalogue rail: how a member narrows a shelf of a few hundred
 * papers down to the handful they came for.
 *
 * Drawn as a band of hairlines under the header rather than as a toolbar, and
 * with as little chrome as the state allows: with nothing selected it is a
 * writing line, a couple of quiet selects, and the lab's own words. It gains an
 * accent rule and a sentence saying what it is showing only once it is actually
 * hiding something, which is the one moment that fact matters.
 *
 * The three axes are the ones worth saving (see `lib/library/filter.ts`); the
 * text box beside them is not one of them, and is deliberately the only control
 * here that is *not* remembered under a name.
 */

export type LabCollection = FunctionReturnType<
  typeof api.collections.listCollections
>[number];

/** How much of the lab's vocabulary the rail offers before it becomes a wall of words. */
const VISIBLE_TAGS = 12;

const statusOptions: { value: IngestStatusFilter; label: string }[] = [
  { value: "ready", label: "Ready to read" },
  { value: "needs-pdf", label: "Needs a PDF" },
  { value: "pending", label: "Text pending" },
  { value: "failed", label: "Ingest failed" },
];

export function FilterStrip({
  labId,
  collections,
  filter,
  onFilter,
  text,
  onText,
  textRef,
  shown,
  total,
}: {
  labId: Id<"labs">;
  collections: LabCollection[] | undefined;
  filter: LibraryFilter;
  onFilter: (filter: LibraryFilter) => void;
  text: string;
  onText: (text: string) => void;
  /** Held by the library so `/` can put the caret here from anywhere on the page. */
  textRef: RefObject<HTMLInputElement | null>;
  shown: number;
  total: number;
}) {
  const vocabulary = useQuery(api.papers.listTags, { labId }) ?? [];
  const [error, setError] = useState<string | null>(null);

  const selected =
    collections?.find((collection) => collection._id === filter.collectionId) ??
    null;
  const filtering = !isEmptyFilter(filter) || text.trim().length > 0;

  return (
    <section
      aria-label="Filter the library"
      className={
        "flex flex-col gap-3 border-y border-rule py-3 " +
        (filtering ? "border-l-2 border-l-accent pl-4" : "")
      }
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex min-w-56 flex-1 items-center gap-2 border-b border-rule focus-within:border-accent">
          <input
            ref={textRef}
            value={text}
            onChange={(event) => onText(event.target.value)}
            onKeyDown={(event) => {
              // Single letters are shortcuts out there and characters in here.
              event.stopPropagation();
              if (event.key === "Escape") {
                onText("");
                event.currentTarget.blur();
              }
            }}
            aria-label="Filter these papers by title, author or year"
            placeholder="Filter by title, author, year…"
            className="w-full bg-transparent py-1 font-serif text-base text-ink placeholder:text-ink-faint focus:outline-none"
          />
          <span className={keycapClass} title="Press / to jump here">
            /
          </span>
        </div>

        <label className="flex items-center gap-2">
          <span className="sr-only">Collection</span>
          <select
            value={filter.collectionId ?? ""}
            onChange={(event) =>
              onFilter({
                ...filter,
                collectionId:
                  event.target.value === "" ? null : event.target.value,
              })
            }
            className={`${selectClass} w-auto min-w-40`}
          >
            <option value="">All collections</option>
            {(collections ?? []).map((collection) => (
              <option key={collection._id} value={collection._id}>
                {collection.name} ({collection.paperCount})
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2">
          <span className="sr-only">Ingest state</span>
          <select
            value={filter.ingestStatus ?? ""}
            onChange={(event) =>
              onFilter({
                ...filter,
                ingestStatus:
                  event.target.value === ""
                    ? null
                    : (event.target.value as IngestStatusFilter),
              })
            }
            className={`${selectClass} w-auto min-w-36`}
          >
            <option value="">Any state</option>
            {statusOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {vocabulary.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`${eyebrowClass} mr-1`}>Tags</span>
          {vocabulary.slice(0, VISIBLE_TAGS).map(({ tag, count }) => (
            <TagMark
              key={tag}
              tag={tag}
              active={filter.tags.includes(tag)}
              title={`${count} ${count === 1 ? "paper" : "papers"}`}
              onClick={() => onFilter(toggleTag(filter, tag))}
            />
          ))}
          {/* A tag being filtered on that is too rare to be in the visible
              vocabulary still has to be visible — otherwise the list is
              narrowed by something with no on-screen cause. */}
          {filter.tags
            .filter(
              (tag) =>
                !vocabulary
                  .slice(0, VISIBLE_TAGS)
                  .some((entry) => entry.tag === tag),
            )
            .map((tag) => (
              <TagMark
                key={tag}
                tag={tag}
                active
                onClick={() => onFilter(toggleTag(filter, tag))}
              />
            ))}
        </div>
      )}

      <Collections
        labId={labId}
        collections={collections}
        selected={selected}
        onSelect={(collectionId) => onFilter({ ...filter, collectionId })}
        onError={setError}
      />

      <SavedFilters
        labId={labId}
        filter={filter}
        collections={collections}
        onApply={onFilter}
        onError={setError}
      />

      {filtering && (
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-sans text-xs text-ink-faint">
          <span className="text-ink-muted">
            {/* `describeFilter` says "a deleted collection" for an id it cannot
                resolve, which is true once the shelves are in and a small lie
                for the moment before they are. */}
            {filter.collectionId !== null && collections === undefined
              ? "Reading the shelves…"
              : describeFilter(filter, {
                  collectionName: selected?.name ?? null,
                })}
          </span>
          <span className="tabular-nums">
            {shown} of {total} {total === 1 ? "paper" : "papers"}
          </span>
          <button
            type="button"
            onClick={() => {
              onFilter(emptyFilter);
              onText("");
            }}
            className={`${linkButtonClass} tap-target`}
          >
            Clear
          </button>
        </p>
      )}

      {error !== null && (
        <p role="alert" className={errorClass}>
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * Making, renaming and unmaking a shelf.
 *
 * Kept to one line of links under the selects rather than a panel of its own:
 * a collection is created rarely and used constantly, so the making of one
 * should cost a click and take no space until it is asked for.
 */
function Collections({
  labId,
  collections,
  selected,
  onSelect,
  onError,
}: {
  labId: Id<"labs">;
  collections: LabCollection[] | undefined;
  selected: LabCollection | null;
  onSelect: (collectionId: string | null) => void;
  onError: (message: string | null) => void;
}) {
  const createCollection = useMutation(api.collections.createCollection);
  const renameCollection = useMutation(api.collections.renameCollection);
  const deleteCollection = useMutation(api.collections.deleteCollection);
  const [mode, setMode] = useState<"idle" | "new" | "rename">("idle");
  const [name, setName] = useState("");

  async function submit() {
    onError(null);
    try {
      if (mode === "new") {
        const collectionId = await createCollection({ labId, name });
        onSelect(collectionId);
      } else if (mode === "rename" && selected !== null) {
        await renameCollection({ collectionId: selected._id, name });
      }
      setMode("idle");
      setName("");
    } catch (caught) {
      onError(readableError(caught, "That collection wouldn't save."));
    }
  }

  if (mode !== "idle") {
    return (
      <form
        className="pop-in flex flex-wrap items-center gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          autoFocus
          value={name}
          maxLength={60}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape") {
              setMode("idle");
              setName("");
            }
          }}
          aria-label={mode === "new" ? "New collection name" : "New name"}
          placeholder="Foundational"
          className={`${inputClass} w-auto min-w-48`}
        />
        <button type="submit" className={`${linkButtonClass} tap-target`}>
          {mode === "new" ? "Make it" : "Rename"}
        </button>
        <button
          type="button"
          onClick={() => {
            setMode("idle");
            setName("");
          }}
          className="tap-target font-sans text-sm text-ink-faint underline-offset-4 hover:underline"
        >
          Cancel
        </button>
      </form>
    );
  }

  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 font-sans text-xs">
      <button
        type="button"
        onClick={() => {
          setName("");
          setMode("new");
        }}
        className={`${linkButtonClass} tap-target text-xs`}
      >
        New collection
      </button>

      {selected !== null && selected.canManage && (
        <>
          <button
            type="button"
            onClick={() => {
              setName(selected.name);
              setMode("rename");
            }}
            className={`${linkButtonClass} tap-target text-xs`}
          >
            Rename “{selected.name}”
          </button>
          <ConfirmAction
            label="Delete it"
            confirmLabel={`Delete “${selected.name}” — the papers stay`}
            tone="faint"
            run={async () => {
              onError(null);
              try {
                await deleteCollection({ collectionId: selected._id });
                onSelect(null);
              } catch (caught) {
                onError(
                  readableError(caught, "That collection wouldn't delete."),
                );
              }
            }}
          />
        </>
      )}

      {selected !== null && !selected.canManage && (
        <span className="text-ink-faint">
          Made by {selected.createdByName ?? "another member"}
        </span>
      )}

      {collections !== undefined && collections.length === 0 && (
        <span className="text-ink-faint">
          A collection is a named, ordered shelf — “Foundational”, “Methods
          week”.
        </span>
      )}
    </div>
  );
}

/**
 * Views this member keeps.
 *
 * Drawn as ribbons rather than as another select, because they are not a fourth
 * axis of the filter — they are shortcuts *to* a filter, and the difference is
 * worth showing. They are also the one thing on this rail that belongs to one
 * person: nothing here is visible to the rest of the lab, and nothing about it
 * reaches the ledger.
 */
function SavedFilters({
  labId,
  filter,
  collections,
  onApply,
  onError,
}: {
  labId: Id<"labs">;
  filter: LibraryFilter;
  collections: LabCollection[] | undefined;
  onApply: (filter: LibraryFilter) => void;
  onError: (message: string | null) => void;
}) {
  const saved = useQuery(api.collections.listSavedFilters, { labId });
  const saveFilter = useMutation(api.collections.saveFilter);
  const deleteSavedFilter = useMutation(api.collections.deleteSavedFilter);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  const rows = (saved ?? []).map((row) => ({
    row,
    filter: {
      tags: row.tags,
      collectionId: row.collectionId ?? null,
      ingestStatus: row.ingestStatus ?? null,
    } satisfies LibraryFilter,
  }));
  const applied = rows.find((entry) => filtersEqual(entry.filter, filter));
  const savable = !isEmptyFilter(filter) && applied === undefined;

  if (rows.length === 0 && !savable) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className={eyebrowClass}>Saved</span>

      {rows.map(({ row, filter: savedFilter }) => {
        const active = applied?.row._id === row._id;
        const collectionName =
          savedFilter.collectionId === null
            ? null
            : (collections?.find(
                (collection) => collection._id === savedFilter.collectionId,
              )?.name ?? null);
        return (
          <button
            key={row._id}
            type="button"
            onClick={() => onApply(savedFilter)}
            aria-pressed={active}
            title={describeFilter(savedFilter, { collectionName })}
            className={
              "tap-target rounded-sm border-l-2 px-2 py-0.5 font-sans text-sm transition-colors " +
              (active
                ? "border-accent bg-surface-sunken text-ink-strong"
                : "border-rule text-ink-muted hover:border-accent hover:text-ink")
            }
          >
            {row.name}
          </button>
        );
      })}

      {applied !== undefined && (
        <ConfirmAction
          label="Forget it"
          confirmLabel={`Forget “${applied.row.name}”`}
          tone="faint"
          run={async () => {
            onError(null);
            try {
              await deleteSavedFilter({ savedFilterId: applied.row._id });
            } catch (caught) {
              onError(readableError(caught, "That filter wouldn't go away."));
            }
          }}
        />
      )}

      {savable &&
        (naming ? (
          <form
            className="pop-in flex items-center gap-2"
            onSubmit={async (event) => {
              event.preventDefault();
              onError(null);
              try {
                await saveFilter({
                  labId,
                  name,
                  tags: filter.tags,
                  collectionId:
                    filter.collectionId === null
                      ? undefined
                      : (filter.collectionId as Id<"collections">),
                  ingestStatus: filter.ingestStatus ?? undefined,
                });
                setNaming(false);
                setName("");
              } catch (caught) {
                onError(readableError(caught, "That filter wouldn't save."));
              }
            }}
          >
            <input
              autoFocus
              value={name}
              maxLength={60}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") {
                  setNaming(false);
                }
              }}
              aria-label="Name for this view"
              placeholder="Thursday's reading"
              className={`${inputClass} w-auto min-w-44`}
            />
            <button type="submit" className={`${linkButtonClass} tap-target`}>
              Save
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => {
              setName("");
              setNaming(true);
            }}
            className={`${linkButtonClass} tap-target text-xs`}
          >
            Save this view
          </button>
        ))}
    </div>
  );
}
