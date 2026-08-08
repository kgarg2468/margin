# Paper import: finding the free copy, and saying why attaching failed

Date: 2026-08-08. Prompted by direct user feedback:

> "i'm having trouble attaching a pdf"
> "and also trouble w the doi bc the paper i used has a free copy online but
> openalex is not able to locate it"

## Problems

1. **One field decides the whole open-access outcome.** `createFromDoi` tries
   exactly one URL: OpenAlex's `best_oa_location.pdf_url`. When that field is
   empty the paper lands as `needs-pdf`, even when the same OpenAlex record
   lists other locations with PDFs (`locations[]`, `open_access.oa_url`,
   `primary_location.pdf_url`) — and even when the member is looking at the
   free copy in another tab. Their only recourse is download-then-re-upload.

2. **Attach failures are one generic sentence.** The attach flow runs pdf.js
   before uploading, so a password-protected or damaged file blocks the attach
   with "Margin couldn't read that PDF", which names neither the problem nor
   the remedy.

## Design

### A. Find the free copy (`feat/import-free-copy`)

**Wider candidate list, same fetcher.** `fetchOpenAlex` returns ordered,
deduplicated PDF candidates instead of a single `pdfUrl`: `best_oa_location`,
`primary_location`, `open_access.oa_url`, then each `locations[].pdf_url` —
capped at 6. DOIs of the form `10.48550/arxiv.<id>` add
`https://arxiv.org/pdf/<id>` as a candidate. `createFromDoi` tries candidates
in order with the existing `fetchOpenAccessPdf` (which already validates
https, size, and `%PDF-` magic bytes); first success wins, all-fail still
lands as `needs-pdf` exactly as today.

**Paste a link.** The member often knows where the free copy lives. The
needs-PDF panel on the paper page gains a small "found a free copy online?"
form: paste a URL, a new `fetchPdfFromUrl` action fetches it server-side
(no CORS), validates it with the same `fetchOpenAccessPdf` rules plus a
guard against IP-literal/localhost hosts, stores it, and attaches it to the
paper (`pending`); the browser then reads the text layer via the existing
`useTextLayer` hook, exactly as the DOI path does. The action refuses papers
that already have a file — replacement stays with the existing dropzone.
A fetch that comes back non-PDF fails with copy that teaches the fix: link
to the file itself, or download it and drop it in.

### B. Attach errors that say what happened (`fix/pdf-attach-errors`)

`lib/pdf/extract.ts` classifies pdf.js open failures by exception name:
`PasswordException` → "this PDF is password-protected" with the remedy;
`InvalidPDFException` → "damaged or not actually a PDF". Both attach flows
(`add-paper.tsx` upload tab, `pdf-panel.tsx` attach) use the classification,
falling back to today's message when the error is something else.

## Testing

Pure functions carry the risk, so they carry the tests: OpenAlex candidate
extraction (ordering, dedupe, scheme filtering, caps), the arXiv shortcut,
and the pdf.js error classifier — all vitest, no network. CI (lint,
typecheck, tests, build, browser smoke) and Greptile gate both PRs.

## Non-goals

Unpaywall as an extra source (OpenAlex's OA data already derives from it),
importing HTML/scraping landing pages for PDF links, attaching files whose
extraction failed, and any change to the reader or anchoring.
