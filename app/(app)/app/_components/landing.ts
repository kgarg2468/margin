/**
 * Where an arrival at `/app` belongs, and what it leaves behind.
 *
 * Two arrivals reach this, and the second outranks the first. Somebody whose
 * only lab is their personal library has no front matter worth landing on and
 * goes to their shelf; somebody who came in on a share link came for one
 * particular paper and goes to *that*, whatever else is on their shelf — see
 * `ImportedPaper` below and `shares.importFromShare` behind it.
 *
 * Extracted so the rule can be tested where a condition inside an effect could
 * not be — the same bargain `library/_components/upload-flow.ts` makes.
 *
 * The returned `justCreatedAfter` is the whole point. "This arrival is what
 * created the library" is true exactly once and has to be *spent* by the
 * redirect that honours it, because the provider holding it lives in the layout
 * and outlives the page: a newly provisioned member who closes the add panel,
 * reads something, and comes back to `/app` without reloading would otherwise
 * meet a signal that is still true, get sent to `?add=1` a second time, and
 * watch the panel they deliberately dismissed reopen over a library that by now
 * has papers on it.
 *
 * Returning the next state rather than mutating anything is what lets the
 * sequence be tested without a React tree: feed the answer back in and the
 * second arrival has to be an ordinary one.
 */
export function landOnShelf(
  justCreated: boolean,
  imported: ImportedPaper | null = null,
): {
  destination: string;
  justCreatedAfter: boolean;
} {
  if (imported !== null) {
    return {
      // Straight onto the paper, because the paper is what the reader pressed
      // for — they were already reading it on somebody else's page. Three
      // destinations rather than two, and the middle one earns its place: a
      // paper with a file but no text layer cannot be annotated yet, and the
      // reader for one is a document with dead margins. Its record is where
      // `pdf-panel.tsx` starts the extraction that fixes exactly that, so
      // sending them there is sending them to the thing that finishes the job.
      // A paper with no file at all lands on the shelf, visibly wanting one.
      destination: imported.ready
        ? `/app/library/${imported.paperId}/read`
        : imported.hasPdf
          ? `/app/library/${imported.paperId}`
          : "/app/library",
      // Spent even though the add panel never opened. Somebody arriving with a
      // paper in hand has already answered the question the panel asks, and
      // leaving the signal standing would spring it open over their shelf on
      // the next visit to `/app`.
      justCreatedAfter: false,
    };
  }
  return {
    // Signing up is an errand — somebody has a paper they want to read — so the
    // add panel is open on the one visit where there is nothing else to have
    // come for. Every later visit lands on the shelf, which by then has
    // something on it.
    destination: justCreated ? "/app/library?add=1" : "/app/library",
    justCreatedAfter: false,
  };
}

/**
 * A paper that came in on a share link, as `shares.importFromShare` reports it.
 *
 * Structurally typed rather than taken from the generated API, so the rule
 * above stays a function of three plain facts and can be tested without a
 * Convex client — the same bargain the rest of this module makes.
 */
export type ImportedPaper = {
  paperId: string;
  /** Whether the file is there *and* its text has been read. */
  ready: boolean;
  hasPdf: boolean;
};
