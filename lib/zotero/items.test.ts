import { describe, expect, it } from "vitest";
import { referenceIdentity } from "../reference-import/normalize";
import { doiFromExtra, pickPdfAttachment, toReference } from "./items";
import type { ZoteroAttachment, ZoteroItem } from "./items";

/** A journal article as `/items/top` actually returns one. */
const article: ZoteroItem = {
  key: "ABCD2345",
  version: 8412,
  data: {
    key: "ABCD2345",
    itemType: "journalArticle",
    title: "Cold-chain   effects on\nassay reproducibility",
    creators: [
      { creatorType: "author", firstName: "Ana", lastName: "Ruiz" },
      { creatorType: "author", firstName: "Ben", lastName: "Okafor" },
      { creatorType: "editor", firstName: "Cara", lastName: "Silva" },
    ],
    abstractNote: "  We find that a 4 °C step explains the gap.  ",
    publicationTitle: "Journal of Reproducible Assays",
    date: "2024-03-15",
    DOI: "10.1038/nature12373",
    url: "https://example.org/paper",
  },
};

describe("toReference", () => {
  it("produces the same shape a .bib import produces", () => {
    const entry = toReference(article);
    expect(entry).toEqual({
      zoteroItemKey: "ABCD2345",
      title: "Cold-chain effects on assay reproducibility",
      authors: ["Ana Ruiz", "Ben Okafor"],
      year: 2024,
      venue: "Journal of Reproducible Assays",
      doi: "10.1038/nature12373",
      abstract: "We find that a 4 °C step explains the gap.",
      url: "https://example.org/paper",
    });
  });

  it("collapses to the same identity a .bib import would produce", () => {
    // The reason `normalize.ts` is imported rather than restated: a paper
    // pasted from a citation export last month and synced from Zotero today
    // has to land on one row, and `referenceIdentity` is what decides that.
    const entry = toReference(article);
    expect(referenceIdentity(entry?.title ?? "", entry?.year)).toBe(
      referenceIdentity("Cold-chain effects on assay reproducibility", 2024),
    );
  });

  it("keeps only authors when there are any, and everyone when there are not", () => {
    // An edited volume has editors and no authors. Dropping the editors would
    // leave the row with nobody's name on it, which is worse than the wrong
    // kind of name.
    const edited = {
      ...article,
      data: {
        ...article.data,
        creators: [{ creatorType: "editor", firstName: "Cara", lastName: "Silva" }],
      },
    };
    expect(toReference(edited)?.authors).toEqual(["Cara Silva"]);
  });

  it("takes a one-field creator as the whole name", () => {
    // Zotero stores institutional authors as a single `name`.
    const institutional = {
      ...article,
      data: {
        ...article.data,
        creators: [{ creatorType: "author", name: "The GTEx Consortium" }],
      },
    };
    expect(toReference(institutional)?.authors).toEqual(["The GTEx Consortium"]);
  });

  it("sniffs a year out of Zotero's free-text date field", () => {
    // `date` is not a date. Zotero stores what the user typed.
    for (const date of ["2024-03-15", "March 2024", "2024", "15/03/2024"]) {
      expect(toReference({ ...article, data: { ...article.data, date } })?.year).toBe(2024);
    }
    expect(toReference({ ...article, data: { ...article.data, date: "in press" } })?.year).toBeUndefined();
  });

  it("finds the DOI a preprint hides in its extra field", () => {
    // `preprint` and `conferencePaper` have no `DOI` field of their own, so
    // Zotero's convention is a `DOI:` line in `extra` — and that DOI is what
    // makes the difference between an indexed dedupe and a title guess.
    const preprint: ZoteroItem = {
      key: "WXYZ8901",
      version: 8413,
      data: {
        key: "WXYZ8901",
        itemType: "preprint",
        title: "Attention is all you need",
        creators: [{ creatorType: "author", firstName: "Ada", lastName: "Vaswani" }],
        date: "2017",
        extra: "arXiv:1706.03762\nDOI: 10.48550/arXiv.1706.03762\nciting: 100000",
      },
    };
    expect(toReference(preprint)?.doi).toBe("10.48550/arXiv.1706.03762");
  });

  it("takes the proceedings title as the venue for a conference paper", () => {
    const paper = {
      ...article,
      data: {
        ...article.data,
        itemType: "conferencePaper",
        publicationTitle: undefined,
        proceedingsTitle: "NeurIPS 2017",
      },
    };
    expect(toReference(paper)?.venue).toBe("NeurIPS 2017");
  });

  it("refuses an item with no title, which is not a paper", () => {
    const untitled = { ...article, data: { ...article.data, title: "   " } };
    expect(toReference(untitled)).toBeNull();
  });

  it("refuses an item type a journal club does not read", () => {
    // The server-side `itemType` filter should mean this never arrives. It is
    // checked again here because "should" is not a guarantee about somebody
    // else's API, and a web page on the lab's shelf is a bug that looks like a
    // feature nobody asked for.
    const page = { ...article, data: { ...article.data, itemType: "webpage" } };
    expect(toReference(page)).toBeNull();
  });

  it("leaves out the fields Zotero left empty", () => {
    const bare: ZoteroItem = {
      key: "BARE0001",
      version: 1,
      data: { key: "BARE0001", itemType: "journalArticle", title: "A title" },
    };
    expect(toReference(bare)).toEqual({
      zoteroItemKey: "BARE0001",
      title: "A title",
      authors: [],
    });
  });

  it("answers null for a row that is not an item at all", () => {
    // The `ZoteroItem` annotation is a claim about a `JSON.parse` result, not
    // a check of it. A sync maps this over a whole page at once, so a single
    // `null` where an object was promised must cost that row — not the page,
    // and not every hourly retry of the page afterwards.
    for (const malformed of [null, undefined, "error", 42, [], {}, { key: "K" }, { key: "K", data: null }, { data: { itemType: "journalArticle", title: "T" } }]) {
      expect(toReference(malformed as unknown as ZoteroItem)).toBeNull();
    }
  });

  it("survives an item whose fields are the wrong types", () => {
    const wrong = {
      key: "WRNG0001",
      version: "eight",
      data: {
        key: "WRNG0001",
        itemType: "journalArticle",
        title: "A real title",
        creators: "Ana Ruiz",
        date: 2024,
        DOI: 10.1038,
        extra: ["DOI: 10.1000/xyz"],
        abstractNote: null,
      },
    };
    expect(toReference(wrong as unknown as ZoteroItem)).toEqual({
      zoteroItemKey: "WRNG0001",
      title: "A real title",
      authors: [],
    });
  });

  it("skips a creator that is not a creator", () => {
    const ragged = {
      ...article,
      data: {
        ...article.data,
        creators: [null, { creatorType: "author", lastName: "Ruiz", firstName: "Ana" }, "Ben"],
      },
    };
    expect(toReference(ragged as unknown as ZoteroItem)?.authors).toEqual(["Ana Ruiz"]);
  });
});

