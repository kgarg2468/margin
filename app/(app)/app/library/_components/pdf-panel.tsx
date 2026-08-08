"use client";

import { readableError } from "@/app/(app)/app/_components/errors";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { extractPdfFile } from "@/lib/pdf/extract";
import { errorClass, eyebrowClass } from "@/lib/ui";
import { useMutation, useQuery } from "convex/react";
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
  const pdfUrl = useQuery(
    api.papers.getPdfUrl,
    hasPdf ? { paperId } : "skip",
  );
  const generateUploadUrl = useMutation(api.papers.generateUploadUrl);
  const attachPdf = useMutation(api.papers.attachPdf);
  const markIngestFailed = useMutation(api.papers.markIngestFailed);
  const discardUpload = useMutation(api.papers.discardUpload);

  const textLayer = useTextLayer();
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      const message = readableError(
        caught,
        "Margin couldn't read that PDF. If it opens elsewhere, it may be encrypted.",
      );
      setError(message);
      await recover(uploaded, message);
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
            {pdfUrl !== undefined && pdfUrl !== null && (
              <a
                href={pdfUrl}
                target="_blank"
                rel="noreferrer"
                className="font-sans text-sm text-accent underline-offset-4 hover:underline"
              >
                Open the PDF
              </a>
            )}
            {canReadText && (
              <button
                type="button"
                disabled={busyMessage !== null}
                onClick={() => void textLayer.read(paperId, true)}
                className="tap-target font-sans text-sm text-accent underline-offset-4 hover:underline disabled:opacity-50"
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
