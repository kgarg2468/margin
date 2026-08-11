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
  linkButtonClass,
  panelClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/lib/ui";
import { useAction, useMutation } from "convex/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { PdfDropzone } from "./pdf-dropzone";
import { parseAuthors, titleFromFilename, uploadPdf } from "./pdf-ingest";
import { ReferenceImport } from "./reference-import";
import {
  cancelOffer,
  isCancellation,
  percentSent,
  stageAnnouncement,
  stageProgress,
} from "./upload-flow";
import type { TextLayerPhase } from "./use-text-layer";
import { useTextLayer } from "./use-text-layer";

/**
 * Three ways to add a paper, and they are genuinely different acts.
 *
 * A DOI is a lookup: you know the paper exists, you want its record, and
 * whether a readable copy comes with it is out of your hands. A PDF is a
 * deposit: the file is in front of you, and the only open question is what to
 * call it. A reference export is a batch whose records need reviewing. Tabs
 * rather than one clever box that guesses, because guessing wrong on the way
 * in is expensive later.
 */
export function AddPaper({
  labId,
  onAdded,
  onDismiss,
}: {
  labId: Id<"labs">;
  /**
   * Fired once an add path has produced a paper. The library hides this panel
   * as soon as it has something on the shelf, which used to take the outcome
   * of the lookup down with it the instant the query updated — so the panel
   * asks to be kept open rather than assuming it will be.
   */
  onAdded?: () => void;
  /**
   * Escape, answered from inside the panel rather than at the window.
   *
   * The library's own key handler ignores anything typed into a field, which is
   * the right rule for `/` and `a` and the wrong one for the only key that
   * closes this: the DOI input takes focus the moment the panel opens, so `a`
   * then `esc` would have reached nothing at all. A panel that owns a caret has
   * to answer for its own dismissal — the same conclusion `composer-escape.ts`
   * reached, on the same ground: Escape is never a keystroke that types
   * something, so a field has no claim on it.
   */
  onDismiss?: () => void;
}) {
  const [tab, setTab] = useState<"doi" | "upload" | "references">("doi");

  return (
    <section
      className={`${panelClass} flex flex-col gap-6`}
      // Bubbled from wherever focus is — a tab, a text field, the dropzone.
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onDismiss?.();
        }
      }}
    >
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
        <TabButton
          id="references"
          label="Import references"
          active={tab === "references"}
          onSelect={() => setTab("references")}
        />
      </div>

      {tab === "doi" ? (
        <DoiTab labId={labId} onAdded={onAdded} />
      ) : tab === "upload" ? (
        <UploadTab labId={labId} />
      ) : (
        <ReferenceImport labId={labId} onAdded={onAdded} />
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
        "-mb-px border-b-2 pb-2 font-sans text-sm pressable " +
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
 *
 * The paper is named once on this screen and it is named on the shelf below,
 * so this link names the act instead: the sentence above has just said which
 * paper this is about, and repeating its title here only made two entries for
 * one paper in the same field of view.
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
          ? "Read it now"
          : result.hasPdf
            ? "Open its record"
            : "Attach the PDF"}
      </Link>
    </div>
  );
}

/* ------------------------------------------------------------- Upload --- */

/**
 * The file is carried through `sending` and `filing`, not dropped at the door.
 *
 * `ConfirmUpload` used to be rendered only in `read`, so submitting unmounted
 * it and a failure remounted it — with its `useState` initialisers re-deriving
 * title and authors from the PDF's own metadata. A title the member had
 * corrected by hand was silently replaced by `Microsoft Word - draft3.doc` at
 * the exact moment they were being told to try again. Keeping the same element
 * in the same slot across all three stages is the fix: the component never
 * unmounts, so there is no state to lose and nothing to hoist.
 */
type UploadPhase =
  | { kind: "empty" }
  | { kind: "reading"; pagesDone: number; pageCount: number }
  | { kind: "read"; file: File; extraction: PdfExtraction }
  | {
      kind: "sending";
      file: File;
      extraction: PdfExtraction;
      loaded: number;
      total: number;
    }
  | { kind: "filing"; file: File; extraction: PdfExtraction };

