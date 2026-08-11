/**
 * Client-side PDF text extraction.
 *
 * Margin extracts a PDF's text layer in the browser, at upload time, with
 * pdf.js. The file is already there and already decoded by the time a member
 * picks it, so the work is free; doing it server-side would mean rendering
 * PDFs in a Node runtime for no benefit.
 *
 * What comes out is the surface annotations anchor against, so two things
 * matter more than they look:
 *
 * 1. **The normalization is part of the contract.** A `TextPositionSelector`
 *    is an offset into *this* string. If the reader ever normalizes text
 *    differently from the ingester, every stored offset quietly points at the
 *    wrong words. `normalizePdfText` is exported for exactly that reason —
 *    the reader must use it, not its own `replace`.
 * 2. **Page indices are 0-based** and match `anchor.pageIndex`.
 *
 * The module is deliberately free of React and of anything Convex: the reader
 * (next PR) imports `loadPdfjs` to render, and this file is the one place the
 * worker gets configured.
 */

import type {
  PDFDocumentProxy,
  TextItem,
} from "pdfjs-dist/types/src/display/api";

export type PdfExtraction = {
  pageCount: number;
  /** One entry per page, 0-based, normalized. Empty string for a page with no text layer. */
  pages: string[];
  /** From the PDF's own metadata, when it has any worth trusting. */
  title?: string;
  authors?: string[];
};

export type ExtractOptions = {
  /** Called after each page. Papers are short but scans are slow; the UI shows a count. */
  onProgress?: (pagesDone: number, pageCount: number) => void;
  /**
   * Withdraw the read. Checked between pages, which is the finest grain
   * available — one page's `getTextContent` is a single worker round trip and
   * is not interruptible — and honoured by the `finally` below, which destroys
   * the loading task whichever way this ends. Optional and additive: the two
   * callers that never cancel are unchanged by it.
   */
  signal?: AbortSignal;
};

/**
 * Collapse every run of whitespace to a single space and trim.
 *
 * PDFs have no idea what a line is: pdf.js hands back positioned fragments,
 * and where one ends and the next begins is a function of kerning, not of
 * language. Normalizing away the difference is what lets a quote selected in
 * the publisher's two-column layout still match the preprint's one-column one.
 */
export function normalizePdfText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

/**
 * The pdf.js entry point, loaded once and shared.
 *
 * Dynamically imported so the ~1 MB library never lands in the server bundle
 * or in the first paint of a page that has no PDF on it. The worker comes from
 * the package via `new URL(..., import.meta.url)`, which both webpack and
 * Turbopack turn into a real bundled asset — no file copied into `public/`,
 * nothing to keep in sync with the pinned version.
 */
export async function loadPdfjs(): Promise<typeof import("pdfjs-dist")> {
  if (typeof window === "undefined") {
    throw new Error("pdf.js runs in the browser only.");
  }
  pdfjsPromise ??= (async () => {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
    return pdfjs;
  })();
  return await pdfjsPromise;
}

function isTextItem(item: unknown): item is TextItem {
  return typeof item === "object" && item !== null && "str" in item;
}

async function extractPageText(
  doc: PDFDocumentProxy,
  pageNumber: number,
): Promise<string> {
  const page = await doc.getPage(pageNumber);
  try {
    const content = await page.getTextContent();
    let text = "";
    for (const item of content.items) {
      if (!isTextItem(item)) {
        // Marked-content markers carry structure, not characters.
        continue;
      }
      text += item.str;
      text += " ";
    }
    return normalizePdfText(text);
  } finally {
    page.cleanup();
  }
}

/**
 * A PDF's `Title` is right about as often as it is wrong — plenty of them say
 * `Microsoft Word - draft3.doc` or the LaTeX job name. Anything that looks
 * like a filename or a toolchain artefact is worse than nothing, because the
 * member would have to notice and delete it.
 */
function usableTitle(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const title = normalizePdfText(raw);
  if (title.length < 4 || title.length > 500) {
    return undefined;
  }
  if (/\.(pdf|doc|docx|dvi|tex|indd|qxd)$/i.test(title)) {
    return undefined;
  }
  if (/^(untitled|microsoft word|pdfsam|main|paper|manuscript)\b/i.test(title)) {
    return undefined;
  }
  return title;
}

