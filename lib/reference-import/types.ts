export type ReferenceFormat = "bibtex" | "ris";

/** Metadata shared by BibTeX and RIS before it enters either paper path. */
export type ReferenceEntry = {
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  doi?: string;
  abstract?: string;
  url?: string;
};
