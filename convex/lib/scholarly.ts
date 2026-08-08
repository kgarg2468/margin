import { ConvexError } from "convex/values";

/**
 * The two metadata sources behind "paste a DOI".
 *
 * Crossref is authoritative for the bibliographic record: it is the registry
 * that minted the DOI. OpenAlex is the fallback when Crossref has no record
 * (DataCite DOIs, some preprint servers) and is also the only one of the two
 * that will tell you where a legal open-access copy of the PDF lives.
 *
 * Both readers are deliberately paranoid: every field is optional in practice
 * whatever the docs say, so nothing here trusts a shape it did not check.
 * A missing field means we show less, never that ingest fails.
 */

export type PaperMetadata = {
  title: string;
  authors?: string[];
  year?: number;
  venue?: string;
  abstract?: string;
  /** Where a human should go to read it — the publisher's landing page. */
  sourceUrl?: string;
  /**
   * Every place OpenAlex thinks an open-access PDF lives, best first.
   *
   * A list rather than a link because the first one is wrong often enough to
   * matter: the "best" OA location is chosen for licence and version, not for
   * whether the host will actually serve the bytes to a robot. The caller
   * walks it until something returns a PDF.
   */
  pdfUrls?: string[];
};

const USER_AGENT = "Margin/0.1 (https://github.com/kgarg2468/margin)";

const MAX_ABSTRACT_LENGTH = 4000;
const MAX_AUTHORS = 60;

/**
 * A well-indexed paper can list a dozen repositories holding the same file.
 * Past the first handful they are mirrors of mirrors, and every one is a
 * network round trip the member is waiting through, so the list stops here.
 */
const MAX_PDF_CANDIDATES = 6;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Crossref returns most single-valued fields as arrays. Take the first usable one. */
function readFirstString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = readString(entry);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  return readString(value);
}

/**
 * A URL we are willing to hand to a browser or to `fetch`.
 *
 * These strings come from a third party and end up in an `href` and in an
 * outbound request, so the scheme is checked rather than assumed: `javascript:`
 * and `data:` are the obvious hazards, `file:` the quiet one.
 */
function readHttpUrl(value: unknown): string | undefined {
  const raw = readString(value);
  if (raw === undefined) {
    return undefined;
  }
  try {
    const { protocol } = new URL(raw);
    return protocol === "https:" || protocol === "http:" ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a hostname names a site or a machine.
 *
 * The same paranoia as `readHttpUrl`, one step further out. A scheme check
 * says the string is a URL we can fetch; this says the thing on the other end
 * is somewhere on the public web rather than something wearing our own
 * network's address. Convex actions run inside infrastructure with a private
 * network around them, and `fetch` will resolve `localhost`, `127.0.0.1`, or
 * `169.254.169.254` into a request that originates from in there — which is
 * how a text box becomes a way to read an internal service through us.
 *
 * A free copy of a paper lives at a hostname, so this costs a member nothing.
 * It is also only half the problem: a public name that resolves to a private
 * address still passes, and closing that means resolving DNS ourselves and
 * checking the address before connecting.
 */
export function isFetchableHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  // `URL.hostname` keeps the brackets on an IPv6 literal, which is the only
  // thing that can start with one.
  if (host.startsWith("[")) {
    return false;
  }
  // Dotted-quad, and the decimal and hex spellings of the same address.
  if (/^(?:\d|0x)[0-9a-fx.]*$/i.test(host)) {
    return false;
  }
  // `localhost`, and every other name with no public suffix on it.
  return host.includes(".");
}

/**
 * Where a `Location` header actually points, or `null` if we won't go there.
 *
 * A redirect is the second place a URL gets chosen, and the check we ran on
 * the first one does not travel with it: a perfectly public host can answer
 * 302 with an internal address, and a fetch that follows redirects by itself
 * will have made that request before anything gets a look at it. So the hop
 * is resolved here — `Location` is allowed to be relative — and put through
 * the same two rules the typed URL passed.
 *
 * Pure, so the resolution and the refusals are testable without a server on
 * the other end willing to redirect.
 */
export function nextRedirectHop(
  currentUrl: string,
  location: string | null,
): string | null {
  const raw = location?.trim();
  if (raw === undefined || raw.length === 0) {
    return null;
  }

  let next: URL;
  try {
    next = new URL(raw, currentUrl);
  } catch {
    return null;
  }

  if (next.protocol !== "https:" || !isFetchableHost(next.hostname)) {
    return null;
  }
  return next.toString();
}

function readYear(value: unknown): number | undefined {
  const year = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(year) || year < 1600 || year > 2200) {
    return undefined;
  }
  return year;
}

