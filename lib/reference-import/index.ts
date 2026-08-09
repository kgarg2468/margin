import { parseBibTeX } from "./bibtex";
import { parseRis } from "./ris";
import type { ReferenceEntry, ReferenceFormat } from "./types";

export type { ReferenceEntry, ReferenceFormat } from "./types";

export function detectReferenceFormat(
  input: string,
  fileName?: string,
): ReferenceFormat | null {
  const extension = fileName?.split(".").pop()?.toLowerCase();
  if (extension === "bib") {
    return "bibtex";
  }
  if (extension === "ris") {
    return "ris";
  }
  if (/(?:^|\n)\s*@[a-z][\w-]*\s*[{(]/i.test(input)) {
    return "bibtex";
  }
  if (/^\s*TY\s*-\s*\S+/m.test(input)) {
    return "ris";
  }
  return null;
}

export function parseReferenceImport(
  input: string,
  fileName?: string,
): { format: ReferenceFormat; entries: ReferenceEntry[] } {
  const format = detectReferenceFormat(input, fileName);
  if (format === null) {
    throw new Error(
      "Paste BibTeX or RIS text, or choose a .bib or .ris export.",
    );
  }
  const entries = format === "bibtex" ? parseBibTeX(input) : parseRis(input);
  if (entries.length === 0) {
    throw new Error("No references with titles were found in that export.");
  }
  return { format, entries };
}
