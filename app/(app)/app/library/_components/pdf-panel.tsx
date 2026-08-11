"use client";

import { readableError } from "@/app/(app)/app/_components/errors";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { fetchPdfBytes } from "@/lib/pdf/delivery";
import { describePdfOpenError, extractPdfFile } from "@/lib/pdf/extract";
import {
  errorClass,
  eyebrowClass,
  inputClass,
  labelClass,
  linkButtonClass,
  secondaryButtonClass,
} from "@/lib/ui";
import { useAuthToken } from "@convex-dev/auth/react";
import { useAction, useMutation } from "convex/react";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import type { IngestStatus } from "./paper-meta";
import { PdfDropzone } from "./pdf-dropzone";
import { uploadPdf } from "./pdf-ingest";
import { useTextLayer } from "./use-text-layer";

/**
 * The file half of a paper: whether Margin has the PDF, whether it has the
 * text layer that annotations anchor to, and the one control that fixes
 * whichever is missing.
 *
 * Both gaps are real and routine — a DOI lookup often finds a record with no
 * open-access copy, and a copy Margin fetched itself has never been near a
 * browser that could read it — so the panel states them plainly rather than
 * pretending the paper is fine.
 */
export function PdfPanel({
  paperId,
  labId,
  hasPdf,
  hasText,
  pageCount,
  ingestStatus,
  ingestError,
}: {
  paperId: Id<"papers">;
  labId: Id<"labs">;
  hasPdf: boolean;
  hasText: boolean;
  pageCount?: number;
  ingestStatus: IngestStatus;
  ingestError?: string;
}) {
  const token = useAuthToken();
  const generateUploadUrl = useMutation(api.papers.generateUploadUrl);
  const attachPdf = useMutation(api.papers.attachPdf);
  const markIngestFailed = useMutation(api.papers.markIngestFailed);
  const discardUpload = useMutation(api.papers.discardUpload);
  const fetchPdfFromUrl = useAction(api.papers.fetchPdfFromUrl);

  const textLayer = useTextLayer();
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [freeCopyUrl, setFreeCopyUrl] = useState("");
  const [opening, setOpening] = useState(false);

  /**
   * Open the stored file on its own.
   *
   * This used to be an `<a href>` pointing at a Convex storage URL. There is
   * no such URL any more — the PDF is served by a membership-checked endpoint
   * that wants an `Authorization` header, and an anchor has no way to send
   * one — so the bytes are fetched here and handed to the tab as a blob.
   *
   * The tab is opened first, synchronously, inside the click. A `window.open`
   * that happens after an `await` has lost its connection to the gesture and
   * browsers treat it as a popup.
   */
  async function openPdf() {
    const tab = window.open("", "_blank");
    setOpening(true);
    setError(null);
    try {
      const bytes = await fetchPdfBytes(paperId, token);
      const blobUrl = URL.createObjectURL(
        new Blob([bytes], { type: "application/pdf" }),
      );
      if (tab === null) {
        // The gesture wasn't enough for this browser. A download is not what
        // was asked for, but it beats losing the file the member waited for.
        const link = document.createElement("a");
        link.href = blobUrl;
        link.download = "paper.pdf";
        link.click();
      } else {
        tab.location.href = blobUrl;
      }
      // Long enough for the tab to have loaded it, and then released —
      // revoking only stops *new* loads, so the open document is unaffected,
      // and the alternative is a copy of every PDF opened this session
      // sitting in memory until the page is closed.
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    } catch (caught) {
      tab?.close();
      // `fetchPdfBytes` already phrases its failures for a person — an
      // expired session, a paper that isn't visible — so those are kept.
      setError(
        caught instanceof Error && caught.message.length > 0
          ? caught.message
          : "That PDF wouldn't open.",
      );
    } finally {
      setOpening(false);
    }
  }

  /**
   * Tidying up after an ingest that stopped halfway: drop the blob nothing
   * will ever point at, and record that this paper's text layer isn't coming
   * — otherwise it sits at "text pending" forever, indistinguishable from one
   * nobody has opened yet.
   *
   * Both are best effort. The member has already been told what went wrong,
   * and a failure to clean up is not a second thing to tell them about.
   */
  async function recover(orphan: Id<"_storage"> | null, message: string) {
    if (orphan !== null) {
      try {
        await discardUpload({ labId, storageId: orphan });
      } catch {
        // The blob outlives us. Nothing the member can do about it.
      }
    }
    try {
      await markIngestFailed({ paperId, message });
    } catch {
      // Same.
    }
  }

  async function attach(file: File) {
    setError(null);
    // Held outside the `try` so the catch knows whether a file made it into
    // storage before things went wrong.
    let uploaded: Id<"_storage"> | null = null;
    try {
      setStatus("Reading the PDF…");
      const extraction = await extractPdfFile(file, {
        onProgress: (pagesDone, pages) =>
          setStatus(`Reading page ${pagesDone} of ${pages}…`),
      });
      setStatus("Storing it for the lab…");
      const uploadUrl = await generateUploadUrl({ labId });
      uploaded = await uploadPdf(uploadUrl, file);
      await attachPdf({ paperId, storageId: uploaded, pages: extraction.pages });
      // The paper owns the file now; it is not an orphan any more.
      uploaded = null;
      setStatus(null);
    } catch (caught) {
      setStatus(null);
      // This catch covers the whole attach, not just the read: an upload or a
      // mutation can fail here too, and those arrive as `ConvexError`s whose
      // message is the one worth showing. So ask pdf.js's classifier first —
      // it only answers for the failures it recognises — and fall through to
      // `readableError` for everything else.
      const message =
        describePdfOpenError(caught) ??
        readableError(
          caught,
          "Margin couldn't read that PDF. If it opens elsewhere, it may be encrypted.",
        );
      setError(message);
      await recover(uploaded, message);
    }
  }

  /**
   * The other way to close the gap: the member has the free copy open in
   * another tab, and Margin can fetch it server-side without a publisher's
   * CORS policy getting a vote. Nothing is uploaded from here, so there is no
   * orphan blob to recover — the action either attaches a file or throws.
   */
  async function fetchFromLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setStatus("Fetching it…");
    try {
      await fetchPdfFromUrl({ paperId, url: freeCopyUrl });
      setFreeCopyUrl("");
      setStatus(null);
      // A file Margin fetched itself has never been near a browser that could
      // read it, and pdf.js only runs in one.
      //
      // Unforced, deliberately. Nothing has spent this paper's one attempt —
      // the effect below only fires once there is a PDF, and until a moment
      // ago there wasn't — so there is nothing to force past. What there is,
      // is a race: `hasPdf` may well flip and start that effect before this
      // line runs. The hook's guard makes whichever of the two arrives second
      // a no-op, and forcing would opt out of precisely the guard keeping
      // this to one download, one extraction, and one phase to report.
      void textLayer.read(paperId);
    } catch (caught) {
      setStatus(null);
      setError(readableError(caught, "Margin couldn't fetch that link."));
    }
  }

  /**
   * Extraction is worth offering when it has never run, or when it ran and
   * broke. It is not worth offering for a scan: that file has been read, it
   * had no text in it, and reading it again would call a mutation that has
   * already correctly decided to do nothing.
   */
  const canReadText =
    !hasText && (pageCount === undefined || ingestStatus === "failed");

  /**
   * A text layer that has never been attempted is not a decision anyone needs
   * to be asked about — it is the rest of the ingest, waiting for a browser.
   * Landing on this page is enough; start it.
   *
   * Only where it has never run. A paper whose extraction already failed keeps
   * its button, because retrying the same broken file on every visit is a loop,
   * not a recovery.
   */
  const neverAttempted =
    hasPdf && !hasText && pageCount === undefined && ingestStatus !== "failed";

  // `read` is the stable half of the hook; depending on the hook's object
  // would re-run this on every render for no reason.
  const { read } = textLayer;
  useEffect(() => {
    if (neverAttempted) {
      void read(paperId);
    }
  }, [neverAttempted, paperId, read]);

  // Attaching a file and reading a stored one are two routes to the same two
  // sentences, so they share them rather than each drawing their own.
  const phase = textLayer.phaseFor(paperId);
  const busyMessage =
    status ?? (phase.kind === "working" ? phase.message : null);
  const problem = error ?? (phase.kind === "failed" ? phase.message : null);

  return (
    <section className="flex flex-col gap-4">
      <h2 className={eyebrowClass}>The file</h2>

      {hasPdf ? (
        <div className="flex flex-col gap-3">
          <p className="font-serif text-base leading-relaxed text-ink-muted">
            PDF attached
            {pageCount !== undefined
              ? ` · ${pageCount} ${pageCount === 1 ? "page" : "pages"}`
              : ""}
            {hasText ? "" : " · text not read yet"}
          </p>

          <div className="flex flex-wrap items-baseline gap-5">
            <button
              type="button"
              disabled={opening}
              onClick={() => void openPdf()}
              className={`${linkButtonClass} tap-target disabled:opacity-50`}
            >
              {opening ? "Opening the PDF…" : "Open the PDF"}
            </button>
            {canReadText && (
              <button
                type="button"
                disabled={busyMessage !== null}
                onClick={() => void textLayer.read(paperId, true)}
                className={`${linkButtonClass} tap-target disabled:opacity-50`}
              >
                {ingestStatus === "failed"
                  ? "Try reading it again"
                  : "Read its text layer"}
              </button>
            )}
          </div>

          {!hasText && (
            <div className="flex max-w-prose flex-col gap-2">
              {ingestError !== undefined && (
                <p className="font-serif text-base leading-relaxed text-ink">
                  {ingestError}
                </p>
              )}
              <p className="font-serif text-base leading-relaxed text-ink-muted">
                Annotations anchor to passages of extracted text, so the reader
                needs this done once before anyone can write in the margins.
              </p>
            </div>
          )}

          <details className="group">
            <summary className="cursor-pointer font-sans text-sm text-accent underline-offset-4 hover:underline">
              Replace the file
            </summary>
            <div className="mt-4 flex flex-col gap-2">
              <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
                Swapping a preprint for the published version replaces the text
                layer too — existing annotations will re-anchor against the new
                one.
              </p>
              <PdfDropzone
                id="replace-pdf"
                hint="The old file is discarded."
                disabled={busyMessage !== null}
                onFile={attach}
              />
            </div>
          </details>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
            No PDF yet. Margin has the record but couldn&rsquo;t find an
            open-access copy, so the file has to come from someone with access.
          </p>
          <PdfDropzone
            id="attach-pdf"
            hint="Read here in your browser, then stored for the lab."
            disabled={busyMessage !== null}
            onFile={attach}
          />

          <form
            className="flex flex-col gap-2 border-t border-rule pt-4"
            onSubmit={fetchFromLink}
          >
            <label htmlFor="free-copy-url" className={labelClass}>
              Found a free copy online?
            </label>
            <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
              Paste its link and Margin fetches it for the lab.
            </p>
            <input
              id="free-copy-url"
              name="url"
              type="url"
              required
              value={freeCopyUrl}
              onChange={(event) => setFreeCopyUrl(event.target.value)}
              spellCheck={false}
              placeholder="https://arxiv.org/pdf/1706.03762"
              className={`${inputClass} font-mono`}
            />
            <p className="font-sans text-xs text-ink-faint">
              A link to the PDF itself, not the page about the paper.
            </p>
            <button
              type="submit"
              disabled={busyMessage !== null}
              className={`${secondaryButtonClass} mt-1 self-start`}
            >
              Fetch it
            </button>
          </form>
        </div>
      )}

      {busyMessage !== null && (
        <p className="font-sans text-sm text-ink-muted" aria-live="polite">
          {busyMessage}
        </p>
      )}
      {problem !== null && (
        <p role="alert" className={errorClass}>
          {problem}
        </p>
      )}
    </section>
  );
}