function clampAbstract(abstract: string | undefined): string | undefined {
  if (abstract === undefined) {
    return undefined;
  }
  const collapsed = abstract.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) {
    return undefined;
  }
  return collapsed.length > MAX_ABSTRACT_LENGTH
    ? `${collapsed.slice(0, MAX_ABSTRACT_LENGTH)}…`
    : collapsed;
}

/**
 * Crossref abstracts are JATS XML fragments (`<jats:p>…</jats:p>`). We want a
 * paragraph of prose, not markup, and we are not rendering it as HTML, so the
 * tags come out and the handful of entities they carry get decoded.
 */
function stripJats(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Long enough for a cold Crossref record, short enough that a member is not
 * left watching a spinner because a metadata service is hanging rather than
 * refusing.
 */
const FETCH_TIMEOUT_MS = 10_000;

async function fetchJson(
  url: string,
  serviceName: string,
): Promise<unknown | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new ConvexError(
      `Could not reach ${serviceName}. Please try again in a moment.`,
    );
  }

  // 404 is a real answer — "no such DOI here" — and lets the caller fall
  // through to the other service. Anything else is the service misbehaving.
  if (response.status === 404 || response.status === 410) {
    return null;
  }
  if (!response.ok) {
    throw new ConvexError(
      `${serviceName} is not answering right now (${response.status}). Please try again in a moment.`,
    );
  }

  try {
    return (await response.json()) as unknown;
  } catch {
    throw new ConvexError(`${serviceName} returned something we couldn't read.`);
  }
}

function crossrefAuthors(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const authors: string[] = [];
  for (const entry of value.slice(0, MAX_AUTHORS)) {
    if (!isRecord(entry)) {
      continue;
    }
    const given = readString(entry.given);
    const family = readString(entry.family);
    const name =
      given !== undefined && family !== undefined
        ? `${given} ${family}`
        : (family ?? given ?? readString(entry.name));
    if (name !== undefined) {
      authors.push(name);
    }
  }
  return authors.length > 0 ? authors : undefined;
}

function crossrefYear(message: Record<string, unknown>): number | undefined {
  for (const key of ["issued", "published", "published-print", "published-online"]) {
    const field = message[key];
    if (!isRecord(field)) {
      continue;
    }
    const parts = field["date-parts"];
    if (Array.isArray(parts) && Array.isArray(parts[0])) {
      const year = readYear(parts[0][0]);
      if (year !== undefined) {
        return year;
      }
    }
  }
  return undefined;
}

