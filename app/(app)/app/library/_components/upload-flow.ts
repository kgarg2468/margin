/**
 * What an upload has to say for itself while it happens.
 *
 * All of it is here rather than in the component for the reason the reader's
 * `zoom.ts` and `draft-box.ts` are: this harness has no DOM, so a rule written
 * inside JSX is a rule with no test. The three that matter are testable and
 * were all wrong before — a wait with no way out of it, a byte count that
 * divided by an empty file, and a live region that fired once per page.
 */

/** One decimal from a megabyte up, whole units below: nobody reads "3.247 MB". */
export function formatBytes(bytes: number): string {
  const KB = 1024;
  const MB = KB * 1024;
  if (bytes >= MB) {
    return `${(bytes / MB).toFixed(1)} MB`;
  }
  if (bytes >= KB) {
    return `${Math.round(bytes / KB)} KB`;
  }
  return `${Math.round(bytes)} B`;
}

/**
 * A distance, not a fraction. `total` can genuinely be unknown — an XHR
 * progress event may arrive with `lengthComputable === false` — and "3.2 MB of
 * 0 MB" is worse than saying only the half that is true.
 */
export function bytesProgress(loaded: number, total: number): string {
  return total > 0
    ? `${formatBytes(loaded)} of ${formatBytes(total)}`
    : `${formatBytes(loaded)} sent`;
}

/** For `aria-valuenow`. `null` where there is no denominator to divide by. */
export function percentSent(loaded: number, total: number): number | null {
  if (!(total > 0)) {
    return null;
  }
  return Math.min(100, Math.round((loaded / total) * 100));
}

/**
 * The member called it off, and that is not a failure to report.
 *
 * Both withdrawals speak the platform's own vocabulary — `xhr.abort()` and
 * `AbortSignal.throwIfAborted()` both surface as an `AbortError` — so one
 * predicate covers the network leg and the pdf.js leg. `instanceof` is not
 * available: pdf.js's exceptions cross a worker boundary and arrive with their
 * prototype flattened, which is why `describePdfOpenError` reads `name` too.
 */
export function isCancellation(caught: unknown): boolean {
  return (
    typeof caught === "object" &&
    caught !== null &&
    "name" in caught &&
    (caught as { name: unknown }).name === "AbortError"
  );
}

/** Where the upload has got to. The component widens this with the file. */
export type UploadStage =
  | { kind: "empty" }
  | { kind: "reading"; pagesDone: number; pageCount: number }
  | { kind: "read" }
  | { kind: "sending"; loaded: number; total: number }
  | { kind: "filing" };

/**
 * No wait without a way out of it.
 *
 * A 400-page scan used to wedge this tab until the page was reloaded: neither
 * `reading` nor `saving` rendered a single control. Two of the three waits can
 * be genuinely stopped — pdf.js between pages, the XHR at any byte. The third
 * cannot: `createFromUpload` is one round trip and there is no recalling it.
 * What can be given back there is the form and an honest sentence about what
 * may have landed, which is what "abandon" means and why it is not called
 * "cancel".
 */
/**
 * What is holding the panel shut, and the named control that ends it.
 *
 * A hold cannot be expressed without a label, and that is the whole point. The
 * first attempt at the busy guard reported a bare boolean: two of the three
 * tabs said "I am working", the panel dutifully made every exit inert, and
 * neither tab had a control to end the wait — so the guard meant to remove
 * unnamed doors left a room with no door at all. Reporting the exit instead of
 * a flag makes that unsayable: to hold the panel you must hand over the way out.
 */
export type PanelHold = { kind: "abort" | "abandon"; label: string };

/**
 * The DOI lookup's hold. `createFromDoi` is one action and cannot be recalled —
 * it is a Crossref round trip that will finish whatever anyone here does — so
 * what is on offer is the abandon, in the same words the upload's last stage
 * uses.
 */
export function lookupHold(pending: boolean): PanelHold | null {
  return pending ? { kind: "abandon", label: "Stop waiting" } : null;
}

/**
 * The reference import's hold, and the one genuine abort of the three.
 *
 * An import is one round trip per selected entry, so a 200-entry export runs
 * for minutes; it is also the only wait here that can be stopped part-done and
 * still leave something worth keeping. Cancelling stops it issuing further
 * round trips and leaves the outcomes it has already collected on screen, which
 * is the record of what landed and is the expensive thing to lose.
 */
