"use client";

import { isPdfFile } from "@/lib/pdf/extract";
import { useRef, useState } from "react";

/**
 * The one place a PDF enters the product: a labelled drop target that is also
 * a file input, because half of researchers drag and half click.
 *
 * It validates nothing but the file type — everything after that (reading the
 * text layer, uploading, recording the paper) belongs to whichever flow is
 * using it, since the library's "add a paper" and a paper's "attach the PDF"
 * end in different places.
 */
export type FileOffer =
  | { kind: "ignored" }
  | { kind: "rejected" }
  | { kind: "accepted"; file: File };

/**
 * What a file arriving at this zone is allowed to do, decided once for both
 * ways in.
 *
 * `disabled` is the reason this is a function and not three lines inside a
 * handler. It used to be a prop that styled the zone and stopped the click, and
 * a drag-and-drop went straight past it into `onFile` — a second attach
 * starting on top of one already running, two files landing on one paper, and a
 * progress bar showing two runs interleaved with a cancel that could only reach
 * one of them. A refusal has to be answered at every entrance or it is
 * decoration.
 *
 * `accepted` carries the file so that having been accepted and having something
 * to accept cannot come apart at the call site.
 */
export function offerFile(
  file: File | undefined,
  disabled: boolean,
): FileOffer {
  if (disabled || file === undefined) {
    return { kind: "ignored" };
  }
  return isPdfFile(file) ? { kind: "accepted", file } : { kind: "rejected" };
}

export function PdfDropzone({
  id,
  hint,
  disabled = false,
  onFile,
}: {
  id: string;
  hint: string;
  disabled?: boolean;
  onFile: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [rejected, setRejected] = useState(false);

  function accept(file: File | undefined) {
    const offer = offerFile(file, disabled);
    if (offer.kind === "ignored") {
      return;
    }
    if (offer.kind === "rejected") {
      setRejected(true);
      return;
    }
    setRejected(false);
    onFile(offer.file);
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        // Withholding `preventDefault` is how an element says it is not a drop
        // target: the browser then refuses the drop itself and shows the "no"
        // cursor, so the gesture is answered before it is finished rather than
        // after. `dragover` is where that is decided — there is no `dragenter`
        // handler here, and adding one would only repeat this answer.
        onDragOver={(event) => {
          if (disabled) {
            return;
          }
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          // Unconditional, including while disabled. Left to the browser, a
          // dropped PDF replaces the page with itself — the one outcome worse
          // than a second attach. `accept` is what declines the file; this only
          // stops the window from being taken.
          event.preventDefault();
          setOver(false);
          accept(event.dataTransfer.files[0]);
        }}
        className={
          "flex w-full flex-col items-center gap-1 rounded-md border border-dashed px-6 py-10 " +
          "pressable disabled:cursor-not-allowed disabled:opacity-50 " +
          // A zone that went busy under a hovering drag would otherwise keep the
          // lit border it was given while it was still willing.
          (over && !disabled
            ? "border-accent bg-highlight"
            : "border-rule bg-surface hover:border-ink-faint")
        }
      >
        <span className="font-serif text-lg text-ink">
          Drop a PDF here, or choose a file
        </span>
        <span className="font-sans text-xs text-ink-faint">{hint}</span>
      </button>

      {/*
        The real control is the button above; this exists only so that
        clicking it can open a file picker. Left focusable it would be a
        second, invisible tab stop with the same job and no label — so it is
        taken out of the tab order and the button keeps it.
      */}
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept="application/pdf,.pdf"
        tabIndex={-1}
        className="sr-only"
        onChange={(event) => {
          accept(event.target.files?.[0]);
          // Let the same file be picked twice — after a failed attempt, the
          // second try would otherwise fire no change event at all.
          event.target.value = "";
        }}
      />

      {rejected && (
        <p role="alert" className="font-sans text-sm text-ink-muted">
          That isn&rsquo;t a PDF. Margin reads the text layer out of the file,
          so it needs the real thing.
        </p>
      )}
    </div>
  );
}
