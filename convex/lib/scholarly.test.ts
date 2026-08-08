import { describe, expect, it } from "vitest";
import { arxivPdfUrl, openAlexPdfCandidates } from "./scholarly";

/**
 * The two pure decisions in the "find the free copy" path.
 *
 * Everything else in `scholarly.ts` needs Crossref or OpenAlex on the other
 * end of a socket; these two do not, and they are where the outcome is
 * actually decided. A wrong answer here is invisible in the product — the
 * paper simply lands as `needs-pdf`, exactly as it would if no copy existed —
 * so the ordering, the dedupe, the scheme filter and the cap are asserted
 * rather than eyeballed.
 */

/** A record shaped like OpenAlex's, with only the fields under test filled in. */
function work(fields: Record<string, unknown>): Record<string, unknown> {
  return { display_name: "A paper", ...fields };
}

describe("openAlexPdfCandidates", () => {
  it("orders the four sources by confidence", () => {
    expect(
      openAlexPdfCandidates(
        work({
          best_oa_location: { pdf_url: "https://example.org/best.pdf" },
          primary_location: { pdf_url: "https://example.org/primary.pdf" },
          open_access: { oa_url: "https://example.org/oa.pdf" },
          locations: [
            { pdf_url: "https://repo.example.org/one.pdf" },
            { pdf_url: "https://repo.example.org/two.pdf" },
          ],
        }),
      ),
    ).toEqual([
      "https://example.org/best.pdf",
      "https://example.org/primary.pdf",
      "https://example.org/oa.pdf",
      "https://repo.example.org/one.pdf",
      "https://repo.example.org/two.pdf",
    ]);
  });

  it("finds the copy that is not in best_oa_location — the whole point", () => {
    expect(
      openAlexPdfCandidates(
        work({
          best_oa_location: { pdf_url: null, landing_page_url: "https://example.org/abs" },
          primary_location: { pdf_url: "https://example.org/paper.pdf" },
        }),
      ),
    ).toEqual(["https://example.org/paper.pdf"]);
  });

  it("drops duplicates, keeping the earliest position", () => {
    expect(
      openAlexPdfCandidates(
        work({
          best_oa_location: { pdf_url: "https://example.org/same.pdf" },
          primary_location: { pdf_url: "https://example.org/same.pdf" },
          open_access: { oa_url: "https://example.org/other.pdf" },
          locations: [
            { pdf_url: "https://example.org/same.pdf" },
            { pdf_url: "https://example.org/other.pdf" },
          ],
        }),
      ),
    ).toEqual(["https://example.org/same.pdf", "https://example.org/other.pdf"]);
  });

  it("refuses anything that is not http(s)", () => {
    expect(
      openAlexPdfCandidates(
        work({
          best_oa_location: { pdf_url: "javascript:alert(1)" },
          primary_location: { pdf_url: "file:///etc/passwd" },
          open_access: { oa_url: "data:application/pdf;base64,AAAA" },
          locations: [
            { pdf_url: "ftp://example.org/paper.pdf" },
            { pdf_url: "http://example.org/paper.pdf" },
          ],
        }),
      ),
    ).toEqual(["http://example.org/paper.pdf"]);
  });

  it("stops at six candidates", () => {
    const candidates = openAlexPdfCandidates(
      work({
        best_oa_location: { pdf_url: "https://example.org/best.pdf" },
        locations: Array.from({ length: 20 }, (_, index) => ({
          pdf_url: `https://repo.example.org/${index}.pdf`,
        })),
      }),
    );
    expect(candidates).toHaveLength(6);
    expect(candidates[0]).toBe("https://example.org/best.pdf");
    expect(candidates[5]).toBe("https://repo.example.org/4.pdf");
  });

  it("survives a record that carries none of the shapes it should", () => {
    expect(openAlexPdfCandidates(work({}))).toEqual([]);
    expect(
      openAlexPdfCandidates(
        work({
          best_oa_location: "not an object",
          open_access: { oa_url: 42 },
          locations: [null, "https://example.org/loose.pdf", { pdf_url: "   " }],
        }),
      ),
    ).toEqual([]);
    expect(openAlexPdfCandidates(null)).toEqual([]);
    expect(openAlexPdfCandidates([])).toEqual([]);
  });
});

describe("arxivPdfUrl", () => {
  it("maps a modern arXiv DOI to the file, version and all", () => {
    expect(arxivPdfUrl("10.48550/arxiv.2103.00020")).toBe(
      "https://arxiv.org/pdf/2103.00020",
    );
    // Four digits after the dot until 2015, five after it.
    expect(arxivPdfUrl("10.48550/arxiv.1412.6980")).toBe(
      "https://arxiv.org/pdf/1412.6980",
    );
    expect(arxivPdfUrl("10.48550/arxiv.2103.00020v2")).toBe(
      "https://arxiv.org/pdf/2103.00020v2",
    );
  });

  it("maps a pre-2007 identifier, subject class and all", () => {
    expect(arxivPdfUrl("10.48550/arxiv.hep-th/9901001")).toBe(
      "https://arxiv.org/pdf/hep-th/9901001",
    );
    expect(arxivPdfUrl("10.48550/arxiv.math.ag/0309136")).toBe(
      "https://arxiv.org/pdf/math.ag/0309136",
    );
  });

  it("leaves every other DOI alone", () => {
    expect(arxivPdfUrl("10.1038/nature12373")).toBeUndefined();
    expect(arxivPdfUrl("10.48550/foo.2103.00020")).toBeUndefined();
    expect(arxivPdfUrl("")).toBeUndefined();
  });

  it("refuses a suffix that would climb out of the URL", () => {
    expect(arxivPdfUrl("10.48550/arxiv.../../etc/passwd")).toBeUndefined();
    expect(arxivPdfUrl("10.48550/arxiv.2103.00020?x=1")).toBeUndefined();
    expect(arxivPdfUrl("10.48550/arxiv.2103.00020 2103.00021")).toBeUndefined();
  });
});
