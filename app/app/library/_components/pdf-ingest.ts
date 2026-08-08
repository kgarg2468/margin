import type { Id } from "@/convex/_generated/dataModel";

/**
 * The upload half of ingest: the browser POSTs the file straight to the URL
 * Convex minted for it, and the function it calls afterwards only ever sees
 * the resulting storage id. Nothing the size of a PDF passes through a Convex
 * function argument.
 */
export async function uploadPdf(
  uploadUrl: string,
  file: File,
): Promise<Id<"_storage">> {
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": file.type || "application/pdf" },
    body: file,
  });
  if (!response.ok) {
    throw new Error(`Upload failed with status ${response.status}.`);
  }
  const body = (await response.json()) as { storageId: Id<"_storage"> };
  return body.storageId;
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
