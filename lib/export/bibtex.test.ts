import { describe, expect, it } from "vitest";
import { papersToBibtex, type BibtexPaper } from "./bibtex";

describe("papersToBibtex", () => {
  it("writes the metadata Margin already has and preserves unicode", () => {
    const papers: BibtexPaper[] = [
      {
        title: "Über 100% CRISPR in {Living} Cells",
        authors: ["Ada Lovelace", "Élodie Durand"],
        year: 2026,
        venue: "Journal of A&B #1_2 ~ ^ $ \\",
        doi: "10.1000/example",
        abstract: "A result with {boundaries} and naïve participants.",
      },
    ];

    expect(papersToBibtex(papers)).toBe(
      "@article{Lovelace2026Uber,\n" +
        "  title = {{Über} 100\\% {CRISPR} in \\{{Living}\\} {Cells}},\n" +
        "  author = {Ada Lovelace and Élodie Durand},\n" +
        "  year = {2026},\n" +
        "  journal = {Journal of A\\&B \\#1\\_2 \\textasciitilde{} \\textasciicircum{} \\$ \\textbackslash{}},\n" +
        "  doi = {10.1000/example},\n" +
        "  abstract = {A result with \\{boundaries\\} and naïve participants.}\n" +
        "}\n",
    );
  });

  it("deduplicates colliding cite keys with stable alphabetic suffixes", () => {
    const papers: BibtexPaper[] = [
      { title: "Deep models", authors: ["Jane Doe"], year: 2024 },
      { title: "Deep methods", authors: ["Jane Doe"], year: 2024 },
      { title: "Deep measures", authors: ["Jane Doe"], year: 2024 },
      { title: "Different work", authors: ["Jane Doe"], year: 2024 },
    ];

    const bibtex = papersToBibtex(papers);

    expect(bibtex).toContain("@article{Doe2024Deepa,");
    expect(bibtex).toContain("@article{Doe2024Deepb,");
    expect(bibtex).toContain("@article{Doe2024Deepc,");
    expect(bibtex).toContain("@article{Doe2024Different,");
  });

  it("falls back predictably when author, year, or a word-like title is absent", () => {
    expect(papersToBibtex([{ title: "---" }])).toContain(
      "@article{AnonndPaper,",
    );
  });
});
