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
