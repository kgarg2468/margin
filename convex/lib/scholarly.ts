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
  /** A direct link to an open-access PDF, when one is known to exist. */
  pdfUrl?: string;
};

const USER_AGENT = "Margin/0.1 (https://github.com/kgarg2468/margin)";

const MAX_ABSTRACT_LENGTH = 4000;
const MAX_AUTHORS = 60;

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
 * OpenAlex's view of the same DOI. Used two ways: as the metadata fallback
 * when Crossref has no record, and — always — as the source of the
 * open-access PDF link, which Crossref does not carry.
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
    pdfUrl: readHttpUrl(bestOa?.pdf_url),
  };
}
