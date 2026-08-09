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
