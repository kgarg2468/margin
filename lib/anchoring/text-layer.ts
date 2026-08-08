/**
 * The DOM adapter for `segments.ts`.
 *
 * pdf.js's `TextLayer` renders one `<span>` per text item, in the order the
 * items came out of the page — the same order, and the same strings, that
 * `lib/pdf/extract.ts` concatenated at ingest. So walking the text nodes of a
 * rendered text layer reconstructs the page text an anchor addresses, and the
 * walk can record where every character of it lives in the DOM.
 *
 * A break is inserted whenever the parent element changes, which is once per
 * item — matching extraction's `text += item.str; text += " ";`. Text nodes
 * inside the same span (which pdf.js does not produce, but a browser
 * normalisation might) stay joined.
 *
 * Everything interesting is in `segments.ts`, which has no DOM in it and is
 * where the tests are. This file only knows how to find text nodes.
 */

import type { Segment, SegmentIndex } from "./segments";
import { indexSegments, offsetInText, pointInSegments } from "./segments";

export type TextLayerIndex = {
  index: SegmentIndex;
  /** One text node per segment, in document order. */
  nodes: Text[];
  segmentOf: Map<Text, number>;
};

function firstTextIn(node: Node): Text | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return node as Text;
  }
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  return walker.nextNode() as Text | null;
}

function lastTextIn(node: Node): Text | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return node as Text;
  }
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  for (
    let current = walker.nextNode();
    current !== null;
    current = walker.nextNode()
  ) {
    last = current as Text;
  }
  return last;
}

/** Read a rendered text layer into the page text plus its offset map. */
export function indexTextLayer(container: HTMLElement): TextLayerIndex {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const segments: Segment[] = [];
  const nodes: Text[] = [];
  const segmentOf = new Map<Text, number>();
  let previousParent: Element | null = null;

  for (
    let current = walker.nextNode();
    current !== null;
    current = walker.nextNode()
  ) {
    const node = current as Text;
    const parent = node.parentElement;
    // pdf.js's selection sentinel. It carries no characters of the page.
    if (parent !== null && parent.classList.contains("endOfContent")) {
      continue;
    }
    segmentOf.set(node, segments.length);
    segments.push({ text: node.data, break: parent !== previousParent });
    nodes.push(node);
    previousParent = parent;
  }

  return { index: indexSegments(segments), nodes, segmentOf };
}

/**
 * Whether a rendered layer reconstructs the page text an anchor's offsets
 * were written against.
 *
 * `indexTextLayer` reads the DOM, and the DOM is not guaranteed to hold the
 * text items extraction saw: a browser can merge or normalise a text node, an
 * extension can inject one, a pdf.js release can change where it splits an
 * item. When the two disagree, a `TextPositionSelector`'s offsets address a
 * different string — and the position fast path in `resolveAnchor` would land
 * on whatever happens to sit at that offset and call it certain. Comparing
 * lengths is the cheap, conservative version of the check: equal lengths do
 * not prove the strings are equal, but unequal lengths prove they are not,
 * and that is the direction that costs something.
 *
 * A mismatch is not an error and nothing is logged. The quote and context
 * selectors do not depend on offsets meaning anything, so the reader simply
 * resolves without the fast path and the reader's user never finds out.
 */
export function layerMatchesExtraction(
  layer: TextLayerIndex,
  extractedLength: number,
): boolean {
  return layer.index.text.length === extractedLength;
}

type Point = { segment: number; charOffset: number };

/**
 * A DOM range endpoint as a segment point.
 *
 * Browsers hand back both kinds of boundary: inside a text node, or between the
 * children of an element (which is what a triple-click or a drag past the end
 * of a line produces). The element case is resolved by looking for the nearest
 * text node on the side the endpoint is facing.
 */
function pointFor(
  layer: TextLayerIndex,
  node: Node,
  offset: number,
  side: "start" | "end",
): Point | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const segment = layer.segmentOf.get(node as Text);
    return segment === undefined ? null : { segment, charOffset: offset };
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }

  const children = node.childNodes;
  const forward = (): Point | null => {
    for (let i = offset; i < children.length; i++) {
      const text = firstTextIn(children[i] as Node);
      const segment = text === null ? undefined : layer.segmentOf.get(text);
      if (segment !== undefined) {
        return { segment, charOffset: 0 };
      }
    }
    return null;
  };
  const backward = (): Point | null => {
    for (let i = Math.min(offset, children.length) - 1; i >= 0; i--) {
      const text = lastTextIn(children[i] as Node);
      const segment = text === null ? undefined : layer.segmentOf.get(text);
      if (segment !== undefined && text !== null) {
        return { segment, charOffset: text.data.length };
      }
    }
    return null;
  };

  return side === "start"
    ? (forward() ?? backward())
    : (backward() ?? forward());
}

/**
 * A DOM range as a half-open range of the page text.
 *
 * An endpoint outside this text layer is clamped to its edge, so a selection
 * dragged across a page boundary still yields the part of it that belongs to
 * this page. `null` means the range does not touch this layer at all.
 */
export function offsetsForRange(
  layer: TextLayerIndex,
  range: Range,
): { start: number; end: number } | null {
  const startPoint = pointFor(
    layer,
    range.startContainer,
    range.startOffset,
    "start",
  );
  const endPoint = pointFor(layer, range.endContainer, range.endOffset, "end");
  if (startPoint === null && endPoint === null) {
    return null;
  }

  const start =
    startPoint === null
      ? 0
      : offsetInText(
          layer.index,
          startPoint.segment,
          startPoint.charOffset,
          "start",
        );
  const end =
    endPoint === null
      ? layer.index.text.length
      : offsetInText(layer.index, endPoint.segment, endPoint.charOffset, "end");

  if (end <= start) {
    return null;
  }
  return { start, end };
}

/**
 * The inverse: a half-open range of the page text as a DOM range, for painting
 * a stored annotation back onto the page.
 */
export function rangeForOffsets(
  layer: TextLayerIndex,
  start: number,
  end: number,
): Range | null {
  const from = pointInSegments(layer.index, start);
  const to = pointInSegments(layer.index, end - 1);
  if (from === null || to === null) {
    return null;
  }
  const startNode = layer.nodes[from.segment];
  const endNode = layer.nodes[to.segment];
  if (startNode === undefined || endNode === undefined) {
    return null;
  }

  const range = document.createRange();
  try {
    range.setStart(startNode, Math.min(from.offset, startNode.data.length));
    range.setEnd(endNode, Math.min(to.offset + 1, endNode.data.length));
  } catch {
    // A stale index against a re-rendered layer. The caller re-indexes rather
    // than crashing the page.
    return null;
  }
  return range;
}
