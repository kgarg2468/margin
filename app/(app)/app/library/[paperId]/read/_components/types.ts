import type { api } from "@/convex/_generated/api";
import type { AnchorMethod, TextAnchor } from "@/lib/anchoring";
import type { FunctionReturnType } from "convex/server";

/** The margin of one paper, exactly as `convex/annotations.ts` hands it over. */
export type AnnotationList = FunctionReturnType<
  typeof api.annotations.listForPaper
>;

/** One row of it. */
export type AnnotationView = AnnotationList["annotations"][number];

export type AnnotationId = AnnotationView["_id"];

/**
 * A selection waiting to become an annotation. `top`/`left` are in the
 * coordinates of the reader's scrolling content, so the composer can be placed
 * beside the passage and stay there while the page scrolls under it.
 */
export type Draft = {
  anchor: TextAnchor;
  top: number;
  left: number;
  /**
   * The passage was chosen, or the offer to annotate it accepted, from the
   * keyboard.
   *
   * Carried this far because the composer is the one sheet in the app that is
   * mounted already open: Base UI reports the event that opens a popover, and
   * a popover nobody opened has no event to report. Without this the motion
   * budget's "keyboard-triggered surfaces render instantly" has a hole at the
   * exact surface the reader's keyboard path leads to.
   */
  fromKeyboard: boolean;
};

/**
 * Where the passage a composer is anchored to actually sits, in its own page's
 * coordinates.
 *
 * Reported by the page rather than remembered from the selection, and
 * re-reported whenever the page re-lays its text — which is what lets the
 * composer stay beside its passage across a zoom, where the coordinates frozen
 * at selection time would have stranded it.
 *
 * The page's, not the reader's, and stamped with the size it was measured at.
 * Between a zoom and the new text layer landing — or forever, for a page that
 * left the render window on the way — this is the only rectangle the composer
 * has, and a rectangle in the reader's coordinates would by then be pointing at
 * a place the page has moved away from. Against the page, the correction is
 * arithmetic: see `draftAnchorBox`.
 */
export type DraftBox = {
  pageIndex: number;
  top: number;
  left: number;
  width: number;
  height: number;
  /** The scale the page was drawn at when this was measured. */
  scale: number;
};

/**
 * How an annotation's passage was found again on the page it was written on.
 *
 * `resolveAnchor` already knows all of this; the reason it travels up to the
 * rail is that a note re-anchored by fuzzy alignment at 0.81 is a different
 * object to one that landed on its recorded offset, and a margin that draws
 * them identically is quietly asserting a confidence it does not have.
 */
export type AnchorState = {
  method: AnchorMethod;
  confidence: number;
  /** The passage could not be told apart from another one on the page. */
  ambiguous: boolean;
};

/**
 * Where a passage sits, in the reader's content coordinates — enough to draw a
 * line to it from the margin and no more.
 *
 * `gutterX` is the right edge of the *page*, not of the passage: the connector
 * belongs in the gutter, and a line from the sentence itself would cross the
 * paragraph it is about. See `lib/rail/connector.ts`.
 */
export type PassagePoint = {
  top: number;
  bottom: number;
  gutterX: number;
};

/** Where a page put each of its annotations, and which ones it could not place. */
export type PageResolution = {
  positions: Map<AnnotationId, number>;
  points: Map<AnnotationId, PassagePoint>;
  states: Map<AnnotationId, AnchorState>;
  orphaned: AnnotationId[];
  /**
   * The scale the page was drawn at when this was measured.
   *
   * `positions` and `points` are pixels, and pixels expire. A page outside the
   * render window has no text layer to re-measure, so after a zoom it would go
   * on reporting where its passages were at the old size — indefinitely, if the
   * reader never scrolls back to it. `states` and `orphaned` are about text
   * rather than pixels and do not expire.
   */
  scale: number;
};
