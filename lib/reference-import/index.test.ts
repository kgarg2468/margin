import { describe, expect, it } from "vitest";
import {
  detectReferenceFormat,
  parseReferenceImport,
} from "./index";

describe("detectReferenceFormat", () => {
  it("uses a supported file extension when present", () => {
    expect(detectReferenceFormat("not enough to inspect", "library.BIB")).toBe(
      "bibtex",
    );
    expect(detectReferenceFormat("not enough to inspect", "library.ris")).toBe(
      "ris",
    );
  });

  it("recognizes pasted BibTeX and RIS from their content", () => {
    expect(detectReferenceFormat("  @article{x, title={One}} ")).toBe(
      "bibtex",
    );
    expect(detectReferenceFormat("TY  - JOUR\nTI  - One\nER  -")).toBe(
      "ris",
    );
  });

  it("recognizes BibTeX after an export comment", () => {
    expect(
      detectReferenceFormat(
        "% Better BibTeX export\n\n@article{x, title={One}}",
      ),
    ).toBe("bibtex");
  });

  it("returns null for unrecognized text", () => {
    expect(detectReferenceFormat("A plain bibliography citation.")).toBeNull();
  });
});

describe("parseReferenceImport", () => {
  it("returns the detected format with parsed entries", () => {
    expect(
      parseReferenceImport("@book{x, title={A Book}}", "export.txt"),
    ).toEqual({
      format: "bibtex",
      entries: [{ title: "A Book", authors: [] }],
    });
  });

  it("explains unrecognized and empty exports", () => {
    expect(() => parseReferenceImport("ordinary text")).toThrow(
      "Paste BibTeX or RIS text, or choose a .bib or .ris export.",
    );
    expect(() => parseReferenceImport("@comment{nothing here}")).toThrow(
      "No references with titles were found in that export.",
    );
  });
});