/** The bibliographic record from the registry that minted the DOI. `null` = no such DOI. */
export async function fetchCrossref(doi: string): Promise<PaperMetadata | null> {
  const body = await fetchJson(
    `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
    "Crossref",
  );
  if (body === null || !isRecord(body) || !isRecord(body.message)) {
    return null;
  }
  const message = body.message;

  const title = readFirstString(message.title);
  if (title === undefined) {
    // A record with no title is not something we can put in a library.
    return null;
  }

  const rawAbstract = readString(message.abstract);

  return {
    title,
    authors: crossrefAuthors(message.author),
    year: crossrefYear(message),
    venue:
      readFirstString(message["container-title"]) ??
      readFirstString(message["institution"]),
    abstract: clampAbstract(
      rawAbstract === undefined ? undefined : stripJats(rawAbstract),
    ),
    sourceUrl: readHttpUrl(message.URL),
  };
}

/**
 * OpenAlex stores abstracts as `{ word: [positions] }` because Elsevier's
 * licence forbids redistributing the running text. Inverting it back is
 * explicitly sanctioned and is the only way to get an abstract for the many
 * records where Crossref has none.
 */
function openAlexAbstract(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const words: string[] = [];
  for (const [word, positions] of Object.entries(value)) {
    if (!Array.isArray(positions)) {
      continue;
    }
    for (const position of positions) {
      if (typeof position === "number" && position >= 0 && position < 20000) {
        words[position] = word;
      }
    }
  }
  const text = words.filter((word) => word !== undefined).join(" ");
  return text.length > 0 ? text : undefined;
}

function openAlexAuthors(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const authors: string[] = [];
  for (const entry of value.slice(0, MAX_AUTHORS)) {
    if (!isRecord(entry)) {
      continue;
    }
    const author = isRecord(entry.author) ? entry.author : undefined;
    const name =
      readString(author?.display_name) ?? readString(entry.raw_author_name);
    if (name !== undefined) {
      authors.push(name);
    }
  }
  return authors.length > 0 ? authors : undefined;
}

function openAlexVenue(work: Record<string, unknown>): string | undefined {
  const primary = isRecord(work.primary_location)
    ? work.primary_location
    : undefined;
  const source = isRecord(primary?.source) ? primary.source : undefined;
  return (
    readString(source?.display_name) ??
    (isRecord(work.host_venue)
      ? readString(work.host_venue.display_name)
      : undefined)
  );
}

/**
 * Every PDF an OpenAlex work record points at, best first, no duplicates.
 *
 * Margin used to read exactly one field — `best_oa_location.pdf_url` — and
 * call the paper unavailable when it was empty. It is empty a lot: OpenAlex
 * picks the "best" location by licence and version, and the record routinely
 * carries a perfectly good PDF one field over, in `primary_location`, in
 * `open_access.oa_url`, or in the `locations[]` list those two are drawn from.
 * One empty field was deciding an outcome that four fields had an opinion on.
 *
 * The order is confidence, not preference: the curated pick first, the
 * publisher's own copy next, then the OA landing link, then the long tail of
 * repository mirrors. Each URL goes through `readHttpUrl` because these come
 * from a third party and end up in `fetch`, and duplicates are dropped because
 * the same file is usually listed two or three ways and the caller pays a
 * request per entry.
 *
 * Pure and exported so the ordering can be tested without a network.
 */
export function openAlexPdfCandidates(work: unknown): string[] {
  if (!isRecord(work)) {
    return [];
  }

  const bestOa = isRecord(work.best_oa_location) ? work.best_oa_location : undefined;
  const primary = isRecord(work.primary_location) ? work.primary_location : undefined;
  const openAccess = isRecord(work.open_access) ? work.open_access : undefined;

  const ordered: unknown[] = [
    bestOa?.pdf_url,
    primary?.pdf_url,
    openAccess?.oa_url,
  ];
  if (Array.isArray(work.locations)) {
    for (const location of work.locations) {
      if (isRecord(location)) {
        ordered.push(location.pdf_url);
      }
    }
  }

  const candidates: string[] = [];
  for (const value of ordered) {
    const url = readHttpUrl(value);
    if (url === undefined || candidates.includes(url)) {
      continue;
    }
    candidates.push(url);
    if (candidates.length === MAX_PDF_CANDIDATES) {
      break;
    }
  }
  return candidates;
}

/**
 * arXiv mints DOIs of the form `10.48550/arxiv.2103.00020`, and the PDF for
 * one is always at `https://arxiv.org/pdf/<id>`. That is worth knowing on its
 * own: arXiv's OpenAlex records are frequently listed as open access with no
 * `pdf_url` anywhere in them, so the one preprint server everybody can read is
 * also the one Margin was most likely to declare unavailable.
 *
 * The identifier grammar is spelled out rather than matched loosely because
 * the captured text is pasted into a URL we then fetch — `../..` in a DOI
 * suffix should get an `undefined`, not a request. Both arXiv schemes: the
 * modern `2103.00020v2` and the pre-2007 `hep-th/9901001`.
 */
const ARXIV_DOI =
  /^10\.48550\/arxiv\.((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?)$/;

/** Takes a DOI already through `normalizeDoi` — lowercase, unwrapped, trimmed. */
export function arxivPdfUrl(normalizedDoi: string): string | undefined {
  const id = ARXIV_DOI.exec(normalizedDoi)?.[1];
  return id === undefined ? undefined : `https://arxiv.org/pdf/${id}`;
}

/**
 * OpenAlex's view of the same DOI. Used two ways: as the metadata fallback
 * when Crossref has no record, and — always — as the source of the
 * open-access PDF links, which Crossref does not carry.
 */
export async function fetchOpenAlex(doi: string): Promise<PaperMetadata | null> {
  const body = await fetchJson(
    `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}`,
    "OpenAlex",
  );
  if (body === null || !isRecord(body)) {
    return null;
  }

  const title = readString(body.display_name) ?? readString(body.title);
  if (title === undefined) {
    return null;
  }

  const bestOa = isRecord(body.best_oa_location) ? body.best_oa_location : undefined;
  const primary = isRecord(body.primary_location) ? body.primary_location : undefined;

  return {
    title,
    authors: openAlexAuthors(body.authorships),
    year: readYear(body.publication_year),
    venue: openAlexVenue(body),
    abstract: clampAbstract(openAlexAbstract(body.abstract_inverted_index)),
    sourceUrl:
      readHttpUrl(bestOa?.landing_page_url) ??
      readHttpUrl(primary?.landing_page_url) ??
      readHttpUrl(body.doi),
    pdfUrls: openAlexPdfCandidates(body),
  };
}
