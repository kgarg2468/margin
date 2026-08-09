/**
 * Getting through the paper from the keyboard.
 *
 * Every page used to be its own tab stop, which meant Tab walked thirty-seven
 * identical groups before it reached the margin — and deleting the `tabIndex`
 * was never the fix, because pdf.js's text layer is transparent positioned
 * spans with nothing tabbable in it and caret browsing needs somewhere to
 * start. So the paper keeps exactly one stop, on the page being read, and this
 * is how you move it.
 *
 * Page Up and Page Down and nothing else on the vertical axis. The arrows
 * belong to the caret: shift-arrow through the text layer is the only way a
 * keyboard reader selects a passage, and a page navigator that ate ArrowDown
 * would take annotation away in exchange for scrolling.
 */

/**
 * The paragraph that says all of the above out loud.
 *
 * Named here rather than written twice, because the two ends of the
 * association are in different files: the reader renders the sentence, the page
 * carrying the stop points at it. A stop that moves under keys nobody mentioned
 * is not an affordance.
 */
export const PAGE_KEYS_HINT_ID = "reader-page-keys";

/**
 * Which page carries the stop.
 *
 * Ordinarily the one being read. The clamp is for the case where it is not:
 * the page being read is reported by an IntersectionObserver over the pages
 * that exist, and when a second document loads into the same reader the
 * observer's last answer can be off the end of the new one. Unclamped, every
 * page would compare false and the paper would have no tab stop at all —
 * unreachable by keyboard, and silently, since nothing else in the reader
 * depends on this number.
 *
 * `null` for a paper with no pages, which is not the same answer as page zero:
 * there is nothing to put a stop on yet.
 */
export function tabStopPage({
  current,
  pageCount,
}: {
  current: number;
  pageCount: number;
}): number | null {
  if (pageCount <= 0) {
    return null;
  }
  return Math.min(current, pageCount - 1);
}

/**
 * Whether the "Annotate selection" offer is somewhere Tab can reach.
 *
 * The offer is mounted by the page the selection is on and stays mounted while
 * the selection lives — which is right, because the selection is still there to
 * be annotated, and wrong the moment the reader has paged away from it. Left at
 * `tabIndex 0` it did three things at once, all measured: it added a stop to a
 * paper that is meant to have exactly one; focusing it scrolled the paper back
 * a page, because a browser scrolls what it focuses; and since its own page
 * wrapper is its ancestor, the paper's roving stop was then behind it in the
 * tab order and got skipped. So the offer did not merely add a stop — it ate
 * the paper's.
 *
 * The rule is the one the roving stop already states: a page that is not the
 * page being read has nothing tabbable on it. The offer stays mounted and
 * stays clickable — the selection is live and a pointer can still reach it if
 * the reader scrolls back — it just stops being on the way to anywhere.
 */
export function offerIsTabbable({ onPageBeingRead }: { onPageBeingRead: boolean }): 0 | -1 {
  return onPageBeingRead ? 0 : -1;
}

export function pageKeyTarget(
  key: string,
  { current, pageCount }: { current: number; pageCount: number },
): number | null {
  if (pageCount <= 0) {
    return null;
  }
  const last = pageCount - 1;
  switch (key) {
    case "PageDown":
      return Math.min(last, current + 1);
    case "PageUp":
      return Math.max(0, current - 1);
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}
