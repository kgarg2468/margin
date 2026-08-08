import type { api } from "@/convex/_generated/api";
import type { TextAnchor } from "@/lib/anchoring";
import type { FunctionReturnType } from "convex/server";

/** One row of the margin, exactly as `convex/annotations.ts` hands it over. */
export type AnnotationView = FunctionReturnType<
  typeof api.annotations.listForPaper
>[number];

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

/** Where a page put each of its annotations, and which ones it could not place. */
export type PageResolution = {
  positions: Map<AnnotationId, number>;
  orphaned: AnnotationId[];
};
