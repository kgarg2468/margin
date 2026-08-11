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
export function cancelOffer(
  stage: UploadStage,
): { kind: "abort" | "abandon"; label: string } | null {
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
