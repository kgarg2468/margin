"use client";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { recoverAnchor } from "@/lib/anchoring";
import { annotationsToCsv, annotationsToJson } from "@/lib/export/csv";
import { downloadText, exportFilename } from "@/lib/export/download";
import { pdfAuthHeaders, pdfEndpoint } from "@/lib/pdf/delivery";
import { loadPdfjs, normalizePdfText } from "@/lib/pdf/extract";
import { eyebrowClass, skeletonClass } from "@/lib/ui";
import { useAuthToken } from "@convex-dev/auth/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
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
  DraftBox,
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

/**
 * A beat before the link goes out.
 *
 * Moving the pointer from a highlight to the card about it crosses the
 * gutter, which belongs to neither — the page fires `mouseleave`, the card
 * has not fired `mouseenter` yet, and the link dies halfway through a journey
 * the reader is deliberately making. Anything that activates in the meantime
 * cancels the clear, so the only thing this delays is actually leaving.
 */
const LINK_GRACE_MS = 120;

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
  const [window_, setWindow] = useState<Set<number>>(new Set([0, 1, 2]));
  const [currentPage, setCurrentPage] = useState(0);
  const [activeId, setActiveId] = useState<AnnotationId | null>(null);
  const [filter, setFilter] = useState<Set<AnnotationType>>(new Set());
  const [draft, setDraft] = useState<Draft | null>(null);
  // Held but not yet read: the composer is still placed from the coordinates
  // frozen at selection time, and anchoring it to this re-measured box is the
  // next step. Kept here anyway because the measuring is the page's to do and
  // the box has to land somewhere the composer can reach. Both suppressions
  // come off the moment something reads it.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_draftBox, setDraftBox] = useState<DraftBox | null>(null);
  const [resolutions, setResolutions] = useState<Map<number, PageResolution>>(
    new Map(),
  );

  const handleDraftBox = useCallback(
    (
      pageIndex: number,
      box: { top: number; left: number; width: number; height: number } | null,
    ) => {
      setDraftBox((previous) => {
        if (box === null) {
          // Only the page the composer is anchored to may retract the box; the
          // other thirty-six report null on every mount and would otherwise
          // clobber it.
          return previous?.pageIndex === pageIndex ? null : previous;
        }
        return { pageIndex, ...box };
      });
    },
    [],
  );

  useEffect(() => {
    if (draft === null) {
      setDraftBox(null);
    }
  }, [draft]);

  // Every activation in the reader goes through this rather than through
  // `setActiveId`, so that the gutter — which fires nobody's `mouseenter` —
  // cannot put the link out mid-journey. See `LINK_GRACE_MS`.
  const clearing = useRef<number | null>(null);
  const activate = useCallback((id: AnnotationId | null) => {
    if (clearing.current !== null) {
      window.clearTimeout(clearing.current);
      clearing.current = null;
    }
    if (id === null) {
      clearing.current = window.setTimeout(() => {
        clearing.current = null;
        setActiveId(null);
      }, LINK_GRACE_MS);
      return;
    }
    setActiveId(id);
  }, []);
  useEffect(
    () => () => {
      if (clearing.current !== null) {
        window.clearTimeout(clearing.current);
      }
    },
    [],
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

  // --- passages that moved to another page --------------------------------
  //
  // An anchor names the page it was written on, and `resolveAnchor` looks for
  // it there and nowhere else. That is right for a version of record and wrong
  // for everything else: a preprint replaced by the published copy, a PDF
  // re-uploaded from another mirror, a template that runs two lines longer per
  // page. The passage is still in the paper — often still on screen — and the
  // note is reported orphaned because it is looking one page too far back.
  //
  // So a miss on the pinned page is the trigger to try the pages beside it.
  // Nothing here runs speculatively: the pinned page has to have rendered,
  // resolved, and failed first, and then at most four neighbouring pages are
  // read. `lib/anchoring/recover.ts` holds the rule; this holds the pdf.js.
  //
  // What is *not* done is writing the new page index back to the annotation.
  // The stored anchor still says where the note was written, which is the true
  // thing about it; where it turns up today is a fact about this file, and this
  // file can be replaced again next week.
  const pageTexts = useRef(new Map<number, string>());
  const attempted = useRef(new Set<AnnotationId>());
  /** Where an orphan turned up, or `null` for one that stayed lost. */
  const [foundOn, setFoundOn] = useState<Map<AnnotationId, number | null>>(
    new Map(),
  );

  /**
   * The document every cache and every answer below is about.
   *
   * A recovery is a claim about one file's pagination, and it takes as long as
   * pdf.js takes to read four pages — long enough for the PDF underneath to be
   * replaced while it runs. Everything that lands late is checked against this
   * before it is believed.
   */
  const currentDoc = useRef<PDFDocumentProxy | null>(null);

  // A different document is a different pagination, so none of it carries over.
  // Declared above the recovery effect so it runs first on the commit that
  // swaps the file: work still in flight is holding the old proxy, and by the
  // time it comes back this ref already disagrees with it.
  useEffect(() => {
    currentDoc.current = doc;
    pageTexts.current.clear();
    attempted.current.clear();
    setFoundOn(new Map());
  }, [doc]);

  useEffect(() => {
    if (doc === null || pageCount === 0) {
      return;
    }
    const orphans = visible.filter(
      (annotation) =>
        !annotation.deleted &&
        !attempted.current.has(annotation._id) &&
        (resolutions
          .get(annotation.anchor.pageIndex)
          ?.orphaned.includes(annotation._id) ??
          false),
    );
    if (orphans.length === 0) {
      return;
    }
    // Claimed up front rather than one at a time, because this effect re-runs
    // every time any page resolves — which, during a scroll, is constantly —
    // and two passes racing on the same note would read the same pages twice.
    for (const annotation of orphans) {
      attempted.current.add(annotation._id);
    }

    const loadPageText = async (pageIndex: number): Promise<string | null> => {
      if (currentDoc.current !== doc) {
        // The file this was asked about is gone. Reporting every page
        // unreadable winds the search down at the next ring rather than
        // reading four more pages off a document being torn down.
        return null;
      }
      const held = pageTexts.current.get(pageIndex);
      if (held !== undefined) {
        return held;
      }
      try {
        const page = await doc.getPage(pageIndex + 1);
        const content = await page.getTextContent();
        let text = "";
        for (const item of content.items) {
          if ("str" in item) {
            text += item.str;
            text += " ";
          }
        }
        // The same two steps `lib/pdf/extract.ts` took at ingest, in the same
        // order. They have to be: a quote is searched for in this string, and
        // it came out of that one.
        //
        // The page proxy is deliberately not cleaned up. A neighbour of a page
        // on screen is usually a page the reader is itself rendering, pdf.js
        // hands back the same proxy for both, and cleaning it here would pull
        // the operator list out from under a live canvas.
        const extracted = normalizePdfText(text);
        // Checked again, because the swap can land during the read above. This
        // cache is keyed by page index alone, so one late write would leave the
        // *new* document holding a page of the old one's text — every later
        // recovery in this paper searching a string that is not in the file.
        if (currentDoc.current === doc) {
          pageTexts.current.set(pageIndex, extracted);
        }
        return extracted;
      } catch {
        // One unreadable page is not a reason to abandon the other three.
        return null;
      }
    };

    // No cancellation flag on this one. Every other async effect in the reader
    // has one, but here the work is already claimed: dropping a recovery in
    // flight because a page below happened to finish rendering would strand
    // that note as orphaned for the rest of the session.
    //
    // Which is why the guard is on the *document* rather than on this effect
    // running again. A re-run is the same question about the same file and its
    // answer is still good; a new file is a different question, and an answer
    // carrying the old pagination would put the note on the wrong page of the
    // paper now on screen and tell the reader, in so many words, that it found
    // it there. Nothing is stranded by dropping it: the effect above cleared
    // `attempted` on the same commit, so the new document asks again.
    void (async () => {
      for (const annotation of orphans) {
        const found = await recoverAnchor(annotation.anchor, loadPageText, {
          pageCount,
        });
        if (currentDoc.current !== doc) {
          return;
        }
        setFoundOn((previous) => {
          const next = new Map(previous);
          next.set(annotation._id, found?.pageIndex ?? null);
          return next;
        });
      }
    })();
  }, [doc, pageCount, visible, resolutions]);

  /** The page a note's passage is actually on, which is usually its own. */
  const pageOf = useCallback(
    (annotation: AnnotationView): number =>
      foundOn.get(annotation._id) ?? annotation.anchor.pageIndex,
    [foundOn],
  );

  // The pages these notes were recovered onto must not believe their recorded
  // offsets: those address a different page's text. See `PdfPage`.
  const recovered = useMemo(() => {
    const ids = new Set<AnnotationId>();
    for (const [id, page] of foundOn) {
      if (page !== null) {
        ids.add(id);
      }
    }
    return ids;
  }, [foundOn]);

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
      // A note whose passage was found one page over is handed to *that* page
      // to draw. It is the page holding the sentence, and it is the only one
      // with a rectangle to put the mark on.
      const page = pageOf(row);
      const list = map.get(page);
      if (list === undefined) {
        map.set(page, [row]);
      } else {
        list.push(row);
      }
    }
    return map;
  }, [visible, pageOf]);

  const { cards, unanchored } = useMemo(() => {
    const anchored: RailCard[] = [];
    const lost: RailCard[] = [];
    for (const annotation of visible) {
      const page = pageOf(annotation);
      const resolution = resolutions.get(page);
      const element = pageElements.current.get(page);
      const entry = {
        annotation,
        replies: repliesByParent.get(annotation._id) ?? [],
        top: 0,
        state: resolution?.states.get(annotation._id),
        passage: resolution?.points.get(annotation._id),
        // Only when it is somewhere other than where it was written: the rail
        // says so beside the card, and has nothing to say in the ordinary case.
        ...(page === annotation.anchor.pageIndex
          ? {}
          : { foundOnPage: page }),
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
  }, [visible, repliesByParent, resolutions, pageCount, pageHeight, pageOf]);

  const focusPassage = useCallback(
    (annotation: AnnotationView) => {
      activate(annotation._id);
      const element = pageElements.current.get(pageOf(annotation));
      element?.scrollIntoView({ block: "center", behavior: "smooth" });
    },
    [activate, pageOf],
  );

  /**
   * Following a notification.
   *
   * A notification is a pointer at one note, and landing somebody at the top
   * of a forty-page paper and inviting them to find it is not delivery. The
   * `?note=` parameter carries which one, and this waits for the paper to have
   * actually rendered the page it is on before scrolling — the pages arrive
   * asynchronously, so the first pass usually has nowhere to scroll *to*, and
   * a version that gave up after one attempt silently did nothing about half
   * the time.
   *
   * A reply focuses its parent's card, because that is where the margin draws
   * the thread it belongs to.
   *
   * Read once from `window.location` rather than through `useSearchParams`,
   * which would opt this route out of static rendering for a question only
   * ever asked in a browser — the same reason `LabProvider` reads the invite
   * code the way it does.
   */
  const [requestedNote, setRequestedNote] = useState<string | null>(null);
  useEffect(() => {
    setRequestedNote(
      new URL(window.location.href).searchParams.get("note"),
    );
  }, []);

  useEffect(() => {
    if (requestedNote === null) {
      return;
    }
    const target = rows.find((row) => row._id === requestedNote);
    if (target === undefined) {
      return;
    }
    const card =
      target.parentId === undefined
        ? target
        : (rows.find((row) => row._id === target.parentId) ?? target);
    if (pageElements.current.get(pageOf(card)) === undefined) {
      // The page it lives on has not been laid out yet. Another render will
      // come — resolutions and page geometry both land later — and this runs
      // again then.
      return;
    }

    focusPassage(card);
    setRequestedNote(null);
    // Spend the parameter, so a reload is a plain reading of the paper rather
    // than a second jump to a note the reader has already dealt with.
    const url = new URL(window.location.href);
    url.searchParams.delete("note");
    window.history.replaceState(
      null,
      "",
      url.pathname + url.search + url.hash,
    );
  }, [
    requestedNote,
    rows,
    pageCount,
    pageHeight,
    resolutions,
    focusPassage,
    pageOf,
  ]);

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
                  recovered={recovered}
                  activeId={activeId}
                  draft={draft?.anchor.pageIndex === index ? draft : null}
                  onDraftBox={handleDraftBox}
                  onActivate={activate}
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
            columnHeight={columnHeight}
            activeId={activeId}
            onActivate={activate}
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
