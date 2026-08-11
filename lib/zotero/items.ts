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
    /** Present when Zotero is storing the file. Absent means WebDAV. */
    md5?: string;
  };
};

/** A Zotero item, in the shape every other import path in Margin speaks. */
export type ZoteroReference = ReferenceEntry & { zoteroItemKey: string };

const SCHOLARLY = new Set<string>(SCHOLARLY_ITEM_TYPES);

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
  const all = creators ?? [];
  const authors = all.filter((creator) => creator.creatorType === "author");
  // An edited volume has editors and no authors. Dropping them would leave the
  // row with nobody's name on it, which is worse than the wrong kind of name.
  const chosen = authors.length > 0 ? authors : all;
  return chosen
    .map((creator) =>
      creator.name !== undefined
        ? // Institutional authors are one field, and `normalizeAuthor`'s
          // "Last, First" flip would mangle "Silva, Hospital of".
          cleanReferenceText(creator.name)
        : normalizeAuthor(
            [creator.lastName, creator.firstName]
              .filter((part) => part !== undefined && part.length > 0)
              .join(", "),
          ),
    )
    .filter((name) => name.length > 0);
}

function firstText(...candidates: (string | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const cleaned = cleanReferenceText(candidate);
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
 */
export function toReference(item: ZoteroItem): ZoteroReference | null {
  const data = item.data;
  if (!SCHOLARLY.has(data.itemType)) return null;

  const title = firstText(data.title);
  if (title === undefined) return null;

  return {
    zoteroItemKey: item.key,
    title,
    authors: creatorNames(data.creators),
    year: readYear(data.date),
    venue: firstText(
      data.publicationTitle,
      data.proceedingsTitle,
      data.bookTitle,
    ),
    doi: firstText(data.DOI) ?? doiFromExtra(data.extra),
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
 */
export function pickPdfAttachment(
  children: readonly ZoteroAttachment[],
): ZoteroAttachment | null {
  return (
    children.find(
      (child) =>
        child.data.itemType === "attachment" &&
        (child.data.linkMode === "imported_file" ||
          child.data.linkMode === "imported_url") &&
        child.data.contentType === "application/pdf" &&
        typeof child.data.md5 === "string" &&
        child.data.md5.length > 0,
    ) ?? null
  );
}
