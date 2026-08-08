"use client";

import type { TextLayerIndex } from "@/lib/anchoring";
import {
  createAnchor,
  indexTextLayer,
  offsetsForRange,
  rangeForOffsets,
  resolveAnchor,
} from "@/lib/anchoring";
import { loadPdfjs } from "@/lib/pdf/extract";
import type {
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from "pdfjs-dist/types/src/display/api";
import type { CSSProperties, KeyboardEvent, MouseEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { typeStyle } from "./ontology";
import styles from "./reader.module.css";
import type { AnnotationId, AnnotationView, Draft, PageResolution } from "./types";

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
};

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
      page = await doc.getPage(pageIndex + 1);
      if (cancelled) {
        return;
      }
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
      setMarks([]);
    };
  }, [active, doc, pageIndex, scale]);

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

    const placed: Mark[] = [];
    const orphaned: AnnotationId[] = [];
    const positions = new Map<AnnotationId, number>();

    for (const annotation of annotations) {
      const resolved = resolveAnchor(annotation.anchor, pageText);
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
      placed.push({
        id: annotation._id,
        type: annotation.type,
        start: resolved.start,
        end: resolved.end,
        depth: 0,
        rects,
      });
      positions.set(annotation._id, wrapper.offsetTop + (rects[0]?.top ?? 0));
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
    onResolved(pageIndex, { positions, orphaned });
  }, [layer, annotations, pageIndex, onResolved]);

  // --- selection ---------------------------------------------------------
  const captureSelection = useCallback(() => {
    const wrapper = wrapperRef.current;
    const container = textLayerRef.current;
    if (layer === null || wrapper === null || container === null) {
      return;
    }
    const selection = window.getSelection();
    if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
      return;
    }
    const range = selection.getRangeAt(0);
    // A selection is anchored to the page it began on; one dragged across a
    // page break is clamped to this page's share of it.
    if (!container.contains(range.startContainer)) {
      return;
    }
    const offsets = offsetsForRange(layer, range);
    if (offsets === null) {
      return;
    }
    const anchor = createAnchor(
      layer.index.text,
      offsets.start,
      offsets.end,
      pageIndex,
    );
    if (anchor === null) {
      return;
    }

    const bounds = wrapper.getBoundingClientRect();
    const selectionBox = range.getBoundingClientRect();
    onDraft({
      anchor,
      top: wrapper.offsetTop + (selectionBox.bottom - bounds.top) + 10,
      left: wrapper.offsetLeft + Math.max(0, selectionBox.left - bounds.left),
    });
  }, [layer, onDraft, pageIndex]);

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
      className={`${styles.page} shrink-0 border border-rule bg-surface shadow-[0_1px_0_var(--rule)]`}
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
                      opacity: isActive ? 1 : 0.5,
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
                      height: isActive ? 2.5 : 1.5,
                      background: style.ink,
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