function UploadTab({ labId }: { labId: Id<"labs"> }) {
  const generateUploadUrl = useMutation(api.papers.generateUploadUrl);
  const createFromUpload = useMutation(api.papers.createFromUpload);
  const discardUpload = useMutation(api.papers.discardUpload);
  const router = useRouter();

  const [phase, setPhase] = useState<UploadPhase>({ kind: "empty" });
  const [error, setError] = useState<string | null>(null);
  /** Not an error: what a withdrawal left behind, in the member's own words. */
  const [note, setNote] = useState<string | null>(null);

  /** Whatever is currently in flight, so the cancel control has something to pull. */
  const inFlight = useRef<AbortController | null>(null);
  /**
   * Which submit is allowed to speak. An abandoned `filing` leaves a mutation
   * running that will resolve into a component that has moved on; without this
   * it would navigate away from a form the member had gone back to.
   */
  const attempt = useRef(0);

  async function read(file: File) {
    setError(null);
    setNote(null);
    const controller = new AbortController();
    inFlight.current = controller;
    setPhase({ kind: "reading", pagesDone: 0, pageCount: 0 });
    try {
      const extraction = await extractPdfFile(file, {
        signal: controller.signal,
        onProgress: (pagesDone, pageCount) =>
          setPhase({ kind: "reading", pagesDone, pageCount }),
      });
      setPhase({ kind: "read", file, extraction });
    } catch (caught) {
      setPhase({ kind: "empty" });
      if (isCancellation(caught)) {
        setNote("Stopped. Nothing was read and nothing was sent.");
        return;
      }
      setError(
        describePdfOpenError(caught) ??
          "Margin couldn't read that PDF. If it opens elsewhere, it may be encrypted — try re-saving it and dropping it in again.",
      );
    } finally {
      release(controller);
    }
  }

  /**
   * Clear the slot, but only if it is still this run's.
   *
   * An abandoned `filing` leaves `createFromUpload` in flight; it resolves
   * minutes later into a component the member has since given another file to.
   * A `finally` that cleared unconditionally would take the *new* run's
   * controller with it, and the cancel button on screen would quietly stop
   * cancelling anything — the one failure this whole task exists to prevent.
   */
  function release(controller: AbortController) {
    if (inFlight.current === controller) {
      inFlight.current = null;
    }
  }

  async function submit(
    file: File,
    extraction: PdfExtraction,
    title: string,
    authors: string[],
  ) {
    setError(null);
    setNote(null);
    const mine = ++attempt.current;
    const controller = new AbortController();
    inFlight.current = controller;
    setPhase({ kind: "sending", file, extraction, loaded: 0, total: file.size });

    // The upload and the paper are two round trips. If the second one fails,
    // the file is already sitting in storage with nothing pointing at it — and
    // nothing will ever find it again.
    let uploaded: Id<"_storage"> | null = null;
    try {
      const uploadUrl = await generateUploadUrl({ labId });
      uploaded = await uploadPdf(uploadUrl, file, {
        signal: controller.signal,
        onProgress: (loaded, total) =>
          setPhase({ kind: "sending", file, extraction, loaded, total }),
      });
      // The abort raced the response and lost. The bytes are in storage all
      // the same, so they get discarded rather than orphaned.
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }
      setPhase({ kind: "filing", file, extraction });
      const paperId = await createFromUpload({
        labId,
        storageId: uploaded,
        title,
        authors: authors.length > 0 ? authors : undefined,
        pages: extraction.pages,
      });
      if (attempt.current !== mine) {
        return;
      }
      router.push(`/app/library/${paperId}`);
    } catch (caught) {
      if (attempt.current !== mine) {
        return;
      }
      setPhase({ kind: "read", file, extraction });
      if (isCancellation(caught)) {
        setNote("Cancelled. Nothing was added, and the file is still here.");
      } else {
        setError(readableError(caught, "We couldn't add that paper. Try again."));
      }
      if (uploaded !== null) {
        try {
          await discardUpload({ labId, storageId: uploaded });
        } catch {
          // Best effort. The member has already been told what happened; a
          // failed clean-up is not a second thing to say.
        }
      }
    } finally {
      release(controller);
    }
  }

  const offer = cancelOffer(phase);

  function withdraw() {
    if (offer === null) {
      return;
    }
    if (offer.kind === "abort") {
      inFlight.current?.abort();
      return;
    }
    // Nothing to abort: `createFromUpload` is one round trip and cannot be
    // recalled. What can be handed back is the form and the truth.
    attempt.current += 1;
    if (phase.kind === "filing") {
      setPhase({ kind: "read", file: phase.file, extraction: phase.extraction });
    }
    setNote(
      "Stopped waiting. If it did land, the paper is on the shelf already — look before adding it again.",
    );
  }

  const progress = stageProgress(phase);

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
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <Progress phase={phase} />
          <CancelControl offer={offer} onWithdraw={withdraw} />
        </div>
      )}

      {/* One slot, three stages. The element position must not change between
          them: React keeps this component's state only while it keeps the same
          place in the tree, and its state is the member's typing. */}
      {(phase.kind === "read" ||
        phase.kind === "sending" ||
        phase.kind === "filing") && (
        <ConfirmUpload
          file={phase.file}
          extraction={phase.extraction}
          busy={phase.kind !== "read"}
          progress={progress === null ? null : <Progress phase={phase} />}
          cancel={<CancelControl offer={offer} onWithdraw={withdraw} />}
          onStartOver={() => {
            // A failure that is still on screen under a fresh dropzone is a
            // failure about a file that is no longer there.
            setError(null);
            setNote(null);
            setPhase({ kind: "empty" });
          }}
          onSubmit={(title, authors) =>
            submit(phase.file, phase.extraction, title, authors)
          }
        />
      )}

      {/* The only thing that speaks. See `stageAnnouncement`. */}
      <p className="sr-only" aria-live="polite">
        {stageAnnouncement(phase)}
      </p>

      {note !== null && (
        <p className="font-sans text-sm text-ink-muted">{note}</p>
      )}
      {error !== null && (
        <p role="alert" className={errorClass}>
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The count, for eyes and for anyone who asks for it — and for nobody who
 * didn't. A `progressbar` is polled rather than announced, which is the whole
 * difference between a readout and 340 interruptions.
 */
function Progress({ phase }: { phase: UploadPhase }) {
  const text = stageProgress(phase);
  if (text === null) {
    return null;
  }
  const percent =
    phase.kind === "sending" ? percentSent(phase.loaded, phase.total) : null;
  return (
    <p
      role="progressbar"
      aria-valuetext={text}
      {...(percent === null
        ? {}
        : { "aria-valuenow": percent, "aria-valuemin": 0, "aria-valuemax": 100 })}
      className="font-sans text-sm tabular-nums text-ink-muted"
    >
      {text}
    </p>
  );
}

function CancelControl({
  offer,
  onWithdraw,
}: {
  offer: { kind: "abort" | "abandon"; label: string } | null;
  onWithdraw: () => void;
}) {
  if (offer === null) {
    return null;
  }
  return (
    <button
      type="button"
      onClick={onWithdraw}
      className={`${linkButtonClass} tap-target text-xs`}
    >
      {offer.label}
    </button>
  );
}

/**
 * The fields, and they stay put.
 *
 * This form used to be rendered only while the phase was `read`, so submitting
 * unmounted it and a failed save remounted it — re-deriving title and authors
 * from the PDF's metadata and throwing away whatever the member had typed, at
 * the one moment they were being asked to try again. It now stays mounted
 * through the upload and the save, disabled rather than gone: the corrections
 * are still on screen while the bytes move, and still there if they don't land.
 * That is also where the cancel control has to live, because this is the only
 * thing on screen during the wait.
 */
function ConfirmUpload({
  file,
  extraction,
  busy,
  progress,
  cancel,
  onStartOver,
  onSubmit,
}: {
  file: File;
  extraction: PdfExtraction;
  busy: boolean;
  progress: ReactNode;
  cancel: ReactNode;
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
          disabled={busy}
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
          disabled={busy}
          value={authors}
          onChange={(event) => setAuthors(event.target.value)}
          placeholder="Rosalind Franklin; Raymond Gosling"
          className={inputClass}
        />
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <button type="submit" disabled={busy} className={primaryButtonClass}>
          {busy ? "Adding…" : "Add to library"}
        </button>
        {busy ? (
          cancel
        ) : (
          <button
            type="button"
            onClick={onStartOver}
            className={secondaryButtonClass}
          >
            Choose another file
          </button>
        )}
        {progress}
      </div>
    </form>
  );
}
