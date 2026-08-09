import { PageSkeleton } from "../../_components/skeletons";

/**
 * One session, still arriving: the header rule and title over the board.
 *
 * The same shape `SessionPage` draws while `getSession` is `undefined`, so the
 * route boundary hands off to the page without redrawing — including into the
 * live view, which replaces the whole column once the status is known. See
 * `app/(app)/app/loading.tsx` for why that matters.
 */
export default function SessionLoading() {
  return <PageSkeleton />;
}
