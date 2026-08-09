import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseBibTeX } from "./bibtex";

const zoteroBib = readFileSync(
  new URL("./fixtures/zotero.bib", import.meta.url),
  "utf8",
);

describe("parseBibTeX", () => {
  it("parses a realistic Zotero export", () => {
    expect(parseBibTeX(zoteroBib)).toEqual([
      {
        title: "Reading at the Margins: An Open-Science Study",
        authors: [
          "Ana García",
          "John P. Smith",
          "Open Science Collaboration",
        ],
        year: 2024,
        venue: "Journal of Collaborative Research",
        doi: "https://doi.org/10.5555/MARGIN.2024.17",
        abstract:
          "Researchers read together across laboratories, languages, and time zones.",
        url: "https://example.org/articles/margins",
      },
      {
        title: "Notes on the Analytical Engine, with examples",
        authors: ["Ada Lovelace", "Charles Babbage"],
        year: 1843,
        venue: "Proceedings of Imagined Machines",
      },
    ]);
  });

  it("handles parenthesized entries, quoted commas, nested braces, and CRLF", () => {
    const input = [
      "@misc(example,",
      '  title = "A title, with punctuation and {Protected {Words}}",',
      "  author = {Curie, Marie and Pierre Curie},",
      '  year = "Published online in 1911",',
      "  url = {https://example.org/a,b}",
      ")",
    ].join("\r\n");

    expect(parseBibTeX(input)).toEqual([
      {
        title: "A title, with punctuation and Protected Words",
        authors: ["Marie Curie", "Pierre Curie"],
        year: 1911,
        url: "https://example.org/a,b",
      },
    ]);
  });

  it("splits authors only on top-level 'and' separators", () => {
    const input = `@book{teams,
      title = {Teams},
      author = {{Research and Development Group} and Hopper, Grace Murray}
    }`;

    expect(parseBibTeX(input)[0]?.authors).toEqual([
      "Research and Development Group",
      "Grace Murray Hopper",
    ]);
  });

  it("skips directives, unknown fields, malformed fragments, and untitled entries", () => {
    const input = `
      @string{journal = "Ignored"}
      this is not an entry
      @comment{also ignored}
      @article{missing, author = {Nobody}}
      @article{kept, title = {Still here}, x-custom = {ignored}}
    `;

    expect(parseBibTeX(input)).toEqual([
      { title: "Still here", authors: [] },
    ]);
  });

  it("unescapes common BibTeX punctuation without damaging Unicode", () => {
    const input = String.raw`@article{unicode,
      title = {Müller \& Søndergaard: 100\% reproducible},
      author = {Müller, Léo}
    }`;

    expect(parseBibTeX(input)).toEqual([
      {
        title: "Müller & Søndergaard: 100% reproducible",
        authors: ["Léo Müller"],
      },
    ]);
  });
});
