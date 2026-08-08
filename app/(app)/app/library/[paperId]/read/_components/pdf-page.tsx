"use client";

import type { ResolvedAnchor, TextAnchor, TextLayerIndex } from "@/lib/anchoring";
import {
  createAnchor,
  indexTextLayer,
  layerMatchesExtraction,
  offsetsForRange,
  rangeForOffsets,
  resolveAnchor,
} from "@/lib/anchoring";
import { loadPdfjs, normalizePdfText } from "@/lib/pdf/extract";
import type {
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from "pdfjs-dist/types/src/display/api";
import type { CSSProperties, KeyboardEvent, MouseEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { typeStyle } from "./ontology";
import styles from "./reader.module.css";
import type {
  AnchorState,
  AnnotationId,
  AnnotationView,
  Draft,
  PageResolution,
} from "./types";

/**
 * One page: a canvas of pixels, an invisible text layer over it, and the
 * lab's marks painted in between.
 *
 * The interesting part is the middle one. pdf.js's text layer is what makes a
 * PDF selectable, and it is also — because its spans are the same text items,
 * in the same order, that `lib/pdf/extract.ts` concatenated at ingest — the
 * thing that lets a browser selection become a character range in the page text
 * an anchor addresses. `lib/anchoring/text-layer.ts` does that conversion in
 * both directions, so this component never does arithmetic on offsets itself.
 *
 * Marks are drawn as absolutely-positioned rectangles rather than by wrapping
 * the text, for two reasons. Mutating pdf.js's spans would invalidate the index
 * built from them and break pdf.js's own selection handling; and rectangles can
 * overlap, which annotations on the same sentence routinely do. Overlapping
 * washes would turn a much-discussed paragraph into mud, so each mark also gets
 * a rule under its line, stepped down by how many other marks it sits inside —
 * the way a page annotated by four people in four pencils actually looks.
 */

type PlacedRect = { left: number; top: number; width: number; height: number };

type Mark = {
  id: AnnotationId;
  type: AnnotationView["type"];
  start: number;
  end: number;
  depth: number;
  rects: PlacedRect[];
  /** Found by something other than its recorded offsets or an exact quote. */
  drifted: boolean;
  ambiguous: boolean;
};

/**
 * Re-anchoring is a dynamic program, and `annotations` is a live query result:
 * a colleague writing one note in the session hands this component a brand new
 * array, and without a cache every other note on the page would be re-aligned
 * from scratch to draw the same rectangle it drew a second ago. Filtering the
 * rail by type does the same thing.
 *
 * Keyed by the annotation, its anchor, and a fingerprint of the page text, so
 * an entry can only be reused for a question that has not changed. It is
 * module-level rather than a ref because the reader unmounts a page's contents
 * when it scrolls out of the render window and mounts them again on the way
 * back, and that is exactly when the answers are worth still having.
 */
const RESOLUTIONS = new Map<string, ResolvedAnchor | null>();
const MAX_CACHED_RESOLUTIONS = 800;

/** Cheap and stable: two pages of a paper are never the same length by accident. */
function pageFingerprint(pageText: string): string {
  return `${pageText.length}:${pageText.slice(0, 24)}:${pageText.slice(-24)}`;
}

function cachedResolve(
  id: AnnotationId,
  anchor: TextAnchor,
  pageText: string,
  fingerprint: string,
  trustPosition: boolean,
): ResolvedAnchor | null {
  const key = `${id}|${anchor.start}|${anchor.end}|${trustPosition}|${anchor.quote.length}|${anchor.quote}|${fingerprint}`;
  const hit = RESOLUTIONS.get(key);
  if (hit !== undefined) {
    return hit;
  }
  const resolved = resolveAnchor(anchor, pageText, { trustPosition });
  if (RESOLUTIONS.size >= MAX_CACHED_RESOLUTIONS) {
    // Oldest first — a Map iterates in insertion order — which for a reader
    // scrolled forward through a paper is the pages furthest behind it.
    for (const stale of [...RESOLUTIONS.keys()].slice(0, 200)) {
      RESOLUTIONS.delete(stale);
    }
  }
  RESOLUTIONS.set(key, resolved);
  return resolved;
}

/**
 * A page whose text layer is rendered, indexed, and available to be selected
 * in — keyed by page index.
 *
 * It exists for one case: a selection dragged from one page onto the next. The
 * `mouseup` lands on the page the drag *ended* on, but an annotation is anchored
 * to a single page by schema, and the page it belongs to is the one it started
 * on — which is a different component instance, and not one in this one's tree.
 * So every live page registers itself, and whichever one sees the mouseup looks
 * up the owner and builds the anchor in the owner's coordinates.
 */
type LivePage = {
  pageIndex: number;
  container: HTMLElement;
  wrapper: HTMLDivElement;
  layer: TextLayerIndex;
};
const LIVE_PAGES = new Map<number, LivePage>();

export type PdfPageProps = {
  doc: PDFDocumentProxy;
  pageIndex: number;
  scale: number;
  width: number;
  height: number;
  /** Inside the render window. Pages outside it keep their box and lose their pixels. */
  active: boolean;
  annotations: AnnotationView[];
  activeId: AnnotationId | null;
  /** A composer is already open on this page, so it does not need offering. */
  composing: boolean;
  onActivate: (id: AnnotationId | null) => void;
  onResolved: (pageIndex: number, resolution: PageResolution) => void;
  onDraft: (draft: Draft) => void;
  registerElement: (pageIndex: number, element: HTMLDivElement | null) => void;
};

export function PdfPage({
  doc,
  pageIndex,
  scale,
  width,
  height,
  active,
  annotations,
  activeId,
  composing,
  onActivate,
  onResolved,
  onDraft,
  registerElement,
}: PdfPageProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const hoveredRef = useRef<AnnotationId | null>(null);

  const [layer, setLayer] = useState<TextLayerIndex | null>(null);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [failed, setFailed] = useState(false);
  /**
   * The page text pdf.js's own extraction produces from the same items — the
   * string a stored anchor's offsets are written against. `null` until the
   * layer renders.
   */
  const [extractedLength, setExtractedLength] = useState<number | null>(null);
  /** A selection sitting on this page, waiting for someone to act on it. */
  const [pending, setPending] = useState<Draft | null>(null);

  const setWrapper = useCallback(
    (element: HTMLDivElement | null) => {
      wrapperRef.current = element;
      registerElement(pageIndex, element);
    },
    [pageIndex, registerElement],
  );

  // --- render ------------------------------------------------------------
  useEffect(() => {
    if (!active) {
      return;
    }
    const canvas = canvasRef.current;
    const container = textLayerRef.current;
    if (canvas === null || container === null) {
      return;
    }

    let cancelled = false;
    let task: RenderTask | null = null;
    let page: PDFPageProxy | null = null;

    const run = async () => {
      const pdfjs = await loadPdfjs();
      const loaded = await doc.getPage(pageIndex + 1);
      if (cancelled) {
        // The cleanup below already ran and found `page` still null, so this
        // proxy would hold its bitmaps for as long as the document lived.
        loaded.cleanup();
        return;
      }
      page = loaded;
      const viewport = page.getViewport({ scale });

      // The canvas is drawn at device resolution and sized in CSS pixels, or a
      // paper on a retina screen renders as a photocopy of itself.
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(viewport.width * ratio);
      canvas.height = Math.round(viewport.height * ratio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      task = page.render({
        canvas,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      await task.promise;
      if (cancelled) {
        return;
      }

      const textContent = await page.getTextContent();
      if (cancelled) {
        return;
      }
      container.replaceChildren();
      const textLayer = new pdfjs.TextLayer({
        textContentSource: textContent,
        container,
        viewport,
      });
      await textLayer.render();
      if (cancelled) {
        container.replaceChildren();
        return;
      }

      // What `lib/pdf/extract.ts` would have produced from these same items —
      // the surface every stored offset addresses. Only its length is kept:
      // it is only ever used to decide whether the offsets can be believed.
      let extracted = "";
      for (const item of textContent.items) {
        if ("str" in item) {
          extracted += item.str;
          extracted += " ";
        }
      }
      setExtractedLength(normalizePdfText(extracted).length);
      setLayer(indexTextLayer(container));
    };

    run().catch(() => {
      if (!cancelled) {
        setFailed(true);
      }
    });

    return () => {
      cancelled = true;
      task?.cancel();
      page?.cleanup();
      container.replaceChildren();
      setLayer(null);
      setExtractedLength(null);
      setMarks([]);
      setPending(null);
    };
  }, [active, doc, pageIndex, scale]);

  // Announce this page as somewhere a selection can live. See `LIVE_PAGES`.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    const container = textLayerRef.current;
    if (layer === null || wrapper === null || container === null) {
      return;
    }
    LIVE_PAGES.set(pageIndex, { pageIndex, container, wrapper, layer });
    return () => {
      if (LIVE_PAGES.get(pageIndex)?.layer === layer) {
        LIVE_PAGES.delete(pageIndex);
      }
    };
  }, [layer, pageIndex]);

  // Give the bitmap back when the page leaves the window. The box stays, so
  // scroll position and every rail card below it hold still.
  useEffect(() => {
    if (active) {
      return;
    }
    const canvas = canvasRef.current;
    if (canvas !== null) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }, [active]);

  // --- place the lab's marks --------------------------------------------
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (layer === null || wrapper === null) {
      return;
    }
    const bounds = wrapper.getBoundingClientRect();
    const pageText = layer.index.text;
    const fingerprint = pageFingerprint(pageText);
    // If the DOM did not reconstruct the string extraction wrote, the stored
    // offsets address something else and the position fast path would land on
    // whatever sits there. Nothing is said about it; the quote and context
    // selectors do the work instead.
    const trustPosition =
      extractedLength === null ||
      layerMatchesExtraction(layer, extractedLength);

    const placed: Mark[] = [];
    const orphaned: AnnotationId[] = [];
    const positions = new Map<AnnotationId, number>();
    const states = new Map<AnnotationId, AnchorState>();

    for (const annotation of annotations) {
      const resolved = cachedResolve(
        annotation._id,
        annotation.anchor,
        pageText,
        fingerprint,
        trustPosition,
      );
      const range =
        resolved === null
          ? null
          : rangeForOffsets(layer, resolved.start, resolved.end);
      const rects =
        range === null
          ? []
          : [...range.getClientRects()]
              .filter((rect) => rect.width > 0.5 && rect.height > 0.5)
              .map((rect) => ({
                left: rect.left - bounds.left,
                top: rect.top - bounds.top,
                width: rect.width,
                height: rect.height,
              }));

      if (resolved === null || rects.length === 0) {
        orphaned.push(annotation._id);
        continue;
      }
      // "position" is the recorded offsets holding the recorded quote and
      // "quote" is the only copy of it on the page; both are the passage
      // itself. Anything else is a passage the reader had to reason its way
      // back to, and the mark says so.
      const drifted = resolved.method !== "position" && resolved.method !== "quote";
      placed.push({
        id: annotation._id,
        type: annotation.type,
        start: resolved.start,
        end: resolved.end,
        depth: 0,
        rects,
        drifted,
        ambiguous: resolved.ambiguous,
      });
      positions.set(annotation._id, wrapper.offsetTop + (rects[0]?.top ?? 0));
      states.set(annotation._id, {
        method: resolved.method,
        confidence: resolved.confidence,
        ambiguous: resolved.ambiguous,
      });
    }

    placed.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 0; i < placed.length; i++) {
      const mark = placed[i] as Mark;
      let depth = 0;
      for (let j = 0; j < i; j++) {
        const earlier = placed[j] as Mark;
        if (earlier.end > mark.start && earlier.start < mark.end) {
          depth++;
        }
      }
      // Four pencils is as many as a line can hold before the rules collide.
      mark.depth = Math.min(depth, 3);
    }

    setMarks(placed);
    onResolved(pageIndex, { positions, states, orphaned });
  }, [layer, extractedLength, annotations, pageIndex, onResolved]);

  // --- selection ---------------------------------------------------------
  /**
   * The current selection as a draft annotation, or `null` if there is nothing
   * in it to annotate.
   *
   * An annotation belongs to one page, and the page it belongs to is the one
   * the selection *began* on — which is not necessarily this one. A drag from
   * the bottom of page 4 onto page 5 releases the mouse over page 5, and page 4
   * never hears about it. So the owner is looked up rather than assumed, and
   * the part of the selection that runs onto the following page is clamped away
   * by `offsetsForRange`. The alternative — the previous behaviour — was for
   * the drag to do nothing at all and say nothing about why.
   */
  const draftFromSelection = useCallback((): Draft | null => {
    const selection = window.getSelection();
    if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
      return null;
    }
    const range = selection.getRangeAt(0);
    let owner: LivePage | undefined;
    for (const candidate of LIVE_PAGES.values()) {
      if (candidate.container.contains(range.startContainer)) {
        owner = candidate;
        break;
      }
    }
    if (owner === undefined) {
      return null;
    }

    const offsets = offsetsForRange(owner.layer, range);
    if (offsets === null) {
      return null;
    }
    const anchor = createAnchor(
      owner.layer.index.text,
      offsets.start,
      offsets.end,
      owner.pageIndex,
    );
    if (anchor === null) {
      return null;
    }

    const bounds = owner.wrapper.getBoundingClientRect();
    const selectionBox = range.getBoundingClientRect();
    return {
      anchor,
      top:
        owner.wrapper.offsetTop +
        Math.min(
          owner.wrapper.offsetHeight,
          selectionBox.bottom - bounds.top,
        ) +
        10,
      left:
        owner.wrapper.offsetLeft +
        Math.max(0, selectionBox.left - bounds.left),
    };
  }, []);

  const captureSelection = useCallback(() => {
    const draft = draftFromSelection();
    if (draft !== null) {
      onDraft(draft);
      setPending(null);
    }
  }, [draftFromSelection, onDraft]);

  // The keyboard path. Shift-arrow through the text layer moves the selection
  // without any pointer event, and caret browsing makes that the way a
  // keyboard-only reader selects a passage at all — so the offer to annotate it
  // has to be a thing you can tab to, not a thing that appears on mouseup.
  useEffect(() => {
    if (layer === null) {
      return;
    }
    const container = textLayerRef.current;
    // A drag already ends in the composer, and a button following the cursor
    // across the paragraph being highlighted would be in the way of the one
    // gesture it is trying to help with.
    let dragging = false;

    const onSelectionChange = () => {
      const selection = document.getSelection();
      // Cheap rejection first: this fires on every caret move in the document.
      if (
        dragging ||
        selection === null ||
        selection.isCollapsed ||
        container === null ||
        !selection.containsNode(container, true)
      ) {
        return;
      }
      const draft = draftFromSelection();
      setPending(
        draft !== null && draft.anchor.pageIndex === pageIndex ? draft : null,
      );
    };
    const onDown = (event: globalThis.MouseEvent) => {
      if ((event.target as HTMLElement | null)?.closest?.("[data-annotate]")) {
        return;
      }
      dragging = true;
      setPending(null);
    };
    const onUp = () => {
      dragging = false;
    };

    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("mouseup", onUp, true);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("mouseup", onUp, true);
    };
  }, [draftFromSelection, layer, pageIndex]);

  const handleMove = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const wrapper = wrapperRef.current;
      if (wrapper === null || marks.length === 0) {
        return;
      }
      const bounds = wrapper.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      let hit: AnnotationId | null = null;
      for (const mark of marks) {
        for (const rect of mark.rects) {
          if (
            x >= rect.left &&
            x <= rect.left + rect.width &&
            y >= rect.top &&
            y <= rect.top + rect.height
          ) {
            hit = mark.id;
          }
        }
      }
      if (hit !== hoveredRef.current) {
        hoveredRef.current = hit;
        onActivate(hit);
      }
    },
    [marks, onActivate],
  );

  const handleLeave = useCallback(() => {
    if (hoveredRef.current !== null) {
      hoveredRef.current = null;
      onActivate(null);
    }
  }, [onActivate]);

  const pageStyle = {
    width,
    height,
    "--total-scale-factor": String(scale),
  } as CSSProperties;

  return (
    <div
      ref={setWrapper}
      data-page={pageIndex}
      // Focusable so a keyboard reader can reach the page at all: pdf.js's
      // text layer is a pile of positioned spans with nothing tabbable in it,
      // and caret browsing needs somewhere to start.
      tabIndex={0}
      role="group"
      aria-label={`Page ${pageIndex + 1}`}
      // A sheet of paper on the desk, not a rectangle in a void: a hair of
      // radius and a soft drop shadow instead of the old hard 1px ledge.
      className={`${styles.page} shrink-0 rounded-[3px] border border-rule bg-surface shadow-[var(--shadow-card)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent`}
      style={pageStyle}
      onMouseUp={captureSelection}
      onKeyUp={(event: KeyboardEvent<HTMLDivElement>) => {
        // Shift-arrow selection never fires a mouseup.
        if (event.shiftKey) {
          captureSelection();
        }
      }}
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
    >
      <canvas ref={canvasRef} className={styles.canvas} />

      <div className={styles.overlay} aria-hidden="true">
        {marks.map((mark) => {
          const style = typeStyle(mark.type);
          const isActive = activeId === mark.id;
          // A note whose passage had to be reasoned back to is drawn in the
          // same ink but with a broken rule and a fainter wash — the mark of a
          // pencil line redrawn on a photocopy rather than the original. One
          // that could not be told from another passage loses the ink too.
          const ink = mark.ambiguous ? "var(--ink-faint)" : style.ink;
          const rule = isActive ? 2.5 : 1.5;
          return (
            <div key={mark.id}>
              {mark.rects.map((rect, index) => (
                <span key={index}>
                  <span
                    style={{
                      position: "absolute",
                      left: rect.left,
                      top: rect.top,
                      width: rect.width,
                      height: rect.height,
                      background: style.wash,
                      opacity: mark.drifted
                        ? isActive
                          ? 0.55
                          : 0.25
                        : isActive
                          ? 1
                          : 0.5,
                      borderRadius: 2,
                      transition: "opacity 120ms",
                    }}
                  />
                  <span
                    style={{
                      position: "absolute",
                      left: rect.left,
                      top: rect.top + rect.height - 2 - mark.depth * 3,
                      width: rect.width,
                      height: mark.drifted ? 0 : rule,
                      borderTop: mark.drifted
                        ? `${rule}px dashed ${ink}`
                        : undefined,
                      background: mark.drifted ? undefined : ink,
                      opacity: isActive ? 1 : 0.75,
                    }}
                  />
                </span>
              ))}
            </div>
          );
        })}
      </div>

      <div ref={textLayerRef} className={styles.textLayer} />

      {pending !== null && !composing && (
        <button
          type="button"
          data-annotate=""
          // Losing the selection to the button's own focus would defeat it.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onDraft(pending);
            setPending(null);
          }}
          style={{
            top: Math.max(0, pending.top - (wrapperRef.current?.offsetTop ?? 0)),
            left: Math.max(
              0,
              pending.left - (wrapperRef.current?.offsetLeft ?? 0),
            ),
          }}
          className="pop-in absolute z-10 rounded-full border border-rule bg-surface px-2.5 py-1 font-sans text-[11px] text-accent shadow-[var(--shadow-lift)] hover:underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Annotate selection
        </button>
      )}

      {!active && (
        <span className="pointer-events-none absolute inset-x-0 top-1/2 text-center font-sans text-xs text-ink-faint">
          {failed ? "This page wouldn't render." : `Page ${pageIndex + 1}`}
        </span>
      )}
      {active && failed && (
        <span className="pointer-events-none absolute inset-x-0 top-1/2 text-center font-sans text-xs text-ink-faint">
          This page wouldn&rsquo;t render.
        </span>
      )}
    </div>
  );
}
