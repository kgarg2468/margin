import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRis } from "./ris";

const zoteroRis = readFileSync(
  new URL("./fixtures/zotero.ris", import.meta.url),
  "utf8",
);

describe("parseRis", () => {
  it("parses a realistic Zotero export", () => {
    expect(parseRis(zoteroRis)).toEqual([
      {
        title: "Shared annotations across disciplinary boundaries",
        authors: ["Chidi Okafor", "Zoë Martin"],
        year: 2023,
        venue: "Research Practice Quarterly",
        doi: "10.7777/rpq.2023.41",
        abstract: "A realistic Zotero export with Unicode names.",
        url: "https://example.org/rpq/shared-annotations",
      },
      {
        title: "Preserving context in digital margins",
        authors: ["Mei Lin Ng", "Samir Patel"],
        year: 2021,
        venue: "Proceedings of the Context Conference",
        abstract:
          "The first line of an abstract continues after the tagged line.",
      },
    ]);
  });

  it("accepts CRLF and every supported alternate tag", () => {
    const input = [
      "TY  - JOUR",
      "T1  - Alternate title",
      "A1  - Last, First",
      "Y1  - 1999/12/31",
      "JF  - Full Journal Name",
      "ER  -",
    ].join("\r\n");

    expect(parseRis(input)).toEqual([
      {
        title: "Alternate title",
        authors: ["First Last"],
        year: 1999,
        venue: "Full Journal Name",
      },
    ]);
  });

  it("uses TI, AU, PY, and JO before their fallback tags", () => {
    const input = `TY  - JOUR
T1  - Fallback title
TI  - Preferred title
A1  - Fallback, Author
AU  - Preferred Author
Y1  - 1998
PY  - 2002
T2  - Fallback Venue
JF  - Full Venue
JO  - Short Venue
ER  -`;

    expect(parseRis(input)).toEqual([
      {
        title: "Preferred title",
        authors: ["Preferred Author"],
        year: 2002,
        venue: "Short Venue",
      },
    ]);
  });

  it("skips unknown tags and untitled records, and keeps an unterminated final record", () => {
    const input = `TY  - JOUR
AU  - Nobody
ZZ  - ignored
ER  -
TY  - BOOK
TI  - Kept at end of file
XX  - ignored`;

    expect(parseRis(input)).toEqual([
      { title: "Kept at end of file", authors: [] },
    ]);
  });
});
