import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { getMembership, requireMembership, requireUserId } from "./lib/authz";
import { isPlausibleDoi, normalizeDoi } from "./lib/doi";
import { recordEvent } from "./lib/ledger";
import type { PaperMetadata } from "./lib/scholarly";
import { fetchCrossref, fetchOpenAlex } from "./lib/scholarly";
import { ingestStatus } from "./schema";

/**
 * Paper ingest and the library.
 *
 * Two doors in, one room. A member either uploads a PDF — in which case the
 * browser has already extracted its text layer with pdf.js and sends it along
 * — or pastes a DOI, in which case an action asks Crossref for the record and
 * OpenAlex for a legal open-access copy. Either way the result is one `papers`
 * row, a `paper.added` fact in the ledger, and (once there is text) a
 * `paperPages` row per page for anchors to resolve against.
 *
 * Every external fetch lives in `createFromDoi`, because actions are the only
 * place Convex allows one and because a mutation that could be waiting on
 * Crossref is a mutation that could be holding a transaction open.
 */

const MAX_TITLE_LENGTH = 500;
/** Longer than any paper; short enough that one mutation stays a sane transaction. */
const MAX_PAGES = 2000;
/** A page of a paper is a few thousand characters. This is a guard, not a target. */
const MAX_PAGE_CHARS = 60_000;
const MAX_PDF_BYTES = 60 * 1024 * 1024;

const paperSummary = v.object({
  _id: v.id("papers"),
  title: v.string(),
  authors: v.optional(v.array(v.string())),
  year: v.optional(v.number()),
  venue: v.optional(v.string()),
  doi: v.optional(v.string()),
  ingestStatus,
  hasPdf: v.boolean(),
  pageCount: v.optional(v.number()),
  addedAt: v.number(),
});

const paperDetail = v.object({
  _id: v.id("papers"),
  labId: v.id("labs"),
  title: v.string(),
  authors: v.optional(v.array(v.string())),
  year: v.optional(v.number()),
  venue: v.optional(v.string()),
  abstract: v.optional(v.string()),
  doi: v.optional(v.string()),
  sourceUrl: v.optional(v.string()),
  ingestStatus,
  ingestError: v.optional(v.string()),
  hasPdf: v.boolean(),
  hasText: v.boolean(),
  pageCount: v.optional(v.number()),
  addedAt: v.number(),
  addedByName: v.optional(v.string()),
});

function toSummary(paper: Doc<"papers">) {
  return {
    _id: paper._id,
    title: paper.title,
    authors: paper.authors,
    year: paper.year,
    venue: paper.venue,
    doi: paper.doi,
    ingestStatus: paper.ingestStatus,
    hasPdf: paper.storageId !== undefined,
    pageCount: paper.pageCount,
    addedAt: paper._creationTime,
  };
}

/**
 * A paper the caller is allowed to touch, plus the membership that allowed it
 * — the caller almost always needs the `userId` to attribute a ledger event,
 * and resolving it twice is a second index read for nothing.
 */
async function requirePaperAccess(
  ctx: QueryCtx | MutationCtx,
  paperId: Id<"papers">,
): Promise<{ paper: Doc<"papers">; membership: Doc<"memberships"> }> {
  const paper = await ctx.db.get(paperId);
  if (paper === null) {
    throw new ConvexError("That paper is no longer in the library.");
  }
  const membership = await requireMembership(ctx, paper.labId);
  return { paper, membership };
}

function cleanTitle(input: string): string {
  const title = input.trim().replace(/\s+/g, " ");
  if (title.length === 0) {
    throw new ConvexError("A paper needs a title.");
  }
  return title.slice(0, MAX_TITLE_LENGTH);
}

function cleanAuthors(input: string[] | undefined): string[] | undefined {
  if (input === undefined) {
    return undefined;
  }
  const authors = input
    .map((author) => author.trim().replace(/\s+/g, " "))
    .filter((author) => author.length > 0)
    .slice(0, 60);
  return authors.length > 0 ? authors : undefined;
}

/**
 * Replace a paper's extracted text.
 *
 * Written as delete-then-insert rather than a diff because re-extraction only
 * happens when the underlying file changed, and a half-replaced text layer
 * would silently mis-anchor every annotation on the paper.
 */
