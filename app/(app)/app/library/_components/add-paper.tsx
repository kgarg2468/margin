"use client";

import { readableError } from "@/app/(app)/app/_components/errors";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { PdfExtraction } from "@/lib/pdf/extract";
import { describePdfOpenError, extractPdfFile } from "@/lib/pdf/extract";
import {
  errorClass,
  inputClass,
  labelClass,
  panelClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/lib/ui";
import { useAction, useMutation } from "convex/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { PdfDropzone } from "./pdf-dropzone";
import { parseAuthors, titleFromFilename, uploadPdf } from "./pdf-ingest";
import type { TextLayerPhase } from "./use-text-layer";
import { useTextLayer } from "./use-text-layer";

/**
 * Two ways to add a paper, and they are genuinely different acts.
 *
 * A DOI is a lookup: you know the paper exists, you want its record, and
 * whether a readable copy comes with it is out of your hands. A PDF is a
 * deposit: the file is in front of you, and the only open question is what to
 * call it. Tabs rather than one clever box that guesses, because guessing
 * wrong on the way in is expensive later.
 */
export function AddPaper({
  labId,
  onAdded,
}: {
  labId: Id<"labs">;
  /**
   * Fired once a DOI has produced a paper. The library hides this whole panel
   * as soon as it has something on the shelf, which used to take the outcome
   * of the lookup down with it the instant the query updated — so the panel
   * asks to be kept open rather than assuming it will be.
   */
  onAdded?: () => void;
}) {
  const [tab, setTab] = useState<"doi" | "upload">("doi");

  return (
    <section className={`${panelClass} flex flex-col gap-6`}>
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
        <DoiTab labId={labId} onAdded={onAdded} />
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

function DoiTab({
  labId,
  onAdded,
}: {
  labId: Id<"labs">;
  onAdded?: () => void;
}) {
  const createFromDoi = useAction(api.papers.createFromDoi);
  const textLayer = useTextLayer();
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
            const outcome = await createFromDoi({ labId, doi });
            setResult(outcome);
            setDoi("");
            onAdded?.();
            // A copy Margin fetched itself has never been near a browser that
            // could read it, and pdf.js only runs in one. Nobody should have
            // to be told that, or go and find the button: the reader is right
            // here, so do it now and say so. The promise on this panel is that
            // an open-access paper "arrives ready to read".
            if (!outcome.alreadyInLibrary && outcome.hasPdf) {
              void textLayer.read(outcome.paperId);
            }
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
            autoFocus
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

      {/* Keyed to this result's own paper: a second DOI can be submitted while
          the first one's pages are still being read, and the sentence below
          turns "done" into a link to the reader. */}
      {result !== null && (
        <DoiOutcome
          result={result}
          textLayer={textLayer.phaseFor(result.paperId)}
        />
      )}
    </div>
  );
}

/**
 * What happened, and it stays said.
 *
 * This panel used to be unmounted by its own success: the library only shows
 * the add form while the shelf is empty, so the first paper's outcome vanished
 * at the moment the query came back with it. The library now keeps the panel
 * open (`onAdded`), and everything below is written to be read after the fact
 * rather than glimpsed.
 *
 * "Added" alone would still be a small lie in most cases — a paper that was
 * already here may be waiting for its file, and a fetched PDF has no text
 * layer until this browser makes one. Where that last step is running, this
 * says so and then says when it is done; where it can't, it points at the
 * place it gets fixed.
 */
function DoiOutcome({
  result,
  textLayer,
}: {
  result: DoiResult;
  textLayer: TextLayerPhase;
}) {
  const record = `/app/library/${result.paperId}`;
  const extracting = !result.alreadyInLibrary && result.hasPdf;
  const ready = extracting && textLayer.kind === "done";

  function line(): string {
    if (result.alreadyInLibrary) {
      return result.hasPdf
        ? "Already in the library — nothing to add."
        : "Already in the library — it still needs a PDF, open it to attach one.";
    }
    if (!result.hasPdf) {
      return "Added, metadata only. No open-access copy was available, so the reader needs the PDF attaching before anyone can annotate it.";
    }
    switch (textLayer.kind) {
      case "working":
        return `Added. ${textLayer.message}`;
      case "done":
        return "Added, and its text is read — the margins are open.";
      case "failed":
        return `Added, but its text layer wouldn't come out. ${textLayer.message}`;
      default:
        return "Added — open the paper to read its text layer.";
    }
  }

  return (
    <div className="flex flex-col gap-2 border-l-2 border-accent pl-4">
      {/* Polite, and on the container: this sentence is rewritten several
          times as the pages are read, and each rewrite is the same news
          getting more specific rather than a new thing to announce. */}
      <p className="font-serif text-base leading-relaxed text-ink" aria-live="polite">
        {line()}
      </p>
      <Link
        href={ready ? `${record}/read` : record}
        className="tap-target self-start font-sans text-sm text-accent underline-offset-4 hover:underline"
      >
        {ready
          ? `Read ${result.title}`
          : result.hasPdf
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
    } catch (caught) {
      setPhase({ kind: "empty" });
      setError(
        describePdfOpenError(caught) ??
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
