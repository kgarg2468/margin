"use client";

import { readableError } from "@/app/app/_components/errors";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { extractPdf, extractPdfFile } from "@/lib/pdf/extract";
import { errorClass, eyebrowClass } from "@/lib/ui";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { PdfDropzone } from "./pdf-dropzone";
import { uploadPdf } from "./pdf-ingest";

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
}: {
  paperId: Id<"papers">;
  labId: Id<"labs">;
  hasPdf: boolean;
  hasText: boolean;
  pageCount?: number;
}) {
  const pdfUrl = useQuery(
    api.papers.getPdfUrl,
    hasPdf ? { paperId } : "skip",
  );
  const generateUploadUrl = useMutation(api.papers.generateUploadUrl);
  const attachPdf = useMutation(api.papers.attachPdf);
  const saveExtractedText = useMutation(api.papers.saveExtractedText);

  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function attach(file: File) {
    setError(null);
    try {
      setStatus("Reading the PDF…");
      const extraction = await extractPdfFile(file, {
        onProgress: (pagesDone, pages) =>
          setStatus(`Reading page ${pagesDone} of ${pages}…`),
      });
      setStatus("Storing it for the lab…");
      const uploadUrl = await generateUploadUrl({ labId });
      const storageId = await uploadPdf(uploadUrl, file);
      await attachPdf({ paperId, storageId, pages: extraction.pages });
      setStatus(null);
    } catch (caught) {
      setStatus(null);
      setError(
        readableError(
          caught,
          "Margin couldn't read that PDF. If it opens elsewhere, it may be encrypted.",
        ),
      );
    }
  }

  /**
   * The text layer for a file Margin fetched itself. pdf.js runs in the
   * browser, so the extraction that upload does at ingest has to happen the
   * first time a member asks for it instead.
   */
  async function readStoredPdf() {
    if (pdfUrl === undefined || pdfUrl === null) {
      return;
    }
    setError(null);
    try {
      setStatus("Fetching the PDF…");
      const response = await fetch(pdfUrl);
      const data = await response.arrayBuffer();
      const extraction = await extractPdf(data, {
        onProgress: (pagesDone, pages) =>
          setStatus(`Reading page ${pagesDone} of ${pages}…`),
      });
      await saveExtractedText({ paperId, pages: extraction.pages });
      setStatus(null);
    } catch (caught) {
      setStatus(null);
      setError(readableError(caught, "That PDF wouldn't open."));
    }
  }

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
            {!hasText && (
              <button
                type="button"
                disabled={status !== null}
                onClick={readStoredPdf}
                className="font-sans text-sm text-accent underline-offset-4 hover:underline disabled:opacity-50"
              >
                Read its text layer
              </button>
            )}
          </div>

          {!hasText && (
            <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
              Annotations anchor to passages of extracted text, so the reader
              needs this done once before anyone can write in the margins.
            </p>
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
                disabled={status !== null}
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
            disabled={status !== null}
            onFile={attach}
          />
        </div>
      )}

      {status !== null && (
        <p className="font-sans text-sm text-ink-muted" aria-live="polite">
          {status}
        </p>
      )}
      {error !== null && (
        <p role="alert" className={errorClass}>
          {error}
        </p>
      )}
    </section>
  );
}
