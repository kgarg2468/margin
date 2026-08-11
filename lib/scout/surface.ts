/**
 * What a reader is told about a machine's work.
 *
 * Every sentence in this file is ours. A delegation that failed carries a
 * reason the backend wrote (`FAILURE_SENTENCES`, `convex/delegations.ts`) and
 * this prints it; everything else here is composed out of counts. A model's
 * own words never reach any of these functions, which is why they are pure and
 * why they are tested: a status line is the one place a surface could quietly
 * start narrating.
 *
 * Structural types rather than Convex ones — `lib/` never imports from
 * `convex/`, and these shapes are the ones `delegations.listForSubject` and
 * `findings.newestForSubject` already return.
 */

/** The lifecycle a run walks, exactly as the delegation row records it. */
export type ScoutStatus =
  | "queued"
  | "running"
  | "returned"
  | "empty"
  | "failed"
  | "cancelled";

/** A note this page has a row for, and so can name. */
export type KnownNote = { authorName: string; pageIndex: number };

/**
 * The quiet line under a question while a run is unfinished, or once it ended
 * without a finding. `null` means draw nothing.
 *
 * `returned` draws nothing because the finding underneath *is* the answer, and
 * a status chip over the top of it would be the interface reading itself out
 * loud. `cancelled` draws nothing because the only thing that cancels a run in
 * v1 is the subject being settled or withdrawn — both of which the page has
 * already said, in the place a person was looking.
 */
export function scoutStatusLine(
  run: { status: ScoutStatus; failureReason?: string } | undefined,
): string | null {
  if (run === undefined) return null;
  switch (run.status) {
    case "queued":
    case "running":
      return "Scout is looking back…";
    case "empty":
      return "The scout read the lab's margin and found nothing that bears on this.";
    case "failed":
      // Ours either way: the row's sentence was written by this codebase, and
      // the fallback covers a row that predates the vocabulary.
      return run.failureReason ?? "The scout's run didn't finish. Nothing was stored.";
    case "returned":
    case "cancelled":
      return null;
  }
}

/**
 * The line actually drawn under a question, given what is already beneath it.
 *
 * `scoutStatusLine` is the vocabulary — what sentence a run's status has.
 * This is the rule, and it exists because a **rerun** makes the two come
 * apart: a question scouted twice has a standing report *and* a newer run
 * walking its own lifecycle, and a surface that consulted only one of them
 * would be wrong in one direction or the other.
 *
 * Two cases, decided differently on purpose.
 *
 * **A newer run in flight is drawn, over the top of the last one's report.**
 * Design §7 promises a run still in flight shows a quiet line that resolves
 * reactively, and that promise does not lapse because an earlier report
 * happens to be standing. A reader who pressed the button needs to see that
 * something is happening; without this they would watch an unchanged report
 * and conclude the press did nothing.
 *
 * **A rerun that came back empty or failed says nothing, and the standing
 * report stays exactly as it is.** This is a decision, not an oversight. The
 * old finding is still the newest report the scout returned, and it is not
 * stale in any way that matters: `findings.toView` re-resolves every citation
 * and re-applies redaction on *every* read, so what is on screen is checked
 * against the margin as it stands right now, not as it stood when the run
 * finished. "The scout read the lab's margin and found nothing that bears on
 * this" printed directly above a cited report of what it found would be the
 * product contradicting itself in two adjacent sentences, and the failure
 * sentences describe a run that stored nothing — which is precisely why the
 * thing underneath is still worth reading. Those sentences are for the case
 * where there is no report to stand on, and that is the case they render in.
 */
export function drawnStatusLine(
  run: { status: ScoutStatus; failureReason?: string } | undefined,
  /** Whether a finding is already drawn beneath this line. */
  hasFinding: boolean,
): string | null {
  if (run === undefined) return null;
  const inFlight = run.status === "queued" || run.status === "running";
  if (hasFinding && !inFlight) return null;
  return scoutStatusLine(run);
}

const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

/**
 * How much the scout actually read, from `coverage` — computed in the backend
 * from the material it was shown, never asked of the model (design §13.3).
 *
 * "across" reads wrong for a single paper, and this sentence is the whole
 * evidence a reader has for calibrating a thin finding.
 *
 * `queriesRun` is on the stored shape and is accepted here so a caller can
 * hand over `finding.coverage` whole, but it is deliberately not said out
 * loud: how many searches a machine needed is a fact about the machine, and
 * the reader is calibrating the evidence.
 */
export function coverageLine(coverage: {
  annotationsSearched: number;
  papersTouched: number;
  queriesRun?: number;
}): string {
  const notes = plural(coverage.annotationsSearched, "note", "notes");
  const papers = plural(coverage.papersTouched, "paper", "papers");
  const where = coverage.papersTouched === 1 ? `on ${papers}` : `across ${papers}`;
  return `Read ${notes} ${where}.`;
}

/**
 * What did not survive, and why — two different facts, never merged.
 *
 * The gate dropped a line because the machine could not cite it; the margin
 * redacted one because a note behind it stopped being shared. A reader
 * calibrating a scout needs the first; a reader calibrating the *record* needs
 * the second, and a single "3 lines missing" would answer neither.
 */
export function droppedLine(counts: {
  droppedForCitation: number;
  redactedCount: number;
}): string | null {
  const parts: string[] = [];
  if (counts.droppedForCitation > 0) {
    const n = counts.droppedForCitation;
    parts.push(
      `${plural(n, "line was", "lines were")} dropped because the scout couldn't cite ${n === 1 ? "it" : "them"}.`,
    );
  }
  if (counts.redactedCount > 0) {
    const n = counts.redactedCount;
    parts.push(
      `${plural(n, "line", "lines")} rested on notes that are no longer shared.`,
    );
  }
  return parts.length === 0 ? null : parts.join(" ");
}

/**
 * An item's citations, split into the ones this page can name and the ones it
 * can only count.
 *
 * The scout searches the lab's whole margin, so most of what a finding cites
 * is on some other paper — and a page that has no row for a note knows its id
 * and nothing else. Naming it anyway would mean inventing an author or a page
 * number; dropping it silently would understate the evidence. It is counted.
 */
export function citationSummary<A extends string>(
  citedAnnotationIds: readonly A[],
  known: ReadonlyMap<A, KnownNote>,
): {
  resolved: { id: A; authorName: string; pageIndex: number }[];
  elsewhere: number;
} {
  const resolved: { id: A; authorName: string; pageIndex: number }[] = [];
  let elsewhere = 0;
  for (const id of citedAnnotationIds) {
    const note = known.get(id);
    if (note === undefined) {
      elsewhere += 1;
      continue;
    }
    resolved.push({ id, ...note });
  }
  return { resolved, elsewhere };
}
