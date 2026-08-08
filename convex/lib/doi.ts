/**
 * DOI handling.
 *
 * The same paper's DOI arrives as `10.1038/nature12373`, as
 * `https://doi.org/10.1038/Nature12373`, as `doi:10.1038/nature12373`, and
 * with a trailing newline from whatever PDF it was copied out of. DOIs are
 * case-insensitive by spec, so without one normal form a library collects the
 * same paper three times. Everything that reads or writes `papers.doi` goes
 * through here, and the stored value is always the normalized one — that is
 * what makes `by_lab_and_doi` a dedupe key rather than a hint.
 */

const DOI_PREFIXES = [
  "https://doi.org/",
  "http://doi.org/",
  "https://dx.doi.org/",
  "http://dx.doi.org/",
  "doi:",
];

/** Lowercase, unwrapped, trimmed. Returns `""` for input that holds no DOI. */
export function normalizeDoi(input: string): string {
  let doi = input.trim();

  // Email clients and reference managers wrap bare URLs in angle brackets:
  // `<https://doi.org/10.1038/nature12373>`. The brackets are the wrapper's,
  // never the DOI's.
  while (doi.startsWith("<") && doi.endsWith(">")) {
    doi = doi.slice(1, -1).trim();
  }

  // A DOI that travelled through a URL comes back with its slash percent-
  // encoded. Decoding before anything else is what stops `10.1000%2fabc` and
  // `10.1000/abc` from landing as two papers. Only the slash: a real DOI
  // suffix may legitimately contain a literal `%`.
  doi = doi.replace(/%2f/gi, "/").toLowerCase();

  for (const prefix of DOI_PREFIXES) {
    if (doi.startsWith(prefix)) {
      doi = doi.slice(prefix.length);
      break;
    }
  }

  // Publishers love a trailing period, and copy-paste loves a trailing slash.
  return doi.replace(/[./\s]+$/, "").trim();
}

/**
 * Shape check only — a registrar prefix (`10.` + 4-9 digits), a slash, and a
 * suffix. It rejects typos before we spend a network round trip on them; it
 * does not claim the DOI is registered. Only Crossref can say that.
 */
export function isPlausibleDoi(doi: string): boolean {
  return /^10\.\d{4,9}\/\S+$/.test(doi);
}