export function importHold(importing: boolean): PanelHold | null {
  return importing ? { kind: "abort", label: "Stop importing" } : null;
}

export function cancelOffer(stage: UploadStage): PanelHold | null {
  switch (stage.kind) {
    case "empty":
    case "read":
      return null;
    case "reading":
      return { kind: "abort", label: "Stop reading it" };
    case "sending":
      return { kind: "abort", label: "Cancel the upload" };
    case "filing":
      return { kind: "abandon", label: "Stop waiting" };
    default:
      // Every kind above answers for itself, so nothing reaches here and the
      // narrowed type is `never`. That is the point: a stage added to
      // `UploadStage` without a decision made about it here stops being a
      // silent `null` — an unstoppable wait, shipped quietly — and becomes a
      // type error on this line. A test cannot catch the case it doesn't know
      // to write; the compiler can.
      return stage satisfies never;
  }
}

/**
 * What the bar is measuring.
 *
 * `progressbar` takes no name from its own content, so the bar needs telling
 * apart from every other bar by hand — and one fixed name could not do it
 * honestly. "Upload progress" was a lie on two stages out of three: pdf.js
 * reading a local file has not uploaded anything, and filing is a mutation
 * rather than bytes.
 */
export function stageLabel(stage: UploadStage): string {
  switch (stage.kind) {
    case "empty":
    case "read":
      return "";
    case "reading":
      return "Reading the PDF";
    case "sending":
      return "Uploading the PDF";
    case "filing":
      return "Adding the paper";
    default:
      // See `cancelOffer`: a new stage owes this switch an answer too.
      return stage satisfies never;
  }
}

/** The running count, for eyes. Not announced — see `stageAnnouncement`. */
export function stageProgress(stage: UploadStage): string | null {
  switch (stage.kind) {
    case "empty":
    case "read":
      return null;
    case "reading":
      return stage.pageCount === 0
        ? "Opening the PDF…"
        : `Reading page ${stage.pagesDone} of ${stage.pageCount}…`;
    case "sending":
      return bytesProgress(stage.loaded, stage.total);
    case "filing":
      return "Filing it…";
    default:
      // See `cancelOffer`: a new stage owes this switch an answer too.
      return stage satisfies never;
  }
}

/**
 * The same news, once per stage.
 *
 * The old progress line was `aria-live="polite"` and rewritten once per page,
 * so a 340-page scan queued 340 announcements; a byte counter would queue one
 * per chunk. The count stays on screen, in a `progressbar` a screen reader can
 * ask for; this is the only thing that ever speaks, and it changes three times.
 */
export function stageAnnouncement(stage: UploadStage): string {
  switch (stage.kind) {
    case "empty":
    case "read":
      return "";
    case "reading":
      return "Reading the PDF.";
    case "sending":
      return "Uploading the PDF.";
    case "filing":
      return "Adding the paper.";
    default:
      // See `cancelOffer`: a stage that says nothing should say so on purpose.
      return stage satisfies never;
  }
}

/**
 * Where an upload lands once it is saved.
 *
 * The reader, not the record — because by this point the text layer has already
 * been read, in this browser, before a byte was sent. The record page's whole
 * job is to explain what is missing and offer the control that fixes it, and
 * for a PDF that has just been read there is nothing missing; stopping there
 * asked the member to confirm an outcome they had watched happen and then press
 * one more link to get where they were going.
 *
 * The exception is the file that came back with no text in it at all. That is a
 * scan, `papers.createFromUpload` stores it `pending` rather than `ready` on the
 * same test, and nothing can anchor to it — so its one useful destination is
 * still the record, where the panel says why and offers a replacement. The
 * server draws this line in `ingestStateFor`; the rule is restated here rather
 * than imported because a client bundle has no business importing a Convex
 * module, and the two agreeing is what this function's test is for.
 */
export function destinationAfterUpload(
  paperId: string,
  pages: readonly string[],
): string {
  const readable = pages.some((page) => page.trim().length > 0);
  return readable
    ? `/app/library/${paperId}/read`
    : `/app/library/${paperId}`;
}
