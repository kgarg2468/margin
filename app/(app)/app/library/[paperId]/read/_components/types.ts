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

/** Where a page put each of its annotations, and which ones it could not place. */
export type PageResolution = {
  positions: Map<AnnotationId, number>;
  states: Map<AnnotationId, AnchorState>;
  orphaned: AnnotationId[];
};
