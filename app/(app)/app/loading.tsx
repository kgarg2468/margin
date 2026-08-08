import { PageSkeleton } from "./_components/skeletons";

/**
 * What the content column holds while the route itself is still in flight.
 *
 * Without a `loading.tsx` the App Router leaves `main` empty until the segment
 * arrives, so clicking a nav link emptied the page and then filled it again —
 * a blank frame between two drawn ones. The sidebar never moves, which made
 * the flash the only thing that did, and a blank column reads as a stall
 * rather than as a navigation.
 *
 * It is `PageSkeleton` rather than a shape drawn for this route, and the same
 * is true of the four beside it: every page under this segment already renders
 * `PageSkeleton` as its own first frame, for the moment its Convex
 * subscriptions are still `undefined`. Anything else here would put two
 * different skeletons back to back and shift the page between them — for the
 * sake of a frame nobody is reading, and before the one paint that matters.
 */
export default function AppLoading() {
  return <PageSkeleton />;
}