describe("doiFromExtra", () => {
  it("reads a DOI: line whatever its case and spacing", () => {
    expect(doiFromExtra("doi:10.1000/xyz")).toBe("10.1000/xyz");
    expect(doiFromExtra("Citation Key: x\nDOI:   10.1000/xyz")).toBe("10.1000/xyz");
  });

  it("says nothing when there is no DOI line", () => {
    expect(doiFromExtra("arXiv:1706.03762")).toBeUndefined();
    expect(doiFromExtra(undefined)).toBeUndefined();
    expect(doiFromExtra("")).toBeUndefined();
  });

  it("wants the DOI to be the whole line, and says nothing when it is not", () => {
    // Deliberate, and pinned so a later loosening is a decision rather than an
    // accident. A wrong DOI dedupes a paper onto a different paper, which is
    // worse and quieter than no DOI at all — an annotated line falls through
    // to the title-and-year identity instead.
    expect(doiFromExtra("DOI: 10.1000/xyz (accessed 2024)")).toBeUndefined();
    expect(doiFromExtra("See DOI: 10.1000/xyz")).toBeUndefined();
  });
});

describe("pickPdfAttachment", () => {
  const stored: ZoteroAttachment = {
    key: "PDF00001",
    data: {
      key: "PDF00001",
      itemType: "attachment",
      linkMode: "imported_url",
      contentType: "application/pdf",
      filename: "ruiz-2024.pdf",
      md5: "9f86d081884c7d659a2feaa0c55ad015",
    },
  };

  it("takes a PDF Zotero itself is storing", () => {
    expect(pickPdfAttachment([stored])?.key).toBe("PDF00001");
  });

  it("takes a PDF dragged in from a disk just the same", () => {
    // `imported_file` is the commoner of the two stored modes — it is what a
    // member gets dropping a PDF onto an item, where `imported_url` is what
    // the browser connector saves. Both have bytes on Zotero's servers, and
    // only the fixture above covered one of them.
    const dragged: ZoteroAttachment = {
      key: "PDF00003",
      data: { ...stored.data, key: "PDF00003", linkMode: "imported_file" },
    };
    expect(pickPdfAttachment([dragged])?.key).toBe("PDF00003");
  });

  it("passes over a link, which has no bytes behind it", () => {
    // `linked_file` points at a path on one person's laptop and `linked_url`
    // at a page. Neither is a file `api.zotero.org` can serve.
    const linked = { ...stored, data: { ...stored.data, linkMode: "linked_file" } };
    const url = { ...stored, data: { ...stored.data, linkMode: "linked_url" } };
    expect(pickPdfAttachment([linked, url])).toBeNull();
  });

  it("passes over an attachment that is not a PDF", () => {
    const snapshot = {
      ...stored,
      data: { ...stored.data, contentType: "text/html", filename: "page.html" },
    };
    expect(pickPdfAttachment([snapshot])).toBeNull();
  });

  it("passes over a WebDAV-stored file before spending a request on it", () => {
    // A file the member syncs through their own WebDAV is not on Zotero's
    // servers, and `/file` has nothing to answer with. The absent `md5` is the
    // signal, and reading it here means the paper lands `needs-pdf` honestly
    // instead of costing a download that was always going to fail.
    const webdav = { ...stored, data: { ...stored.data, md5: undefined } };
    expect(pickPdfAttachment([webdav])).toBeNull();
  });

  it("reads Zotero's literal null md5 as the same absence", () => {
    // The field is not merely missing on an unuploaded or WebDAV attachment —
    // Zotero sends `"md5": null`. The runtime always handled it; now the type
    // says so too, so a caller cannot write `md5 ? …` against a lie.
    const unuploaded: ZoteroAttachment = {
      ...stored,
      data: { ...stored.data, md5: null },
    };
    expect(pickPdfAttachment([unuploaded])).toBeNull();
  });

  it("takes the first storable PDF when an item has several attachments", () => {
    // The common shape: a snapshot, a supplement, and the paper.
    const snapshot = {
      ...stored,
      key: "SNAP0001",
      data: { ...stored.data, key: "SNAP0001", contentType: "text/html" },
    };
    const second = { ...stored, key: "PDF00002", data: { ...stored.data, key: "PDF00002" } };
    expect(pickPdfAttachment([snapshot, stored, second])?.key).toBe("PDF00001");
  });

  it("takes nothing from an item with no children at all", () => {
    expect(pickPdfAttachment([])).toBeNull();
  });

  it("steps over a malformed child rather than throwing on the page", () => {
    // Same argument as `toReference`: this runs per accepted item across a
    // whole sync, and a `TypeError` here would cost a page of papers over one
    // bad row — every hour, forever, since the cursor would never advance.
    const ragged = [null, undefined, "attachment", 7, {}, { key: "K", data: null }, stored];
    expect(pickPdfAttachment(ragged as unknown as ZoteroAttachment[])?.key).toBe(
      "PDF00001",
    );
    expect(
      pickPdfAttachment(ragged.slice(0, -1) as unknown as ZoteroAttachment[]),
    ).toBeNull();
  });
});