async function replacePageText(
  ctx: MutationCtx,
  paperId: Id<"papers">,
  pages: string[],
): Promise<void> {
  if (pages.length > MAX_PAGES) {
    throw new ConvexError(
      `That PDF has ${pages.length} pages, which is more than Margin can take in one go (${MAX_PAGES}).`,
    );
  }

  const existing = await ctx.db
    .query("paperPages")
    .withIndex("by_paper", (q) => q.eq("paperId", paperId))
    .collect();
  for (const page of existing) {
    await ctx.db.delete(page._id);
  }

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    await ctx.db.insert("paperPages", {
      paperId,
      pageIndex,
      text: (pages[pageIndex] ?? "").slice(0, MAX_PAGE_CHARS),
    });
  }
}

/**
 * A short-lived URL the browser POSTs the PDF straight to.
 *
 * The file never passes through a Convex function — that is the point. A
 * 30 MB paper would blow past every argument-size limit there is.
 */
export const generateUploadUrl = mutation({
  args: { labId: v.id("labs") },
  returns: v.string(),
  handler: async (ctx, args) => {
    await requireMembership(ctx, args.labId);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Turn an uploaded file into a paper.
 *
 * `pages` is the text layer pdf.js pulled out in the browser (see
 * `lib/pdf/extract.ts`). Extraction is client-side because the PDF is already
 * there, decoded, in a tab that has nothing better to do — and because
 * rendering a PDF server-side would mean shipping a Node runtime.
 */
export const createFromUpload = mutation({
  args: {
    labId: v.id("labs"),
    storageId: v.id("_storage"),
    title: v.string(),
    authors: v.optional(v.array(v.string())),
    pages: v.array(v.string()),
  },
  returns: v.id("papers"),
  handler: async (ctx, args) => {
    const membership = await requireMembership(ctx, args.labId);
    const title = cleanTitle(args.title);

    const paperId = await ctx.db.insert("papers", {
      labId: args.labId,
      title,
      authors: cleanAuthors(args.authors),
      storageId: args.storageId,
      pageCount: args.pages.length,
      ingestStatus: "ready",
      addedBy: membership.userId,
    });

    await replacePageText(ctx, paperId, args.pages);

    await recordEvent(ctx, {
      labId: args.labId,
      type: "paper.added",
      actorId: membership.userId,
      paperId,
      title,
    });
    await recordEvent(ctx, {
      labId: args.labId,
      type: "paper.ingested",
      actorId: membership.userId,
      paperId,
      pageCount: args.pages.length,
    });

    return paperId;
  },
});

/**
 * Give a metadata-only paper its PDF — the second half of a DOI ingest that
 * found no open-access copy. Also the way to replace a preprint with the
 * published file, in which case the old blob and the old text layer go with
 * it rather than lingering as storage nobody can reach.
 */
export const attachPdf = mutation({
  args: {
    paperId: v.id("papers"),
    storageId: v.id("_storage"),
    pages: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { paper, membership } = await requirePaperAccess(ctx, args.paperId);
    const previous = paper.storageId;

    await ctx.db.patch(paper._id, {
      storageId: args.storageId,
      pageCount: args.pages.length,
      ingestStatus: "ready",
      ingestError: undefined,
    });
    await replacePageText(ctx, paper._id, args.pages);

    if (previous !== undefined && previous !== args.storageId) {
      await ctx.storage.delete(previous);
    }

    await recordEvent(ctx, {
      labId: paper.labId,
      type: "paper.ingested",
      actorId: membership.userId,
      paperId: paper._id,
      pageCount: args.pages.length,
    });
    return null;
  },
});

/**
 * Record the text layer for a PDF that Margin fetched itself.
 *
 * The open-access path stores a file the browser never saw, so there is
 * nothing to extract from until a member opens the paper. This is the callback
 * for that: same text, same table, no new file.
 */
export const saveExtractedText = mutation({
  args: { paperId: v.id("papers"), pages: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { paper, membership } = await requirePaperAccess(ctx, args.paperId);
    if (paper.storageId === undefined) {
      throw new ConvexError("That paper has no PDF to extract text from.");
    }

    await ctx.db.patch(paper._id, {
      pageCount: args.pages.length,
      ingestStatus: "ready",
      ingestError: undefined,
    });
    await replacePageText(ctx, paper._id, args.pages);

    await recordEvent(ctx, {
      labId: paper.labId,
      type: "paper.ingested",
      actorId: membership.userId,
      paperId: paper._id,
      pageCount: args.pages.length,
    });
    return null;
  },
});

/** The lab's library, newest first. */
export const listPapers = query({
  args: { labId: v.id("labs") },
  returns: v.array(paperSummary),
  handler: async (ctx, args) => {
    await requireMembership(ctx, args.labId);

    const papers = await ctx.db
      .query("papers")
      .withIndex("by_lab", (q) => q.eq("labId", args.labId))
      .order("desc")
      .collect();

    return papers.map(toSummary);
  },
});

/**
 * One paper. `null` rather than a throw when the caller can't see it, so a
 * stale link renders an honest empty state instead of an error — and so the
 * response is the same whether the paper is missing or forbidden.
 */
export const getPaper = query({
  args: { paperId: v.id("papers") },
  returns: v.union(v.null(), paperDetail),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const paper = await ctx.db.get(args.paperId);
    if (paper === null) {
      return null;
    }
    if ((await getMembership(ctx, paper.labId, userId)) === null) {
      return null;
    }

    const firstPage = await ctx.db
      .query("paperPages")
      .withIndex("by_paper", (q) => q.eq("paperId", paper._id))
      .first();
    const addedBy = await ctx.db.get(paper.addedBy);

    return {
      _id: paper._id,
      labId: paper.labId,
      title: paper.title,
      authors: paper.authors,
      year: paper.year,
      venue: paper.venue,
      abstract: paper.abstract,
      doi: paper.doi,
      sourceUrl: paper.sourceUrl,
      ingestStatus: paper.ingestStatus,
      ingestError: paper.ingestError,
      hasPdf: paper.storageId !== undefined,
      hasText: firstPage !== null,
      pageCount: paper.pageCount,
      addedAt: paper._creationTime,
      addedByName: addedBy?.name ?? addedBy?.email,
    };
  },
});

/** A time-limited URL for the stored PDF, for members of the paper's lab only. */
export const getPdfUrl = query({
  args: { paperId: v.id("papers") },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, args) => {
    const { paper } = await requirePaperAccess(ctx, args.paperId);
    if (paper.storageId === undefined) {
      return null;
    }
    return await ctx.storage.getUrl(paper.storageId);
  },
});

/* -------------------------------------------------------------------------
 * DOI ingest
 * ---------------------------------------------------------------------- */

/**
 * Written out rather than inferred: `createFromDoi` calls two functions
 * defined below it in this same module, and TypeScript cannot infer a type
 * that refers to itself through `internal.papers`.
 */
type DoiIngestResult = {
  paperId: Id<"papers">;
  title: string;
  alreadyInLibrary: boolean;
  hasPdf: boolean;
};

const doiIngestResult = v.object({
  paperId: v.id("papers"),
  title: v.string(),
  /** True when the DOI was already in this lab's library and we returned it untouched. */
  alreadyInLibrary: v.boolean(),
  hasPdf: v.boolean(),
});

/**
 * The membership gate for `createFromDoi` — an action has no database, so the
 * check it needs has to be a query — and, in the same round trip, the dedupe
 * lookup. Returning early from here is what makes pasting the same DOI twice
 * a no-op instead of a duplicate.
 */
export const findByDoi = internalQuery({
  args: { labId: v.id("labs"), doi: v.string() },
  returns: v.union(v.null(), doiIngestResult),
  handler: async (ctx, args) => {
    await requireMembership(ctx, args.labId);

    const existing = await ctx.db
      .query("papers")
      .withIndex("by_lab_and_doi", (q) =>
        q.eq("labId", args.labId).eq("doi", args.doi),
      )
      .first();
    if (existing === null) {
      return null;
    }
    return {
      paperId: existing._id,
      title: existing.title,
      alreadyInLibrary: true,
      hasPdf: existing.storageId !== undefined,
    };
  },
});

/** Write the paper the action assembled. Re-checks the dedupe key: two members can paste the same DOI at once. */
export const insertFromDoi = internalMutation({
  args: {
    labId: v.id("labs"),
    doi: v.string(),
    title: v.string(),
    authors: v.optional(v.array(v.string())),
    year: v.optional(v.number()),
    venue: v.optional(v.string()),
    abstract: v.optional(v.string()),
    sourceUrl: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
  },
  returns: doiIngestResult,
  handler: async (ctx, args) => {
    const membership = await requireMembership(ctx, args.labId);

    const existing = await ctx.db
      .query("papers")
      .withIndex("by_lab_and_doi", (q) =>
        q.eq("labId", args.labId).eq("doi", args.doi),
      )
      .first();
    if (existing !== null) {
      // Someone won the race. Their paper is the paper; drop the file we
      // fetched rather than leaving it in storage with nothing pointing at it.
      if (args.storageId !== undefined) {
        await ctx.storage.delete(args.storageId);
      }
      return {
        paperId: existing._id,
        title: existing.title,
        alreadyInLibrary: true,
        hasPdf: existing.storageId !== undefined,
      };
    }

    const title = cleanTitle(args.title);
    const paperId = await ctx.db.insert("papers", {
      labId: args.labId,
      title,
      authors: cleanAuthors(args.authors),
      year: args.year,
      venue: args.venue,
      abstract: args.abstract,
      doi: args.doi,
      sourceUrl: args.sourceUrl,
      storageId: args.storageId,
      // A fetched PDF still has no text layer: nothing has run pdf.js over it
      // yet. `pending` is that gap, and the reader closes it on first open.
      ingestStatus: args.storageId === undefined ? "needs-pdf" : "pending",
      addedBy: membership.userId,
    });

    await recordEvent(ctx, {
      labId: args.labId,
      type: "paper.added",
      actorId: membership.userId,
      paperId,
      title,
    });

    return {
      paperId,
      title,
      alreadyInLibrary: false,
      hasPdf: args.storageId !== undefined,
    };
  },
});

/**
 * Best effort, and only ever that. An OA link can 403, redirect to an
 * interstitial, or hand back an HTML "verifying your browser" page; none of
 * those should cost the member their metadata. A failure here just means the
 * paper lands as `needs-pdf` and someone drags the file in later.
 */
async function fetchOpenAccessPdf(url: string): Promise<Blob | null> {
  try {
    const response = await fetch(url, { headers: { Accept: "application/pdf" } });
    if (!response.ok) {
      return null;
    }
    const blob = await response.blob();
    if (blob.size === 0 || blob.size > MAX_PDF_BYTES) {
      return null;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("pdf")) {
      // Plenty of repositories serve `application/octet-stream`. Trust the
      // magic bytes over the header, and nothing else.
      const header = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
      const signature = String.fromCharCode(...header);
      if (signature !== "%PDF-") {
        return null;
      }
    }
    return blob;
  } catch {
    return null;
  }
}

/**
 * Add a paper from its DOI.
 *
 * Crossref first — it is the registry that minted the identifier — with
 * OpenAlex as the fallback for the DOIs it does not carry. OpenAlex is asked
 * either way, because it is the only one of the two that knows where a legal
 * open-access copy lives. If there is one we fetch it and store it; if there
 * is not, the paper is still worth having, so it lands as `needs-pdf` and the
 * library says so.
 */
export const createFromDoi = action({
  args: { labId: v.id("labs"), doi: v.string() },
  returns: doiIngestResult,
  handler: async (ctx, args): Promise<DoiIngestResult> => {
    const doi = normalizeDoi(args.doi);
    if (doi.length === 0) {
      throw new ConvexError("Paste a DOI to look up.");
    }
    if (!isPlausibleDoi(doi)) {
      throw new ConvexError(
        "That doesn't look like a DOI. They start with “10.” — for example 10.1038/nature12373.",
      );
    }

    // Also the authorization check: `findByDoi` requires membership.
    const existing: DoiIngestResult | null = await ctx.runQuery(
      internal.papers.findByDoi,
      { labId: args.labId, doi },
    );
    if (existing !== null) {
      return existing;
    }

    const crossref = await fetchCrossref(doi);
    const openAlex = await fetchOpenAlex(doi);
    const metadata: PaperMetadata | null = crossref ?? openAlex;
    if (metadata === null) {
      throw new ConvexError(
        "DOI not found. Check it against the publisher's page, or upload the PDF instead.",
      );
    }

    // Crossref is authoritative for the record; OpenAlex fills the gaps it
    // leaves (abstracts, mostly) and is the sole source of the OA link.
    const merged: PaperMetadata = {
      title: metadata.title,
      authors: metadata.authors ?? openAlex?.authors,
      year: metadata.year ?? openAlex?.year,
      venue: metadata.venue ?? openAlex?.venue,
      abstract: metadata.abstract ?? openAlex?.abstract,
      sourceUrl: metadata.sourceUrl ?? openAlex?.sourceUrl,
      pdfUrl: openAlex?.pdfUrl,
    };

    let storageId: Id<"_storage"> | undefined;
    if (merged.pdfUrl !== undefined) {
      const pdf = await fetchOpenAccessPdf(merged.pdfUrl);
      if (pdf !== null) {
        storageId = await ctx.storage.store(pdf);
      }
    }

    return await ctx.runMutation(internal.papers.insertFromDoi, {
      labId: args.labId,
      doi,
      title: merged.title,
      authors: merged.authors,
      year: merged.year,
      venue: merged.venue,
      abstract: merged.abstract,
      sourceUrl: merged.sourceUrl,
      storageId,
    });
  },
});
