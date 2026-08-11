/**
 * A Zotero item, read as the thing Margin already knows how to put on a shelf.
 *
 * The output is `ReferenceEntry` — the exact shape `lib/reference-import/`
 * produces from a `.bib` or a `.ris` (`lib/reference-import/types.ts:4`) —
 * plus the Zotero item key, which is the identity that lets a later edit
 * upstream find the row it should patch.
 *
 * `cleanReferenceText`, `normalizeAuthor` and `readYear` are imported rather
 * than restated, and that is the whole design. A paper pasted from a citation
 * export last month and synced from Zotero today has to collapse onto one row,
 * and `referenceIdentity(title, year)` is what decides it — so the title has
 * to be cleaned by the same function and the year sniffed by the same one, or
 * the two paths produce two rows that a member can see are the same paper.
 */

import {
  cleanReferenceText,
  normalizeAuthor,
  readYear,
} from "../reference-import/normalize";
import type { ReferenceEntry } from "../reference-import/types";
import { SCHOLARLY_ITEM_TYPES } from "./api";

export type ZoteroCreator = {
  creatorType?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
};

export type ZoteroItem = {
  key: string;
  version: number;
  data: {
    key: string;
    itemType: string;
    title?: string;
    creators?: ZoteroCreator[];
    abstractNote?: string;
    /** `journalArticle`'s venue. */
    publicationTitle?: string;
    /** `conferencePaper`'s venue. */
    proceedingsTitle?: string;
    /** `bookSection`'s venue. */
    bookTitle?: string;
    /** Free text. Zotero stores what the member typed, not a date. */
    date?: string;
    /** Capitalised, and only on the item types that have the field. */
    DOI?: string;
    url?: string;
    /** Where a DOI hides on a preprint, among whatever else is in there. */
    extra?: string;
  };
};

export type ZoteroAttachment = {
  key: string;
  data: {
    key: string;
    itemType: string;
    linkMode?: string;
    contentType?: string;
    filename?: string;
    /**
     * Present when Zotero is storing the file. Absent — or an explicit `null`,
     * which is what Zotero actually sends for a WebDAV or never-uploaded
     * attachment — means the bytes are not on Zotero's servers.
     */
    md5?: string | null;
  };
};

/** A Zotero item, in the shape every other import path in Margin speaks. */
export type ZoteroReference = ReferenceEntry & { zoteroItemKey: string };

const SCHOLARLY = new Set<string>(SCHOLARLY_ITEM_TYPES);

/**
 * The types above describe what Zotero documents, not what arrives.
 *
 * Every value these two functions read comes off a `JSON.parse` of somebody
 * else's response, and the `ZoteroItem` annotation on the parameter is a claim
 * about it rather than a check of it. A sync maps over a whole page of those
 * rows at once, so a single `null` where an object was promised is not one
 * missing paper — it throws, the page dies, and the hourly sweep retries the
 * same poisoned row forever. The guards below are what make "skip the bad row"
 * true instead of aspirational.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A field Zotero declared a string, when it actually is one. */
function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * The DOI a preprint keeps in `extra`.
 *
 * `preprint` and `conferencePaper` have no `DOI` field in Zotero's schema, and
 * the convention every reference manager has settled on is a `DOI:` line in
 * the free-text `extra` field alongside whatever else the member put there.
 * Worth reading, because a DOI is the difference between an indexed dedupe
 * against `by_lab_and_doi` and a guess made from a title.
 */
export function doiFromExtra(extra: string | undefined): string | undefined {
  const match = extra?.match(/^\s*DOI:\s*(\S+)\s*$/im);
  return match?.[1];
}

/** Authors if there are any, everybody named otherwise. */
function creatorNames(creators: ZoteroCreator[] | undefined): string[] {
  const all = Array.isArray(creators) ? creators.filter(isRecord) : [];
  const authors = all.filter((creator) => creator.creatorType === "author");
  // An edited volume has editors and no authors. Dropping them would leave the
  // row with nobody's name on it, which is worse than the wrong kind of name.
  const chosen = authors.length > 0 ? authors : all;
  return chosen
    .map((creator) => {
      const whole = text(creator.name);
      if (whole !== undefined) {
        // Institutional authors are one field, and `normalizeAuthor`'s
        // "Last, First" flip would mangle "Silva, Hospital of".
        return cleanReferenceText(whole);
      }
      return normalizeAuthor(
        [text(creator.lastName), text(creator.firstName)]
          .filter((part) => part !== undefined && part.length > 0)
          .join(", "),
      );
    })
    .filter((name) => name.length > 0);
}

