/**
 * Finding a passage the file moved to another page.
 *
 * `resolveAnchor` is page-pinned by construction. An anchor records the page it
 * was written on, and everything the resolver knows how to do it does inside
 * that one page's text. Against a version of record that holds, which is most
 * of what a life-science lab reads together.
 *
 * It stops holding the moment the bytes change shape. A preprint is replaced by
 * the published copy; a PDF is re-uploaded from a different mirror; a journal
 * template runs two lines longer per page and everything after the introduction
 * slides forward. The passage is still in the paper — often still on screen —
 * and the note about it is reported orphaned because it is looking one page too
 * far back. `docs/STRATEGY.md` names that as the thing keeping preprint-heavy
 * fields out of the ICP, and it is what this module is for.
 *
 * The rule is: when the pinned page misses, look at the pages either side of it.
 * Three constraints keep that from turning into a search.
 *
 * - **Bounded.** Two pages out, and no further. Repagination drifts; it does
 *   not teleport. A passage four pages from where it was recorded is a
 *   different edition of the paper, not a reflow of this one, and a margin note
 *   is not evidence about a document nobody has established is the same.
 *
 * - **Lazy.** Nothing here is read until the pinned page has already failed,
 *   and then only the pages actually consulted. A forty-page paper is not
 *   extracted so that one orphan can be looked for. That is why the pages
 *   arrive through a loader rather than as an array: the caller holds a PDF and
 *   decides what it costs to open a page, and this module stays a pure function
 *   over text with no idea that pdf.js exists.
 *
 * - **Unambiguous or nothing.** If the quote turns up convincingly on the page
 *   before *and* the page after, this reports nothing found. A wrong margin is
 *   worse than a missing one: an orphaned note still shows its own words in the
 *   rail and says honestly that it could not be placed, whereas a note attached
 *   to the wrong sentence is a false claim about what somebody said, and the
 *   reader has no way to catch it. Detecting that case is also the reason both
 *   sides of a ring are read even after one of them has hit — the second read
 *   is not wasted work, it is the check.
 *
 * What this deliberately does not do is write anything back. A recovered anchor
 * is reported, disclosed in the margin, and re-derived on the next render; the
 * stored `pageIndex` still says where the note was written. Rewriting it would
 * be a silent edit of somebody's annotation on the strength of a guess about a
 * file that may itself be replaced next week.
 */

import type { ResolvedAnchor, TextAnchor } from "./anchor";
import { resolveAnchor } from "./anchor";

/** How many pages either side of the pinned one may be consulted. */
export const RECOVERY_RADIUS = 2;

/**
 * How sure a match on another page has to be before it counts.
 *
 * Higher than the bar for the anchor's own page, on purpose. On the pinned page
 * the anchor has already earned the benefit of the doubt — the note was written
 * there — and a 0.75 fuzzy match drawn with a dashed rule is a reasonable thing
 * to show. On a page nobody claimed, the only evidence that this is the passage
 * *is* the match, so it has to be one that could not plausibly be a different
 * sentence: an exact quote, or context that decided between copies, or an
 * alignment that differs from the recorded words by a hyphen and a dash.
 */
export const RECOVERY_MIN_CONFIDENCE = 0.9;

/**
 * A page's extracted text, or `null` for a page that could not be read.
 *
 * Called at most twice per ring, and only for pages inside the document. May be
 * synchronous — the tests are — but the reader's implementation goes to pdf.js
 * and is not.
 */
export type PageTextLoader = (
  pageIndex: number,
) => Promise<string | null> | string | null;

export type RecoveredAnchor = {
  /** The page the passage actually turned up on. Never the anchor's own. */
  pageIndex: number;
  /** How far it moved, and which way: -1 is the page before the pinned one. */
  offset: number;
  /** The passage's range in *that* page's text, and how it was found. */
  resolved: ResolvedAnchor;
};

export type RecoverOptions = {
  /** Pages in the document, so the search stops at both covers. */
  pageCount: number;
  /** Pages either side to consider. Defaults to `RECOVERY_RADIUS`. */
  radius?: number;
  /** Passed through to `resolveAnchor` for the fuzzy last resort. */
  minScore?: number;
};

/**
 * Look for `anchor`'s passage on the pages around the one it is pinned to.
 *
 * The pinned page itself is never read: the caller has already tried it with
 * `resolveAnchor` and been told no, and that miss is the whole trigger for
 * being here. Returns `null` when the passage is not recoverably nearby, which
 * includes the case where it is nearby *twice*.
 *
 * Pages are taken in rings — both neighbours, then both pages two out — so a
 * passage that only drifted by one is always preferred to one that drifted by
 * two, whichever direction each went.
 */
export async function recoverAnchor(
  anchor: TextAnchor,
  loadPageText: PageTextLoader,
  options: RecoverOptions,
): Promise<RecoveredAnchor | null> {
  const { pageCount } = options;
  const radius = options.radius ?? RECOVERY_RADIUS;
  if (anchor.quote.length === 0 || pageCount <= 1 || radius < 1) {
    return null;
  }

  for (let distance = 1; distance <= radius; distance++) {
    const found: RecoveredAnchor[] = [];

    for (const offset of [-distance, distance]) {
      const pageIndex = anchor.pageIndex + offset;
      if (pageIndex < 0 || pageIndex >= pageCount) {
        continue;
      }
      const pageText = await loadPageText(pageIndex);
      if (pageText === null || pageText.length === 0) {
        continue;
      }

      const resolved = resolveAnchor(anchor, pageText, {
        minScore: options.minScore,
        // The offsets in this anchor are offsets into a different page's text.
        // Believing them here is how a note ends up on whatever sentence
        // happens to sit at character 4 200 of the following page.
        trustPosition: false,
      });
      if (
        resolved === null ||
        resolved.ambiguous ||
        resolved.confidence < RECOVERY_MIN_CONFIDENCE
      ) {
        continue;
      }
      found.push({ pageIndex, offset, resolved });
    }

    const first = found[0];
    if (found.length === 1 && first !== undefined) {
      return first;
    }
    if (found.length > 1) {
      // The same words on both sides of the pinned page. That is a running
      // header or a boilerplate caption, not a passage that moved, and looking
      // further out would only turn up more copies of it.
      return null;
    }
  }

  return null;
}
