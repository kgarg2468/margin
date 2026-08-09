"use client";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { annotationsToCsv, annotationsToJson } from "@/lib/export/csv";
import { downloadText, exportFilename } from "@/lib/export/download";
import { pdfAuthHeaders, pdfEndpoint } from "@/lib/pdf/delivery";
import { loadPdfjs } from "@/lib/pdf/extract";
import { eyebrowClass, skeletonClass } from "@/lib/ui";
import { useAuthToken } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import Link from "next/link";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
} from "pdfjs-dist/types/src/display/api";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Composer } from "./composer";
import type { RailCard } from "./margin-rail";
import { MarginRail } from "./margin-rail";
import type { AnnotationType } from "./ontology";
import { ANNOTATION_TYPES } from "./ontology";
import { PdfPage } from "./pdf-page";
import type {
  AnnotationId,
  AnnotationView,
  Draft,
  PageResolution,
} from "./types";

/**
 * The reader.
 *
 * It takes the whole window rather than sitting in the app's centred column,
 * because the shape of the thing is two columns — the paper and the lab's
 * margin beside it — and a paper rendered at 500 px is a paper nobody reads.
 * The sidebar stays where it is on desktop; below that width the reader takes
 * the screen and carries its own way back.
 *
 * Nothing here records that you opened it. There is no dwell timer, no read
 * receipt, no "last viewed": the only trace of a member in this component is an
 * annotation they chose to write. That is the privacy constitution, and it is
 * cheap to keep because it consists entirely of code not written.
 *
 * Annotations arrive through `useQuery`, which is a live subscription — a note
 * a colleague writes during a session appears in this margin without a reload,
 * and there is deliberately no local cache in front of it to break that.
 */

/** Below this the margin cannot align to passages, so it becomes a list. */
const ALIGNED_WIDTH = 1024;

