"use client";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { papersToBibtex } from "@/lib/export/bibtex";
import { downloadText, exportFilename } from "@/lib/export/download";
import type { LibraryFilter } from "@/lib/library/filter";
import { applyLibraryFilter, emptyFilter } from "@/lib/library/filter";
import { eyebrowClass, secondaryButtonClass } from "@/lib/ui";
import { useQuery } from "convex-helpers/react/cache/hooks";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useRef, useState } from "react";
import type { LabSummary } from "../_components/lab-provider";
import { useLabs } from "../_components/lab-provider";
import { ListSkeleton, PageSkeleton } from "../_components/skeletons";
import { AddPaper } from "./_components/add-paper";
import { FilterStrip } from "./_components/filter-strip";
import { FiledAs, TagMark } from "./_components/marks";
import { byline } from "./_components/paper-meta";
import { shelfRow } from "./_components/shelf-row";
import { ShortcutHint } from "./_components/shortcuts";

/**
 * The shelf.
 *
 * `?collection=` opens the library already narrowed to one collection — it is
 * how the rail hands off to here, the same way `?paper=` hands the paper page
 * off to the calendar. A collection is not a page of its own: it is the library
 * with a filter on, and giving it a route of its own would be two lists to keep
 * honest.
 */
export default function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ collection?: string }>;
}) {
  const { collection } = use(searchParams);
  const { labs, currentLab } = useLabs();

  if (labs === undefined) {
    return <PageSkeleton />;
  }

  if (currentLab === null) {
    return (
      <div className="flex flex-col gap-3 border-l border-rule pl-6">
        <h1 className="font-serif text-4xl tracking-tight text-ink-strong">
          Library
        </h1>
        <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
          A library belongs to a lab, and you aren&rsquo;t in one yet.
        </p>
        <Link
          href="/app"
          className="font-sans text-sm text-accent underline-offset-4 hover:underline"
        >
          Start or join a lab
        </Link>
      </div>
    );
  }

  return (
    <Library
      // Remounted when the rail picks a different collection, which is what
      // makes the URL the source of truth for where the shelf starts and the
      // component's own state the source of truth for everything after.
      key={`${currentLab._id}:${collection ?? ""}`}
      lab={currentLab}
      collectionId={
        collection === undefined || collection.length === 0
          ? null
          : collection
      }
    />
  );
}

