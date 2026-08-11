/**
 * What the inbox should be drawing, given what it currently knows.
 *
 * Three states, and the third is the point. A digest arrives by two different
 * late paths — the subscription resolving, and the `catchUp` mutation the
 * inbox fires on mount, which can build a since-away card a round trip after
 * the page has settled. So "there is no mail" and "nobody has answered yet"
 * are different facts and have to be drawn differently. Conflating them is
 * what put a card into the middle of the lab's home page after the reader had
 * already started reading it.
 *
 * `reserving` holds the slot with the same line-height ghost the roster and
 * the calendar beside it use, until both paths have answered. The page then
 * composes itself once.
 */
export type InboxState = "reserving" | "empty" | "showing";

export function inboxState({
  loaded,
  catchUpSettled,
  unreadCount,
}: {
  loaded: boolean;
  catchUpSettled: boolean;
  unreadCount: number;
}): InboxState {
  if (unreadCount > 0) {
    return "showing";
  }
  return loaded && catchUpSettled ? "empty" : "reserving";
}