function useAligned(): boolean {
  const [aligned, setAligned] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(`(min-width: ${ALIGNED_WIDTH}px)`);
    const sync = () => setAligned(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return aligned;
}

export function Reader({
  paperId,
  sessionId,
}: {
  paperId: Id<"papers">;
  sessionId?: Id<"sessions">;
}) {
  const paper = useQuery(api.papers.getPaper, { paperId });
  const annotations = useQuery(api.annotations.listForPaper, { paperId });
  const token = useAuthToken();
  const aligned = useAligned();

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const columnRef = useRef<HTMLDivElement | null>(null);
  const pageElements = useRef(new Map<number, HTMLDivElement>());

  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [docFailed, setDocFailed] = useState(false);
  const [baseSize, setBaseSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  const [columnWidth, setColumnWidth] = useState(0);
  const [columnHeight, setColumnHeight] = useState(0);
  const [originTop, setOriginTop] = useState(0);
  const [window_, setWindow] = useState<Set<number>>(new Set([0, 1, 2]));
  const [currentPage, setCurrentPage] = useState(0);
  const [activeId, setActiveId] = useState<AnnotationId | null>(null);
  const [filter, setFilter] = useState<Set<AnnotationType>>(new Set());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [resolutions, setResolutions] = useState<Map<number, PageResolution>>(
    new Map(),
  );

  // In dark mode the sheet is developed dark by default (see reader.module.css)
  // and this is the way back to print-white — figures only read faithfully in
  // their printed colours. A preference about your own eyes, so it is kept on
  // this device and nowhere else.
  const [sheet, setSheet] = useState<"dark" | "white">("dark");
  useEffect(() => {
    try {
      if (window.localStorage.getItem("margin:sheet") === "white") {
        setSheet("white");
      }
    } catch {
      // Storage can be denied; the default is the right answer then.
    }
  }, []);
  const toggleSheet = () =>
    setSheet((previous) => {
      const next = previous === "dark" ? "white" : "dark";
      try {
        window.localStorage.setItem("margin:sheet", next);
      } catch {
        // Session-only, then.
      }
      return next;
    });

  // --- the document ------------------------------------------------------
  //
  // The PDF is fetched from a membership-checked endpoint (see
  // `lib/pdf/delivery.ts`), so pdf.js has to carry the member's auth token on
  // the request. The token is read through a ref rather than depended on,
  // because it rotates: an effect that re-ran on rotation would tear down the
  // document and its worker under somebody an hour into a paper, and re-open
  // it at page one. Nothing needs the fresh one — the whole file is fetched
  // up front, and by the time a token expires the bytes are long since here.
  const tokenRef = useRef(token);
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  // One boolean, so this flips once (when the paper and the token have both
  // arrived) rather than tracking either of them.
  //
  // The token half is what keeps the reader out of the trap the text-layer
  // hook had to be dug out of: opening without one gets a 401, and a 401 read
  // as a verdict on the file is a good paper called broken. Here it only ever
  // meant a wrong sentence on screen — this component records nothing — but
  // waiting is still the honest thing, and it costs a few milliseconds on a
  // cold load.
  const canFetch = paper?.hasPdf === true && token !== null;

  useEffect(() => {
    if (!canFetch) {
      return;
    }
    let cancelled = false;
    let task: PDFDocumentLoadingTask | null = null;

    const run = async () => {
      // Stated rather than defaulted: `canFetch` is the guarantee that this
      // is here, and an empty bearer smuggled in behind a `??` would turn a
      // broken invariant into a puzzling 401 instead of a loud failure.
      const authToken = tokenRef.current;
      if (authToken === null) {
        return;
      }
      const pdfjs = await loadPdfjs();
      task = pdfjs.getDocument({
        url: pdfEndpoint(paperId),
        httpHeaders: pdfAuthHeaders(authToken),
      });
      const loaded = await task.promise;
      if (cancelled) {
        return;
      }
      const first = await loaded.getPage(1);
      const viewport = first.getViewport({ scale: 1 });
      first.cleanup();
      if (cancelled) {
        return;
      }
      // Every page is sized from the first one's box. Papers are uniform, and
      // it is what lets an unrendered page hold its place in the scroll.
      setBaseSize({ width: viewport.width, height: viewport.height });
      setDoc(loaded);
    };

    run().catch(() => {
      if (!cancelled) {
        setDocFailed(true);
      }
    });

    return () => {
      cancelled = true;
      // Destroying the loading task tears down the document and its worker
      // together; the pages hold proxies into it, so nothing may outlive this.
      void task?.destroy();
      setDoc(null);
    };
  }, [canFetch, paperId]);

  // --- geometry ----------------------------------------------------------
  useEffect(() => {
    const column = columnRef.current;
    if (column === null) {
      return;
    }
    const observer = new ResizeObserver(() => {
      setColumnWidth(column.clientWidth);
      setColumnHeight(column.offsetHeight);
      setOriginTop(column.offsetTop);
    });
    observer.observe(column);
    return () => observer.disconnect();
  }, [doc]);

  const scale = useMemo(() => {
    if (baseSize === null || columnWidth === 0) {
      return 1;
    }
    return Math.min(2, Math.max(0.4, columnWidth / baseSize.width));
  }, [baseSize, columnWidth]);

  const pageCount = doc?.numPages ?? 0;
  const pageWidth = baseSize === null ? 0 : Math.floor(baseSize.width * scale);
  const pageHeight = baseSize === null ? 0 : Math.floor(baseSize.height * scale);

  const registerPage = useCallback(
    (index: number, element: HTMLDivElement | null) => {
      if (element === null) {
        pageElements.current.delete(index);
      } else {
        pageElements.current.set(index, element);
      }
    },
    [],
  );

  // Render a window of pages around the viewport rather than all of them: a
  // 40-page paper is 40 canvases and 40 text layers, which is more DOM than a
  // browser will hold cheerfully.
  useEffect(() => {
    const root = scrollRef.current;
    if (root === null || pageCount === 0 || pageHeight === 0) {
      return;
    }
    const near = new IntersectionObserver(
      (entries) => {
        setWindow((previous) => {
          const next = new Set(previous);
          let changed = false;
          for (const entry of entries) {
            const index = Number(
              (entry.target as HTMLElement).dataset.page ?? "-1",
            );
            if (index < 0) {
              continue;
            }
            if (entry.isIntersecting && !next.has(index)) {
              next.add(index);
              changed = true;
            } else if (!entry.isIntersecting && next.has(index)) {
              next.delete(index);
              changed = true;
            }
          }
          return changed ? next : previous;
        });
      },
      { root, rootMargin: `${Math.round(pageHeight * 2)}px 0px` },
    );
    const current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setCurrentPage(
              Number((entry.target as HTMLElement).dataset.page ?? "0"),
            );
          }
        }
      },
      { root, rootMargin: "-45% 0px -50% 0px" },
    );

    for (const element of pageElements.current.values()) {
      near.observe(element);
      current.observe(element);
    }
    return () => {
      near.disconnect();
      current.disconnect();
    };
  }, [pageCount, pageHeight]);

  // --- annotations -------------------------------------------------------
  const handleResolved = useCallback(
    (pageIndex: number, resolution: PageResolution) => {
      setResolutions((previous) => {
        const next = new Map(previous);
        next.set(pageIndex, resolution);
        return next;
      });
    },
    [],
  );

  /** Still in flight, as distinct from "there are none". */
  const loading = annotations === undefined;
  const rows = useMemo(() => annotations?.annotations ?? [], [annotations]);

  const repliesByParent = useMemo(() => {
    const map = new Map<AnnotationId, AnnotationView[]>();
    for (const row of rows) {
      if (row.parentId === undefined) {
        continue;
      }
      const existing = map.get(row.parentId);
      if (existing === undefined) {
        map.set(row.parentId, [row]);
      } else {
        existing.push(row);
      }
    }
    return map;
  }, [rows]);

  // A withdrawn note that people answered stays in the margin as a tombstone.
  // Its body is gone from the database, but the thread hanging off it is other
  // people's writing, and dropping the parent would silently drop all of it.
  // A withdrawn note nobody answered was deleted outright and never arrives.
  const visible = useMemo(
    () =>
      rows.filter(
        (row) =>
          row.parentId === undefined &&
          (!row.deleted || row.replyCount > 0) &&
          (filter.size === 0 || filter.has(row.type)),
      ),
    [rows, filter],
  );

  // A withdrawn note keeps its card, because the thread hanging off it is
  // other people's writing — but it does not keep its highlight. Its body is
  // gone; it no longer says anything about the passage, and leaving the
  // passage marked would claim otherwise.
  const byPage = useMemo(() => {
    const map = new Map<number, AnnotationView[]>();
    for (const row of visible) {
      if (row.deleted) {
        continue;
      }
      const list = map.get(row.anchor.pageIndex);
      if (list === undefined) {
        map.set(row.anchor.pageIndex, [row]);
      } else {
        list.push(row);
      }
    }
    return map;
  }, [visible]);

  const { cards, unanchored } = useMemo(() => {
    const anchored: RailCard[] = [];
    const lost: RailCard[] = [];
    for (const annotation of visible) {
      const page = annotation.anchor.pageIndex;
      const resolution = resolutions.get(page);
      const element = pageElements.current.get(page);
      const entry = {
        annotation,
        replies: repliesByParent.get(annotation._id) ?? [],
        top: 0,
        state: resolution?.states.get(annotation._id),
      };

      if (resolution !== undefined && resolution.orphaned.includes(annotation._id)) {
        lost.push(entry);
        continue;
      }
      if (page >= pageCount && pageCount > 0) {
        lost.push(entry);
        continue;
      }

      const known = resolution?.positions.get(annotation._id);
      if (known !== undefined) {
        anchored.push({ ...entry, top: known });
      } else if (element !== undefined) {
        // The page has not been rendered yet, so the passage has no rectangle.
        // Estimate down the page from the anchor's offset — a rough guess that
        // stops the rail piling every unrendered note at the same y, and that
        // is replaced by the real position the moment the page paints.
        const fraction = Math.min(
          0.92,
          Math.max(0.04, annotation.anchor.start / 2500),
        );
        anchored.push({
          ...entry,
          top: element.offsetTop + fraction * pageHeight,
        });
      } else {
        anchored.push({ ...entry, top: page * pageHeight });
      }
    }
    return { cards: anchored, unanchored: lost };
  }, [visible, repliesByParent, resolutions, pageCount, pageHeight]);

  const focusPassage = useCallback((annotation: AnnotationView) => {
    setActiveId(annotation._id);
    const element = pageElements.current.get(annotation.anchor.pageIndex);
    element?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);

  const toggleFilter = (type: AnnotationType) =>
    setFilter((previous) => {
      const next = new Set(previous);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });

  // --- render ------------------------------------------------------------
  if (paper === undefined) {
    // The desk being set: a title line arriving and the sheet of the first
    // page already in place, so opening a paper never shows a blank room.
    return (
      <ReaderShell>
        <div
          role="status"
          aria-label="Opening the paper"
          className="mx-auto flex w-full max-w-3xl flex-col items-center gap-6 py-10"
        >
          <span aria-hidden className={`${skeletonClass} h-6 w-2/3 self-start`} />
          <span
            aria-hidden
            className={`${skeletonClass} aspect-[8.5/11] w-full max-w-2xl rounded-[3px] shadow-[var(--shadow-card)]`}
            style={{ animationDelay: "140ms" }}
          />
        </div>
      </ReaderShell>
    );
  }
  if (paper === null) {
    return (
      <ReaderShell>
        <p className="mx-auto mt-20 max-w-prose font-serif text-base leading-relaxed text-ink-muted">
          That paper isn&rsquo;t in a library you can see.
        </p>
      </ReaderShell>
    );
  }

  const counts = new Map<AnnotationType, number>();
  for (const row of rows) {
    if (row.parentId === undefined && !row.deleted) {
      counts.set(row.type, (counts.get(row.type) ?? 0) + 1);
    }
  }

  return (
    <div
      data-sheet={sheet}
      className="fixed inset-0 z-20 flex flex-col bg-page md:left-64"
    >
      {/* Two fixed-height rows rather than one wrapping one: the old header
          grew two or three chip rows tall on a laptop and the margin's cards
          sheared off against its border — the "gross cutoff" of the co-founder
          review. The title row never wraps; the chip band never wraps either,
          it scrolls sideways instead, which on a phone is also a better
          gesture than aiming at a stack. */}
      <header className="shrink-0 border-b border-rule bg-surface">
        <div className="flex items-center gap-x-4 px-4 py-2.5 sm:px-6">
          <Link
            href={`/app/library/${paperId}`}
            className="shrink-0 font-sans text-sm text-accent underline-offset-4 hover:underline"
          >
            ← Paper
          </Link>
          <h1 className="min-w-0 flex-1 truncate font-serif text-lg leading-tight text-ink-strong">
            {paper.title}
          </h1>
          {/* These rows are the annotation query's caller-safe union, not a
              second reconstruction of privacy in the browser: shared notes
              plus this member's own private ones, exactly as the margin got
              them. Keeping the two formats as quiet text controls also keeps
              the reader's header about the paper rather than the machinery. */}
          {annotations !== undefined && (
            <div
              aria-label="Download annotations"
              className="flex shrink-0 items-center gap-1.5"
            >
              <span className="hidden font-sans text-[10px] uppercase tracking-[0.12em] text-ink-faint xl:inline">
                Export
              </span>
              <button
                type="button"
                aria-label="Download annotations as CSV"
                onClick={() =>
                  downloadText(
                    annotationsToCsv(rows),
                    exportFilename(`${paper.title} annotations`, "csv"),
                    "text/csv;charset=utf-8",
                  )
                }
                className="rounded-sm border border-rule px-1.5 py-0.5 font-sans text-[10px] uppercase tracking-[0.1em] text-ink-faint transition-colors hover:border-ink-faint hover:text-accent"
              >
                CSV
              </button>
              <button
                type="button"
                aria-label="Download annotations as JSON"
                onClick={() =>
                  downloadText(
                    annotationsToJson(rows),
                    exportFilename(`${paper.title} annotations`, "json"),
                    "application/json;charset=utf-8",
                  )
                }
                className="rounded-sm border border-rule px-1.5 py-0.5 font-sans text-[10px] uppercase tracking-[0.1em] text-ink-faint transition-colors hover:border-ink-faint hover:text-accent"
              >
                JSON
              </button>
            </div>
          )}
          {/* The chip is the way back to the meeting this reading is for, not
              just a badge: somebody who followed "Read the paper" out of a
              session needs one click to return to it. */}
          {sessionId !== undefined && (
            <Link
              href={`/app/sessions/${sessionId}`}
              aria-label="Back to the session"
              className="shrink-0 rounded-full border border-rule px-2 py-0.5 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint transition-colors hover:border-ink-faint hover:text-accent"
            >
              In session
            </Link>
          )}
          {/* Only rendered where it does anything: in light mode the sheet is
              print-white and a "White page" control would be a lie. */}
          <button
            type="button"
            aria-pressed={sheet === "white"}
            onClick={toggleSheet}
            className={
              "hidden shrink-0 rounded-full border px-2 py-0.5 font-sans text-[10px] uppercase tracking-[0.14em] transition-colors dark:inline-flex " +
              (sheet === "white"
                ? "border-ink-faint text-ink"
                : "border-rule text-ink-faint hover:border-ink-faint hover:text-accent")
            }
          >
            White page
          </button>
          <span className="shrink-0 font-sans text-xs tabular-nums text-ink-faint">
            {pageCount > 0 ? `Page ${currentPage + 1} of ${pageCount}` : "…"}
          </span>
        </div>

        {/* No notes, no filter: a "Show" with nothing after it reads like a
            control that failed to load. */}
        {counts.size > 0 && (
          <div className="flex items-center gap-x-1.5 overflow-x-auto border-t border-rule px-4 py-2 [scrollbar-width:none] sm:px-6 [&::-webkit-scrollbar]:hidden">
            <span className={`${eyebrowClass} mr-1 shrink-0`}>Show</span>
            {ANNOTATION_TYPES.filter(
              (style) => (counts.get(style.value) ?? 0) > 0,
            ).map((style) => {
              const on = filter.size === 0 || filter.has(style.value);
              return (
                <button
                  key={style.value}
                  type="button"
                  // The effective state, not the set membership: with no filter
                  // at all every chip is on, and a row of "off" chips over a
                  // margin showing everything is a lie a screen reader has no
                  // way to see through.
                  aria-pressed={on}
                  onClick={() => toggleFilter(style.value)}
                  style={
                    on
                      ? { color: style.ink, backgroundColor: style.wash }
                      : undefined
                  }
                  className={
                    "shrink-0 whitespace-nowrap rounded-full border px-2.5 py-1 font-sans text-[10px] uppercase tracking-[0.1em] " +
                    "motion-safe:transition-[color,background-color,border-color,transform] motion-safe:duration-200 active:scale-[0.96] " +
                    (on
                      ? "border-transparent"
                      : "border-rule text-ink-faint hover:border-ink-faint hover:text-ink-muted")
                  }
                >
                  {style.label} {counts.get(style.value)}
                </button>
              );
            })}
            {filter.size > 0 && (
              <button
                type="button"
                onClick={() => setFilter(new Set())}
                className="shrink-0 px-1.5 font-sans text-[11px] text-accent underline-offset-4 hover:underline"
              >
                All
              </button>
            )}
          </div>
        )}
      </header>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto overscroll-contain"
        onMouseDown={() => setDraft(null)}
      >
        {/* A breath of page colour under the header, so cards slide beneath
            it instead of shearing off against the border. */}
        <div
          aria-hidden
          className="pointer-events-none sticky top-0 z-10 -mb-5 h-5 bg-gradient-to-b from-page to-transparent"
        />
        <div
          ref={contentRef}
          className="relative mx-auto flex w-full max-w-[1500px] flex-col gap-6 px-4 py-6 lg:flex-row lg:px-8"
        >
          <div
            ref={columnRef}
            className="flex min-w-0 flex-1 flex-col items-center gap-5"
          >
            {doc === null || baseSize === null ? (
              <p className="mt-24 font-sans text-sm text-ink-faint">
                {docFailed
                  ? "That PDF wouldn't open."
                  : paper.hasPdf
                    ? "Opening the paper…"
                    : "There is no PDF on this paper yet."}
              </p>
            ) : (
              Array.from({ length: pageCount }, (_, index) => (
                <PdfPage
                  key={index}
                  doc={doc}
                  pageIndex={index}
                  scale={scale}
                  width={pageWidth}
                  height={pageHeight}
                  active={window_.has(index)}
                  annotations={byPage.get(index) ?? EMPTY}
                  activeId={activeId}
                  composing={draft?.anchor.pageIndex === index}
                  onActivate={setActiveId}
                  onResolved={handleResolved}
                  onDraft={setDraft}
                  registerElement={registerPage}
                />
              ))
            )}
          </div>

          <MarginRail
            cards={cards}
            unanchored={unanchored}
            loading={loading}
            truncated={annotations?.truncated ?? false}
            aligned={aligned}
            originTop={originTop}
            height={columnHeight}
            activeId={activeId}
            onActivate={setActiveId}
            onFocusPassage={focusPassage}
          />

          {draft !== null && (
            <Composer
              paperId={paperId}
              sessionId={sessionId}
              draft={draft}
              onClose={() => setDraft(null)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

const EMPTY: AnnotationView[] = [];

function ReaderShell({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-20 flex flex-col bg-page md:left-64">
      <header className="flex shrink-0 items-center gap-5 border-b border-rule bg-surface px-4 py-2.5 sm:px-6">
        <Link
          href="/app/library"
          className="font-sans text-sm text-accent underline-offset-4 hover:underline"
        >
          ← Library
        </Link>
      </header>
      <div className="flex-1 overflow-y-auto px-6">{children}</div>
    </div>
  );
}