function Library({
  lab,
  collectionId,
}: {
  lab: LabSummary;
  collectionId: string | null;
}) {
  const papers = useQuery(api.papers.listPapers, { labId: lab._id });
  const collections = useQuery(api.collections.listCollections, {
    labId: lab._id,
  });
  const router = useRouter();

  const [filter, setFilter] = useState<LibraryFilter>({
    ...emptyFilter,
    collectionId,
  });
  const [text, setText] = useState("");
  const [adding, setAdding] = useState(false);
  /** Which row carries the mark, as an index into what is currently drawn. */
  const [marked, setMarked] = useState<number | null>(null);
  /** The paper whose "filed as" panel is open, if any. */
  const [filing, setFiling] = useState<Id<"papers"> | null>(null);
  const [hint, setHint] = useState(false);

  const textRef = useRef<HTMLInputElement | null>(null);
  const markedRef = useRef<HTMLLIElement | null>(null);

  const selected =
    collections?.find((entry) => entry._id === filter.collectionId) ?? null;

  const shown = applyLibraryFilter(papers ?? [], {
    filter,
    text,
    collectionPaperIds: selected?.paperIds ?? null,
  });

  const isEmpty = papers !== undefined && papers.length === 0;
  // Clamped rather than stored clamped: the list under the mark changes as the
  // filter narrows, and a stored index would point past the end of it.
  const markedIndex =
    marked === null ? null : Math.min(marked, shown.length - 1);
  const markedPaper = markedIndex === null ? null : shown[markedIndex];

  const open = useCallback(
    (paper: (typeof shown)[number]) => {
      // The ↵ destination is the row's primary destination — the same question
      // the title answers visually, so the same function answers it here.
      router.push(
        shelfRow(paper).titleOpensReader
          ? `/app/library/${paper._id}/read`
          : `/app/library/${paper._id}`,
      );
    },
    [router],
  );

  /**
   * The library's keys.
   *
   * Bound at the window because the shelf has no single focusable container to
   * hang them off, and guarded three ways so they only ever fire when the
   * reader means them: never with a modifier — ⌘K is the palette's and nothing
   * here may shadow it — never while the caret is in a field, and never while
   * something typed-into is what the keystroke would otherwise reach.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement)
      ) {
        return;
      }

      switch (event.key) {
        case "/":
          event.preventDefault();
          textRef.current?.focus();
          textRef.current?.select();
          return;
        case "a":
          event.preventDefault();
          setAdding(true);
          return;
        case "t":
          if (markedPaper !== undefined && markedPaper !== null) {
            event.preventDefault();
            setFiling(markedPaper._id);
          }
          return;
        case "?":
          event.preventDefault();
          setHint((was) => !was);
          return;
        case "Escape":
          setHint(false);
          setFiling(null);
          setMarked(null);
          // `a` opens the panel and nothing closed it but a link at the bottom
          // of it. This half only covers an Escape pressed with focus outside a
          // field — the guard above returns before here otherwise, and the DOI
          // input has focus the instant the panel opens, so `AddPaper` answers
          // that case itself (`onDismiss`). On an empty shelf both are a no-op
          // by design: the panel is rendered by `isEmpty` there, and there is
          // nothing to put away.
          setAdding(false);
          return;
        case "ArrowDown":
          if (shown.length > 0) {
            event.preventDefault();
            setMarked((index) =>
              index === null ? 0 : Math.min(index + 1, shown.length - 1),
            );
          }
          return;
        case "ArrowUp":
          if (shown.length > 0) {
            event.preventDefault();
            setMarked((index) => (index === null ? 0 : Math.max(index - 1, 0)));
          }
          return;
        case "Enter":
          if (markedPaper !== undefined && markedPaper !== null) {
            event.preventDefault();
            open(markedPaper);
          }
          return;
        default:
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [markedPaper, open, shown.length]);

  /**
   * Move the browser's own focus with the mark, so the arrow keys move a
   * screen reader down the shelf rather than moving a border a screen reader
   * cannot see. Held back while a panel is open — the caret in the tag field is
   * where the reader actually is.
   */
  useEffect(() => {
    if (markedIndex !== null && filing === null) {
      markedRef.current?.focus({ preventScroll: false });
    }
  }, [markedIndex, filing]);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3 border-l border-rule pl-6">
        <div className="flex items-start justify-between gap-4">
          <h1 className="font-serif text-4xl tracking-tight text-ink-strong">
            {selected === null ? "Library" : selected.name}
          </h1>
          <ShortcutHint open={hint} onToggle={() => setHint((was) => !was)} />
        </div>
        <p className="font-sans text-sm text-ink-muted">
          {selected === null
            ? `What ${lab.name} is reading`
            : `A collection in ${lab.name}`}
          {papers !== undefined && papers.length > 0
            ? ` · ${papers.length} ${papers.length === 1 ? "paper" : "papers"}`
            : ""}
        </p>
        {papers !== undefined && papers.length > 0 && (
          <button
            type="button"
            onClick={() =>
              downloadText(
                papersToBibtex(papers),
                exportFilename(`${lab.name} library`, "bib"),
                "application/x-bibtex;charset=utf-8",
              )
            }
            className="pressable tap-target self-start font-sans text-xs text-ink-faint underline-offset-4 hover:text-accent hover:underline"
          >
            Download BibTeX
          </button>
        )}
      </header>

      {/* An empty library has nothing to hide the form behind.
          `onAdded` pins the panel open the moment a lookup succeeds: without
          it the first paper closed the form by arriving, because `isEmpty`
          stopped being true and `adding` had never been set — taking the
          outcome of the lookup off the screen at the one moment it was worth
          reading. Closing it is now something the reader does. */}
      {isEmpty || adding ? (
        <div className="flex flex-col gap-3">
          <AddPaper
            labId={lab._id}
            onAdded={() => setAdding(true)}
            onDismiss={() => setAdding(false)}
          />
          {!isEmpty && (
            <button
              type="button"
              onClick={() => setAdding(false)}
              // The way out of a panel should not be quieter than the way in:
              // this is the same control as `Add a paper` above, run backwards.
              className={`${secondaryButtonClass} tap-target self-start`}
            >
              Done adding
            </button>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          title="Add a paper (a)"
          className={`${secondaryButtonClass} tap-target self-start`}
        >
          Add a paper
        </button>
      )}

      {papers !== undefined && papers.length > 0 && (
        <FilterStrip
          labId={lab._id}
          collections={collections}
          filter={filter}
          onFilter={(next) => {
            setFilter(next);
            setMarked(null);
          }}
          text={text}
          onText={(next) => {
            setText(next);
            setMarked(null);
          }}
          textRef={textRef}
          shown={shown.length}
          total={papers.length}
        />
      )}

      <section className="flex flex-col gap-5">
        <h2 className={eyebrowClass}>Papers</h2>

        {papers === undefined ? (
          <ListSkeleton />
        ) : papers.length === 0 ? (
          <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
            Nothing on the shelf yet. A library starts with one paper: paste a
            DOI and Margin fetches the record, drop in a PDF, or import a
            reference-manager export in bulk.
          </p>
        ) : shown.length === 0 ? (
          <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
            Nothing on this shelf answers to that. Clear the filter above, or
            widen it — a tag narrows, so two tags means both.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-rule border-y border-rule">
            {shown.map((paper, index) => {
              const line = byline(paper);
              // A readable paper is one whose text layer is in, which is the only
              // state the margins can be written in — so its title opens the
              // reader and its record steps back to a second, quieter link.
              // Anything else has one place worth going and one thing worth
              // doing there, and `shelfRow` is where that stays true: the row
              // must never offer the same URL twice.
              const row = shelfRow(paper);
              const isMarked = markedIndex === index;
              return (
                <li
                  key={paper._id}
                  ref={isMarked ? markedRef : null}
                  tabIndex={-1}
                  onFocus={() => setMarked(index)}
                  className={
                    "flex flex-col gap-1 border-l-2 py-4 pl-4 transition-colors focus:outline-none " +
                    (isMarked
                      ? "border-accent bg-surface-sunken/50"
                      : "border-transparent")
                  }
                >
                  <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    {row.titleOpensReader ? (
                      <Link
                        href={`/app/library/${paper._id}/read`}
                        className="font-serif text-xl leading-snug text-ink-strong underline-offset-4 hover:underline"
                      >
                        {paper.title}
                      </Link>
                    ) : (
                      // Not a link, and drawn as one thing rather than two: the
                      // underline was promising a second route to the record,
                      // which the named action below already is. The row is
                      // still focusable and `↵` still opens it.
                      <span className="font-serif text-xl leading-snug text-ink-strong">
                        {paper.title}
                      </span>
                    )}
                  </span>
                  {line.length > 0 && (
                    <span className="font-sans text-sm text-ink-muted">
                      {line}
                    </span>
                  )}

                  {paper.tags.length > 0 && (
                    <span className="mt-1 flex flex-wrap items-center gap-1.5">
                      {paper.tags.map((tag) => (
                        <TagMark
                          key={tag}
                          tag={tag}
                          active={filter.tags.includes(tag)}
                          title={`Show everything tagged ${tag}`}
                          onClick={() => {
                            setFilter((current) => ({
                              ...current,
                              tags: current.tags.includes(tag)
                                ? current.tags.filter((one) => one !== tag)
                                : [...current.tags, tag],
                            }));
                            setMarked(null);
                          }}
                        />
                      ))}
                    </span>
                  )}

                  <span className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    {/* A paper that can't be read yet has exactly one thing
                        worth doing to it, and a chip reading "TEXT PENDING"
                        next to a title says neither what that is nor where.
                        One named action, in the accent, carrying both — which
                        is why the chip that used to sit beside the title is
                        gone rather than sitting above this saying the same
                        thing quieter. */}
                    {/* The one anchor in the lane wearing `pressable`: a
                        named action a thumb lands on, sitting in a row of
                        controls, not a word inside a sentence. Prose links
                        stay as they are. */}
                    <Link
                      href={`/app/library/${paper._id}`}
                      className={
                        row.record.tone === "quiet"
                          ? "pressable tap-target font-sans text-xs text-ink-faint underline-offset-4 hover:text-accent hover:underline"
                          : "pressable tap-target font-sans text-sm text-accent underline-offset-4 hover:underline"
                      }
                    >
                      {row.record.label}
                    </Link>
                    <button
                      type="button"
                      title="Tag and shelve this paper (t)"
                      aria-expanded={filing === paper._id}
                      onClick={() => {
                        setMarked(index);
                        setFiling(filing === paper._id ? null : paper._id);
                      }}
                      className="pressable tap-target font-sans text-xs text-ink-faint underline-offset-4 hover:text-accent hover:underline"
                    >
                      {filing === paper._id ? "Close" : "Filed as…"}
                    </button>
                  </span>

                  {filing === paper._id && (
                    <div className="pop-in mt-3">
                      <FiledAs
                        paperId={paper._id}
                        labId={lab._id}
                        tags={paper.tags}
                        autoFocus
                        onDone={() => setFiling(null)}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