/** The first of these that is a non-empty string once cleaned. */
function firstText(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    const value = text(candidate);
    if (value === undefined) continue;
    const cleaned = cleanReferenceText(value);
    if (cleaned.length > 0) return cleaned;
  }
  return undefined;
}

/**
 * One Zotero item as a reference, or `null` if it is not one.
 *
 * The item-type check duplicates the `itemType` filter `itemsUrl` puts on the
 * request, deliberately. "The server filtered it" is a claim about somebody
 * else's API, and a web page arriving on a lab's shelf is a bug that looks
 * like a feature nobody asked for. A title check for the same reason: an item
 * with no title is not a paper, it is a stub somebody made and abandoned, and
 * `cleanTitle` in `convex/papers.ts:145` would throw on it at the door.
 *
 * A row that is not an object, or has no `data` object on it, is `null` too
 * rather than a thrown `TypeError`. The caller is mapping this over a page of
 * parsed JSON, and one malformed row should cost that row — not the page, and
 * not every hourly retry of the page after it.
 */
export function toReference(item: ZoteroItem): ZoteroReference | null {
  if (!isRecord(item) || !isRecord(item.data)) return null;
  const data = item.data;
  if (!SCHOLARLY.has(data.itemType)) return null;

  const title = firstText(data.title);
  if (title === undefined) return null;

  const key = text(item.key);
  if (key === undefined) return null;

  return {
    zoteroItemKey: key,
    title,
    authors: creatorNames(data.creators),
    year: readYear(text(data.date)),
    venue: firstText(
      data.publicationTitle,
      data.proceedingsTitle,
      data.bookTitle,
    ),
    doi: firstText(data.DOI) ?? doiFromExtra(text(data.extra)),
    abstract: firstText(data.abstractNote),
    url: firstText(data.url),
  };
}

/**
 * The one attachment worth downloading, or `null`.
 *
 * Three refusals, all of them made from the item's own metadata so that a
 * request is never spent finding out:
 *
 *   - **Link modes.** Only `imported_file` and `imported_url` have bytes
 *     behind them. `linked_file` points at a path on one person's laptop and
 *     `linked_url` at a page.
 *   - **Content type.** Zotero records it, so the PDF/not-PDF decision costs
 *     nothing here and a download otherwise.
 *   - **WebDAV.** A member who syncs their files through their own WebDAV has
 *     files Zotero's servers have never seen; `/file` fails or answers an
 *     `ETag` that matches nothing. The signal is a missing `md5` — present
 *     exactly when Zotero is holding the file — and reading it means the paper
 *     lands `needs-pdf` honestly instead of after a request that was always
 *     going to fail. Building a WebDAV client is explicitly out of scope.
 *
 * First match wins. An item with a snapshot, a supplement and the paper is the
 * common shape, and Zotero orders children with the primary attachment first
 * often enough that "first storable PDF" is the right guess — and when it is
 * wrong the cost is one supplementary PDF on the shelf instead of the paper,
 * which a member can replace with the dropzone that already exists.
 *
 * Whatever this returns is fetched from `fileUrl`, which answers a `302` to a
 * presigned Amazon URL. That hop is never followed with the key still on the
 * request — the rule lives in `convex/zotero.ts` with the credential, because
 * nothing here holds one.
 *
 * A child that is not an object, or carries no `data`, is skipped like any
 * other unusable attachment — for the same reason `toReference` answers `null`
 * to one. This runs per accepted item across a whole sync; a `TypeError` here
 * would take down a page of papers over one malformed row.
 */
export function pickPdfAttachment(
  children: readonly ZoteroAttachment[],
): ZoteroAttachment | null {
  if (!Array.isArray(children)) return null;
  return (
    children.find((child) => {
      if (!isRecord(child) || !isRecord(child.data)) return false;
      const data = child.data;
      return (
        data.itemType === "attachment" &&
        (data.linkMode === "imported_file" ||
          data.linkMode === "imported_url") &&
        data.contentType === "application/pdf" &&
        typeof data.md5 === "string" &&
        data.md5.length > 0
      );
    }) ?? null
  );
}
