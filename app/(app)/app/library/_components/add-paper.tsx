"use client";

import { readableError } from "@/app/(app)/app/_components/errors";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { PdfExtraction } from "@/lib/pdf/extract";
import { extractPdfFile } from "@/lib/pdf/extract";
import {
  errorClass,
  inputClass,
  labelClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/lib/ui";
import { useAction, useMutation } from "convex/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { PdfDropzone } from "./pdf-dropzone";
import { parseAuthors, titleFromFilename, uploadPdf } from "./pdf-ingest";

/**
 * Two ways to add a paper, and they are genuinely different acts.
 *
 * A DOI is a lookup: you know the paper exists, you want its record, and
 * whether a readable copy comes with it is out of your hands. A PDF is a
 * deposit: the file is in front of you, and the only open question is what to
 * call it. Tabs rather than one clever box that guesses, because guessing
 * wrong on the way in is expensive later.
 */
export function AddPaper({ labId }: { labId: Id<"labs"> }) {
  const [tab, setTab] = useState<"doi" | "upload">("doi");

  return (
    <section className="flex flex-col gap-6 rounded-md border border-rule bg-surface p-6">
      <div
        role="tablist"
        aria-label="How to add a paper"
        className="flex gap-6 border-b border-rule"
      >
        <TabButton
          id="doi"
          label="By DOI"
          active={tab === "doi"}
          onSelect={() => setTab("doi")}
        />
        <TabButton
          id="upload"
          label="Upload PDF"
          active={tab === "upload"}
          onSelect={() => setTab("upload")}
        />
      </div>

      {tab === "doi" ? (
        <DoiTab labId={labId} />
      ) : (
        <UploadTab labId={labId} />
      )}
    </section>
  );
}

function TabButton({
  id,
  label,
  active,
  onSelect,
}: {
  id: string;
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={`add-paper-tab-${id}`}
      aria-selected={active}
      aria-controls={`add-paper-panel-${id}`}
      onClick={onSelect}
      className={
        "-mb-px border-b-2 pb-2 font-sans text-sm transition-colors " +
        (active
          ? "border-accent text-ink-strong"
          : "border-transparent text-ink-faint hover:text-ink-muted")
      }
    >
      {label}
    </button>
  );
}

/* ---------------------------------------------------------------- DOI --- */

type DoiResult = {
  paperId: Id<"papers">;
  title: string;
  alreadyInLibrary: boolean;
  hasPdf: boolean;
};

function DoiTab({ labId }: { labId: Id<"labs"> }) {
  const createFromDoi = useAction(api.papers.createFromDoi);
  const [doi, setDoi] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DoiResult | null>(null);

  return (
    <div
      role="tabpanel"
      id="add-paper-panel-doi"
      aria-labelledby="add-paper-tab-doi"
      // A panel is a scrollable region a keyboard user has to be able to
      // reach, so it takes focus itself rather than only its controls.
      tabIndex={0}
      className="flex flex-col gap-4"
    >
      <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
        Margin asks Crossref for the record and OpenAlex for an open-access
        copy. If one exists, the paper arrives ready to read.
      </p>

      <form
        className="flex flex-col gap-4"
        onSubmit={async (event) => {
          event.preventDefault();
          setError(null);
          setResult(null);
          setPending(true);
          try {
            setResult(await createFromDoi({ labId, doi }));
            setDoi("");
          } catch (caught) {
            setError(readableError(caught, "That lookup didn't work."));
          } finally {
            setPending(false);
          }
        }}
      >
        <div className="flex flex-col gap-2">
          <label htmlFor="paper-doi" className={labelClass}>
            DOI
          </label>
          <input
            id="paper-doi"
            name="doi"
            required
            value={doi}
            onChange={(event) => setDoi(event.target.value)}
            spellCheck={false}
            placeholder="10.1038/nature12373"
            className={`${inputClass} font-mono`}
          />
          <p className="font-sans text-xs text-ink-faint">
            A full doi.org link works too.
          </p>
        </div>

        {error !== null && (
          <p role="alert" className={errorClass}>
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={pending}
          className={`${primaryButtonClass} self-start`}
        >
          {pending ? "Looking it up…" : "Add paper"}
        </button>
      </form>

      {result !== null && <DoiOutcome result={result} />}
    </div>
  );
}

/**
 * Four endings, and every one of them is about what is still missing.
 *
 * "Added" alone would be a small lie in three of the four cases: a fetched PDF
 * has never been near a browser that could read its text layer, and a paper
 * that was already here may still be waiting for its file. Saying which — and
 * pointing at the place it gets fixed — is the difference between a paper that
 * gets read and a dead row.
 */
function DoiOutcome({ result }: { result: DoiResult }) {
  const href = `/app/library/${result.paperId}`;

  return (
    <div className="flex flex-col gap-2 border-l-2 border-accent pl-4">
      <p className="font-serif text-base leading-relaxed text-ink">
        {result.alreadyInLibrary
          ? result.hasPdf
            ? "Already in the library — nothing to add."
            : "Already in the library — it still needs a PDF, open it to attach one."
          : result.hasPdf
            ? "Added — open the paper to read its text layer."
            : "Added, metadata only. No open-access copy was available, so the reader needs the PDF attaching before anyone can annotate it."}
      </p>
      <Link
        href={href}
        className="font-sans text-sm text-accent underline-offset-4 hover:underline"
      >
        {result.hasPdf
          ? `Open ${result.title}`
          : `Attach the PDF to ${result.title}`}
      </Link>
    </div>
  );
}

/* ------------------------------------------------------------- Upload --- */

type UploadPhase =
  | { kind: "empty" }
  | { kind: "reading"; pagesDone: number; pageCount: number }
  | { kind: "read"; file: File; extraction: PdfExtraction }
  | { kind: "saving" };

function UploadTab({ labId }: { labId: Id<"labs"> }) {
  const generateUploadUrl = useMutation(api.papers.generateUploadUrl);
  const createFromUpload = useMutation(api.papers.createFromUpload);
  const discardUpload = useMutation(api.papers.discardUpload);
  const router = useRouter();

  const [phase, setPhase] = useState<UploadPhase>({ kind: "empty" });
  const [error, setError] = useState<string | null>(null);

  async function read(file: File) {
    setError(null);
    setPhase({ kind: "reading", pagesDone: 0, pageCount: 0 });
    try {
      const extraction = await extractPdfFile(file, {
        onProgress: (pagesDone, pageCount) =>
          setPhase({ kind: "reading", pagesDone, pageCount }),
      });
      setPhase({ kind: "read", file, extraction });
    } catch {
      setPhase({ kind: "empty" });
      setError(
        "Margin couldn't read that PDF. If it opens elsewhere, it may be encrypted — try re-saving it and dropping it in again.",
      );
    }
  }

  return (
    <div
      role="tabpanel"
      id="add-paper-panel-upload"
      aria-labelledby="add-paper-tab-upload"
      tabIndex={0}
      className="flex flex-col gap-4"
    >
      {phase.kind === "empty" && (
        <>
          <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
            The text layer is read here in your browser — the file goes to your
            lab, and nothing else does.
          </p>
          <PdfDropzone
            id="add-paper-file"
            hint="Margin reads it here, then stores it for the lab."
            onFile={read}
          />
        </>
      )}

      {phase.kind === "reading" && (
        <p className="font-sans text-sm text-ink-muted" aria-live="polite">
          {phase.pageCount === 0
            ? "Opening the PDF…"
            : `Reading page ${phase.pagesDone} of ${phase.pageCount}…`}
        </p>
      )}

      {phase.kind === "read" && (
        <ConfirmUpload
          file={phase.file}
          extraction={phase.extraction}
          onStartOver={() => setPhase({ kind: "empty" })}
          onSubmit={async (title, authors) => {
            setError(null);
            setPhase({ kind: "saving" });
            // The upload and the paper are two round trips. If the second one
            // fails, the file is already sitting in storage with nothing
            // pointing at it — and nothing will ever find it again.
            let uploaded: Id<"_storage"> | null = null;
            try {
              const uploadUrl = await generateUploadUrl({ labId });
              uploaded = await uploadPdf(uploadUrl, phase.file);
              const paperId = await createFromUpload({
                labId,
                storageId: uploaded,
                title,
                authors: authors.length > 0 ? authors : undefined,
                pages: phase.extraction.pages,
              });
              router.push(`/app/library/${paperId}`);
            } catch (caught) {
              setPhase({ kind: "read", file: phase.file, extraction: phase.extraction });
              setError(
                readableError(caught, "We couldn't add that paper. Try again."),
              );
              if (uploaded !== null) {
                try {
                  await discardUpload({ labId, storageId: uploaded });
                } catch {
                  // Best effort. The member has already been told what went
                  // wrong; a failed clean-up is not a second thing to say.
                }
              }
            }
          }}
        />
      )}

      {phase.kind === "saving" && (
        <p className="font-sans text-sm text-ink-muted" aria-live="polite">
          Filing it…
        </p>
      )}

      {error !== null && (
        <p role="alert" className={errorClass}>
          {error}
        </p>
      )}
    </div>
  );
}

function ConfirmUpload({
  file,
  extraction,
  onStartOver,
  onSubmit,
}: {
  file: File;
  extraction: PdfExtraction;
  onStartOver: () => void;
  onSubmit: (title: string, authors: string[]) => Promise<void>;
}) {
  const [title, setTitle] = useState(
    extraction.title ?? titleFromFilename(file.name),
  );
  const [authors, setAuthors] = useState(
    (extraction.authors ?? []).join("; "),
  );

  const emptyPages = extraction.pages.filter((page) => page.length === 0).length;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        await onSubmit(title, parseAuthors(authors));
      }}
    >
      <p className="font-sans text-sm text-ink-muted">
        {file.name} · {extraction.pageCount}{" "}
        {extraction.pageCount === 1 ? "page" : "pages"} read
      </p>

      {emptyPages === extraction.pageCount && (
        <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
          No text came out of this PDF — it is probably a scan. It will still
          open in the reader, but annotations won&rsquo;t be able to anchor to
          passages until there is a text layer.
        </p>
      )}

      <div className="flex flex-col gap-2">
        <label htmlFor="paper-title" className={labelClass}>
          Title
        </label>
        <input
          id="paper-title"
          required
          maxLength={500}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          className={inputClass}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="paper-authors" className={labelClass}>
          Authors <span className="normal-case">(separate with semicolons)</span>
        </label>
        <input
          id="paper-authors"
          value={authors}
          onChange={(event) => setAuthors(event.target.value)}
          placeholder="Rosalind Franklin; Raymond Gosling"
          className={inputClass}
        />
      </div>

      <div className="flex items-center gap-4">
        <button type="submit" className={primaryButtonClass}>
          Add to library
        </button>
        <button
          type="button"
          onClick={onStartOver}
          className={secondaryButtonClass}
        >
          Choose another file
        </button>
      </div>
    </form>
  );
}
