import type { Id } from "@/convex/_generated/dataModel";

export type UploadOptions = {
  /** Bytes sent, and the file's size — called many times a second. */
  onProgress?: (loaded: number, total: number) => void;
  /** Withdraw the upload. Rejects with the signal's reason, an `AbortError`. */
  signal?: AbortSignal;
};

/**
 * The upload half of ingest: the browser POSTs the file straight to the URL
 * Convex minted for it, and the function it calls afterwards only ever sees
 * the resulting storage id. Nothing the size of a PDF passes through a Convex
 * function argument.
 *
 * `XMLHttpRequest`, in 2026, and on purpose. `fetch` cannot report a request
 * body's progress in any browser — there is no event and no readable
 * counterpart to `Response.body` for the request side — and a member watching
 * a 40 MB scan go up deserves better than a sentence that does not move.
 * `xhr.upload.progress` is the only cross-browser answer, and `xhr.abort()`
 * comes with it, so the ceremony below buys both halves at once.
 */
export function uploadPdf(
  uploadUrl: string,
  file: File,
  { onProgress, signal }: UploadOptions = {},
): Promise<Id<"_storage">> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();

    const xhr = new XMLHttpRequest();
    xhr.open("POST", uploadUrl);
    // Declared, not forwarded. `file.type` is whatever the OS guessed from
    // the extension and is routinely blank or `application/octet-stream` for
    // a perfectly good PDF — and the stored content type is what the mutation
    // checks before it will let a paper point at this blob. By here pdf.js has
    // already parsed the file, which is better evidence than the guess.
    xhr.setRequestHeader("Content-Type", "application/pdf");

    xhr.upload.addEventListener("progress", (event) => {
      // The size is known from the `File` regardless, so a browser withholding
      // `lengthComputable` costs the readout nothing.
      onProgress?.(event.loaded, event.lengthComputable ? event.total : file.size);
    });

    xhr.addEventListener("load", () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`Upload failed with status ${xhr.status}.`));
        return;
      }
      try {
        const body = JSON.parse(xhr.responseText) as { storageId: Id<"_storage"> };
        resolve(body.storageId);
      } catch {
        reject(new Error("The upload finished, but Margin couldn't read the reply."));
      }
    });

    xhr.addEventListener("error", () =>
      reject(new Error("The upload didn't reach the server.")),
    );
    xhr.addEventListener("abort", () =>
      reject(signal?.reason ?? new DOMException("Upload cancelled.", "AbortError")),
    );

    // A cancel that lands after the response did is a no-op here — the promise
    // has already settled. The caller re-reads `signal.aborted` afterwards and
    // discards the blob, because a file nothing points at is never found again.
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });

    xhr.send(file);
  });
}

/** A filename is a poor title, but it beats an empty field. `smith-et-al-2019.pdf` → `smith et al 2019`. */
export function titleFromFilename(filename: string): string {
  return filename
    .replace(/\.pdf$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Authors are one-per-semicolon in the form, because commas live inside names. */
export function parseAuthors(input: string): string[] {
  return input
    .split(/[;\n]/)
    .map((author) => author.trim())
    .filter((author) => author.length > 0);
}
