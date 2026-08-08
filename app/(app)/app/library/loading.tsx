import { PageSkeleton } from "../_components/skeletons";

/**
 * The library, still arriving: the header rule and title over the shelf.
 *
 * The same shape `LibraryPage` draws while its lab list is `undefined`, so the
 * route boundary hands off to the page without redrawing. See
 * `app/(app)/app/loading.tsx` for why that matters.
 */
export default function LibraryLoading() {
  return <PageSkeleton />;
}
