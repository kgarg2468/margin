import type { IngestStatus } from "./paper-meta";

export type ShelfRow = {
  /** True when the title itself is the row's link into the reader. */
  titleOpensReader: boolean;
  /** The row's one link to the record. `named` when it is the row's only link. */
  record: { label: string; tone: "quiet" | "named" };
};

/**
 * How a shelf row addresses the paper it names.
 *
 * A row carries one link per destination, and a paper that cannot be read has
 * only one destination worth offering: its record, where the missing half gets
 * fixed. The title used to link there too — the same URL, twice, in one row,
 * for every paper in the seconds after it arrives — with a status chip beside
 * it saying a third time that something was unfinished. So the title is a link
 * only when it goes somewhere the second link doesn't, and the second link
 * says what the trip is for instead of leaving a chip to be decoded.
 *
 * A pure function rather than a ternary in the row, because "never two links
 * to one URL" is an invariant and an invariant in JSX cannot be tested — this
 * harness has no DOM.
 */
export function shelfRow(paper: {
  ingestStatus: IngestStatus;
  hasPdf: boolean;
}): ShelfRow {
  if (paper.ingestStatus === "ready" && paper.hasPdf) {
    // The one state the margins can be written in, so the title goes straight
    // to the reader and the record steps back to a quiet second door.
    return {
      titleOpensReader: true,
      record: { label: "Open its record", tone: "quiet" },
    };
  }

  // The file first, whatever the status says about the text: text can't be
  // read out of a paper there is no copy of, so naming the status here would
  // name the wrong gap.
  const label = !paper.hasPdf
    ? "This paper still needs its PDF →"
    : paper.ingestStatus === "failed"
      ? "Its text wouldn’t come out — see why →"
      : "Finish preparing this paper →";

  return { titleOpensReader: false, record: { label, tone: "named" } };
}
