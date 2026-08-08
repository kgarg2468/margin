import { PageSkeleton } from "../_components/skeletons";

/**
 * The calendar, still arriving: the header rule and title over the meetings.
 *
 * The same shape `SessionsPage` draws while its lab list is `undefined`, so the
 * route boundary hands off to the page without redrawing. See
 * `app/(app)/app/loading.tsx` for why that matters.
 */
export default function SessionsLoading() {
  return <PageSkeleton />;
}
