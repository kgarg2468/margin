import { PageSkeleton } from "../../_components/skeletons";

/**
 * A paper's record, still arriving: the header rule and title over the
 * sections below it.
 *
 * The same shape `PaperPage` draws while `getPaper` is `undefined`, so the
 * route boundary hands off to the page without redrawing. See
 * `app/(app)/app/loading.tsx` for why that matters.
 *
 * This boundary also covers `/read`, which is a different screen entirely — it
 * is `fixed inset-0` and carries its own page-shaped skeleton. The record's
 * shape is what shows for the frame before the reader takes the viewport.
 */
export default function PaperLoading() {
  return <PageSkeleton />;
}
