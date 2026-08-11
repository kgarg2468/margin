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
    if (file === undefined) {
      return;
    }
    if (!isPdfFile(file)) {
      setRejected(true);
      return;
    }
    setRejected(false);
    onFile(file);
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          accept(event.dataTransfer.files[0]);
        }}
        className={
          "flex w-full flex-col items-center gap-1 rounded-md border border-dashed px-6 py-10 " +
          "pressable disabled:cursor-not-allowed disabled:opacity-50 " +
          (over
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