/**
 * Split a PDF `Author` field into names. Semicolons and "and" are safe
 * separators; a bare comma is not ("Smith, John" is one person), so a field
 * with neither stays a single name and the member fixes it in the form.
 */
function splitAuthors(raw: unknown): string[] | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const field = normalizePdfText(raw);
  if (field.length === 0 || field.length > 1000) {
    return undefined;
  }
  const authors = field
    .split(/;| and (?=[A-Z])/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  return authors.length > 0 ? authors : undefined;
}

/**
 * Read every page of a PDF and hand back its text.
 *
 * Pages are read in order rather than in parallel: pdf.js serializes through
 * one worker anyway, and sequential reads let `onProgress` mean something.
 */
export async function extractPdf(
  data: ArrayBuffer,
  options: ExtractOptions = {},
): Promise<PdfExtraction> {
  // Before the import, not after: `loadPdfjs` pulls ~1 MB over the network on
  // first use, and a cancel that lands during it should not go on to open the
  // document it was called off from.
  options.signal?.throwIfAborted();
  const pdfjs = await loadPdfjs();

  // pdf.js transfers ownership of the buffer it is given to its worker, so it
  // gets a copy — otherwise the caller's ArrayBuffer comes back detached and
  // the same File can no longer be uploaded.
  const loadingTask = pdfjs.getDocument({ data: data.slice(0) });
  const doc = await loadingTask.promise;

  try {
    const pageCount = doc.numPages;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      options.signal?.throwIfAborted();
      pages.push(await extractPageText(doc, pageNumber));
      options.onProgress?.(pageNumber, pageCount);
    }

    let title: string | undefined;
    let authors: string[] | undefined;
    try {
      const metadata = await doc.getMetadata();
      const info = metadata.info as Record<string, unknown> | undefined;
      title = usableTitle(info?.Title);
      authors = splitAuthors(info?.Author);
    } catch {
      // A malformed metadata dictionary is not a reason to lose the text.
    }

    return { pageCount, pages, title, authors };
  } finally {
    await loadingTask.destroy();
  }
}

/** `extractPdf` for a file straight off an `<input type="file">` or a drop. */
export async function extractPdfFile(
  file: File,
  options: ExtractOptions = {},
): Promise<PdfExtraction> {
  return await extractPdf(await file.arrayBuffer(), options);
}

/**
 * Say what pdf.js actually objected to, when it objected to something we can
 * name.
 *
 * Every failure to open a file used to arrive at the member as one sentence
 * that hedged across all of them — "it may be encrypted, try re-saving it" —
 * which is the right advice for roughly one case and noise for the rest. The
 * two cases worth separating are the two a member can do something about: a
 * PDF that wants a password, and a file that isn't a readable PDF at all. Both
 * have a different fix, and neither is guessable from the hedge.
 *
 * pdf.js signals them with its own exception classes, but they arrive here
 * across a worker boundary and through a `BaseException` whose prototype is a
 * plain `Error`, so `instanceof` is not something to rely on — the class name
 * is carried deliberately on `name`, and that is what this reads. Anything
 * else is a genuine surprise: it returns `undefined` and the call site keeps
 * whatever it was going to say, because a wrong specific is worse than a
 * vague true one.
 */
export function describePdfOpenError(caught: unknown): string | undefined {
  if (typeof caught !== "object" || caught === null || !("name" in caught)) {
    return undefined;
  }
  switch ((caught as { name: unknown }).name) {
    case "PasswordException":
      return "This PDF is password-protected, so Margin can't read it. Open it with the password, save or print a fresh copy without one, and drop that in instead.";
    case "InvalidPDFException":
      return "This file is damaged, or it isn't a PDF underneath. If it opens elsewhere, re-download or re-save it and try again.";
    default:
      return undefined;
  }
}

/** Does this file look like something pdf.js can open? Checked before we bother reading it. */
export function isPdfFile(file: File): boolean {
  return (
    file.type === "application/pdf" || /\.pdf$/i.test(file.name)
  );
}
