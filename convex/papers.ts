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
import {
  arxivPdfUrl,
  fetchCrossref,
  fetchOpenAlex,
  isFetchableHost,
  nextRedirectHop,
} from "./lib/scholarly";
import { ingestStatus } from "./schema";
import { referenceIdentity } from "../lib/reference-import/normalize";

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
/**
 * The per-page cap alone bounds nothing useful: 2000 pages of 60k characters
 * is 120 MB of inserts in one transaction. This is the cap that matters — far
 * more than the ~1M characters of a long book, far less than a transaction
 * Convex will refuse halfway through.
 */
const MAX_TOTAL_CHARS = 4_000_000;
const MAX_PDF_BYTES = 60 * 1024 * 1024;
const MAX_PDF_MB = MAX_PDF_BYTES / (1024 * 1024);

/**
 * How many open-access candidates one DOI lookup is allowed to try.
 *
 * Each attempt is a fetch with its own 20-second ceiling, and a member is
 * watching the whole sum. Four is enough for the case this exists for — the
 * curated pick is dead, the publisher's copy works — while keeping the worst
 * case a wait rather than an action the platform kills mid-flight.
 */
const MAX_PDF_FETCH_ATTEMPTS = 4;

/**
 * Not an error: a scanned PDF is a perfectly good file that simply has no
 * text in it. The paper stays `pending` and carries this so the reader can
 * say why the margins are closed.
 */
const NO_TEXT_LAYER_MESSAGE =
  "No text layer found — this may be a scanned PDF";

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
 * Whether a paper has any text worth anchoring to.
 *
 * Streamed rather than collected: for every paper that has a text layer the
 * first page answers it, and `.collect()` would pull the entire text of the
 * paper into memory to learn one bit. Only an all-empty scan reads to the end.
 */
async function hasExtractedText(
  ctx: QueryCtx | MutationCtx,
  paperId: Id<"papers">,
): Promise<boolean> {
  for await (const page of ctx.db
    .query("paperPages")
    .withIndex("by_paper", (q) => q.eq("paperId", paperId))) {
    if (page.text.trim().length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * Where a paper lands once extraction has run.
 *
 * `ready` means annotations can anchor, which takes actual text — a PDF whose
 * every page comes back empty is a scan, and calling it ready would promise a
 * reader something the file cannot do.
 */
function ingestStateFor(pages: string[]): {
  ingestStatus: "ready" | "pending";
  ingestError: string | undefined;
} {
  return pages.some((page) => page.trim().length > 0)
    ? { ingestStatus: "ready", ingestError: undefined }
    : { ingestStatus: "pending", ingestError: NO_TEXT_LAYER_MESSAGE };
}

/**
 * A storage id from the client is a claim, exactly like a `labId` is.
 *
 * The browser uploads straight to Convex and then tells us the id it got
 * back; nothing so far has checked that the blob exists, that it is a PDF, or
 * that it is a size we agreed to hold. Without this a member could point a
 * paper at any file in the deployment.
 */
async function requireStoredPdf(
  ctx: MutationCtx,
  storageId: Id<"_storage">,
): Promise<void> {
  const file = await ctx.db.system.get(storageId);
  if (file === null) {
    throw new ConvexError(
      "That upload isn't there any more. Try dropping the file in again.",
    );
  }
  if (file.contentType !== "application/pdf") {
    throw new ConvexError("Margin stores PDFs, and that file isn't one.");
  }
  if (file.size > MAX_PDF_BYTES) {
    throw new ConvexError(
      `That PDF is larger than the ${MAX_PDF_MB} MB Margin will hold for one paper.`,
    );
  }
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

  const clamped = pages.map((page) => page.slice(0, MAX_PAGE_CHARS));
  const totalChars = clamped.reduce((total, page) => total + page.length, 0);
  if (totalChars > MAX_TOTAL_CHARS) {
    throw new ConvexError(
      `That PDF holds ${Math.round(totalChars / 1_000_000)} million characters of text, more than Margin can store for one paper (${MAX_TOTAL_CHARS / 1_000_000} million). Split it and add the parts separately.`,
    );
  }

  const existing = await ctx.db
    .query("paperPages")
    .withIndex("by_paper", (q) => q.eq("paperId", paperId))
    .collect();
  for (const page of existing) {
    await ctx.db.delete(page._id);
  }

  for (let pageIndex = 0; pageIndex < clamped.length; pageIndex++) {
    await ctx.db.insert("paperPages", {
      paperId,
      pageIndex,
      text: clamped[pageIndex] ?? "",
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
    await requireStoredPdf(ctx, args.storageId);

    const paperId = await ctx.db.insert("papers", {
      labId: args.labId,
      title,
      authors: cleanAuthors(args.authors),
      storageId: args.storageId,
      pageCount: args.pages.length,
      ...ingestStateFor(args.pages),
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
 * Put a citation export's metadata-only record on the shelf.
 *
 * DOI-bearing entries do not come through here: `createFromDoi` owns those,
 * including normalization, dedupe, and the search for a legal copy. This is
 * the deliberately narrower door for BibTeX and RIS records with no DOI at
 * all. They still become the same paper, with the same membership gate and
 * ledger fact, but wait in `needs-pdf` until a lab member supplies the file.
 */
export const createFromMetadata = mutation({
  args: {
    labId: v.id("labs"),
    title: v.string(),
    authors: v.optional(v.array(v.string())),
    year: v.optional(v.number()),
    venue: v.optional(v.string()),
    abstract: v.optional(v.string()),
    sourceUrl: v.optional(v.string()),
  },
  returns: v.object({
    paperId: v.id("papers"),
    title: v.string(),
    /** True when the title and year were already in this lab's library. */
    alreadyInLibrary: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const membership = await requireMembership(ctx, args.labId);
    const title = cleanTitle(args.title);
    const identity = referenceIdentity(title, args.year);
    const existing = (
      await ctx.db
        .query("papers")
        .withIndex("by_lab", (q) => q.eq("labId", args.labId))
        .collect()
    ).find(
      (paper) => referenceIdentity(paper.title, paper.year) === identity,
    );
    if (existing !== undefined) {
      return {
        paperId: existing._id,
        title: existing.title,
        alreadyInLibrary: true,
      };
    }
    const paperId = await ctx.db.insert("papers", {
      labId: args.labId,
      title,
      authors: cleanAuthors(args.authors),
      year: args.year,
      venue: args.venue,
      abstract: args.abstract,
      sourceUrl: args.sourceUrl,
      ingestStatus: "needs-pdf",
      addedBy: membership.userId,
    });

    await recordEvent(ctx, {
      labId: args.labId,
      type: "paper.added",
      actorId: membership.userId,
      paperId,
      title,
    });

    return { paperId, title, alreadyInLibrary: false };
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
    await requireStoredPdf(ctx, args.storageId);
    const previous = paper.storageId;
    const isReplacement = previous !== undefined && previous !== args.storageId;

    await ctx.db.patch(paper._id, {
      storageId: args.storageId,
      pageCount: args.pages.length,
      ...ingestStateFor(args.pages),
    });
    await replacePageText(ctx, paper._id, args.pages);

    if (isReplacement) {
      await ctx.storage.delete(previous);
    }

    await recordEvent(ctx, {
      labId: paper.labId,
      // A swap is not an arrival. Every annotation on this paper was anchored
      // against the text layer that just went away, so the ledger records the
      // two as different facts.
      type: isReplacement ? "paper.pdf_replaced" : "paper.ingested",
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
 *
 * It is deliberately a no-op once the paper has pages. Two members can open
 * the same freshly-fetched paper in the same minute, and both browsers will
 * extract the same text from the same file; the second one re-running
 * delete-then-insert would churn every row that the first one's annotations
 * are anchored against, for a text layer identical to the one already there.
 * A genuine file swap goes through `attachPdf`, which is the only path that
 * replaces existing pages.
 */
export const saveExtractedText = mutation({
  args: { paperId: v.id("papers"), pages: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { paper, membership } = await requirePaperAccess(ctx, args.paperId);
    if (paper.storageId === undefined) {
      throw new ConvexError("That paper has no PDF to extract text from.");
    }

    const alreadyExtracted = await ctx.db
      .query("paperPages")
      .withIndex("by_paper", (q) => q.eq("paperId", paper._id))
      .first();
    if (alreadyExtracted !== null) {
      return null;
    }

    await ctx.db.patch(paper._id, {
      pageCount: args.pages.length,
      ...ingestStateFor(args.pages),
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

/**
 * The other ending for extraction: it didn't work.
 *
 * pdf.js runs in the browser, so a file that is encrypted, truncated, or
 * simply unreadable fails out there — and without this the paper would sit at
 * `pending` forever, indistinguishable from one nobody has opened yet.
 *
 * Two things it refuses to do. It will not fail a paper that has no stored
 * file (that is `needs-pdf`, which is more useful than "failed"), and it will
 * not fail a paper that already reads: a botched attempt to swap in a new PDF
 * leaves the working one, and its text, exactly where they were.
 */
export const markIngestFailed = mutation({
  args: { paperId: v.id("papers"), message: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { paper } = await requirePaperAccess(ctx, args.paperId);
    if (paper.storageId === undefined) {
      return null;
    }
    if (await hasExtractedText(ctx, paper._id)) {
      return null;
    }

    await ctx.db.patch(paper._id, {
      ingestStatus: "failed",
      ingestError: args.message.trim().slice(0, 300),
    });
    return null;
  },
});

/**
 * Delete a blob the browser uploaded and then failed to attach.
 *
 * The upload URL and the mutation that records the paper are two round trips,
 * and everything between them can fail — a closed tab, a rejected title, a
 * PDF over the size limit. Without this the file stays in storage with
 * nothing pointing at it and no way to ever find it again.
 *
 * The `by_pdf_storage` lookup is the safety catch: if any paper already
 * claims this blob, the caller is confused and the file stays.
 */
export const discardUpload = mutation({
  args: { labId: v.id("labs"), storageId: v.id("_storage") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireMembership(ctx, args.labId);

    const claimed = await ctx.db
      .query("papers")
      .withIndex("by_pdf_storage", (q) => q.eq("storageId", args.storageId))
      .first();
    if (claimed !== null) {
      return null;
    }

    await ctx.storage.delete(args.storageId);
    return null;
  },
});

/** The lab's library, newest first. */
export const listPapers = query({
  args: { labId: v.id("labs") },
  returns: v.array(paperSummary),
  handler: async (ctx, args) => {
    await requireMembership(ctx, args.labId);

    // Bounded rather than paginated: a library this long wants a real paged
    // view with a cursor, and the list UI has to grow a "load more" before
    // that is worth building. Until then this is a ceiling, not a page — the
    // 201st paper is the signal to do it properly.
    const papers = await ctx.db
      .query("papers")
      .withIndex("by_lab", (q) => q.eq("labId", args.labId))
      .order("desc")
      .take(200);

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

    // Pages existing is not the same as text existing: a scan extracts to a
    // row per page, every one of them empty, and nothing can anchor to that.
    const hasText = await hasExtractedText(ctx, paper._id);
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
      hasText,
      pageCount: paper.pageCount,
      addedAt: paper._creationTime,
      addedByName: addedBy?.name ?? addedBy?.email,
    };
  },
});

/**
 * A URL for the stored PDF, mintable by members of the paper's lab only.
 *
 * Read that precisely: the membership check gates the *minting*, not the URL.
 * `storage.getUrl` returns a permanent, unauthenticated link — anyone it is
 * forwarded to can fetch the file, for as long as the file exists, whether or
 * not they are in the lab. For a library that will hold paywalled PDFs that
 * gap has to close, and closing it means serving the bytes through a
 * membership-checked HTTP action instead of handing out a storage URL.
 * Tracked in https://github.com/kgarg2468/margin/issues/9.
 */
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
 * A repository that accepts the connection and then stops talking would
 * otherwise hold an action open for as long as the platform allows. Per
 * request, not per link: a redirect chain that stalls on its fourth leg has
 * still stalled.
 */
const PDF_FETCH_TIMEOUT_MS = 20_000;

/**
 * Best effort, and only ever that. An OA link can 403, redirect to an
 * interstitial, or hand back an HTML "verifying your browser" page; none of
 * those should cost the member their metadata. A failure here just means the
 * paper lands as `needs-pdf` and someone drags the file in later.
 */
async function fetchOpenAccessPdf(url: string): Promise<Blob | null> {
  try {
    // The URL came from OpenAlex, which is to say from outside. TLS only: this
    // request carries no credentials, but the bytes it returns become a file
    // the whole lab reads, and a plaintext hop is a place to swap them.
    if (new URL(url).protocol !== "https:") {
      return null;
    }

    // Redirects are followed by `fetch` itself here, and that is right for
    // this path: a DOI candidate is a publisher or repository URL that hops
    // through a resolver and a CDN as a matter of course, and every one of
    // them came from OpenAlex rather than from a member. The pasted-link path
    // below is the one where the destination is worth re-checking.
    const response = await fetch(url, {
      headers: { Accept: "application/pdf" },
      signal: AbortSignal.timeout(PDF_FETCH_TIMEOUT_MS),
    });
    return await pdfFromResponse(response);
  } catch {
    return null;
  }
}

/**
 * The bytes at the end of any of these fetches, or `null` if they aren't a
 * PDF we agreed to hold.
 *
 * Shared by both fetch paths deliberately. The pasted-link path differs from
 * the DOI walk in where the URL came from and in how far it is trusted to
 * redirect — it does not differ in what counts as a PDF, and two copies of
 * this would be two places for the size cap to drift.
 */
async function pdfFromResponse(response: Response): Promise<Blob | null> {
  if (!response.ok) {
    return null;
  }

  // Refuse the download before starting it when the host is honest about
  // the size. It can lie or say nothing, so the check after the read stays
  // as the one that actually holds.
  const declaredBytes = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_PDF_BYTES) {
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

    // Both at once, and neither one's failure is allowed to take the other
    // down with it. Crossref being down is not a reason to refuse a DataCite
    // DOI that OpenAlex knows perfectly well, and vice versa — the fallback
    // only means anything if it survives the thing it is falling back from.
    const [crossrefResult, openAlexResult] = await Promise.allSettled([
      fetchCrossref(doi),
      fetchOpenAlex(doi),
    ]);
    const crossref =
      crossrefResult.status === "fulfilled" ? crossrefResult.value : null;
    const openAlex =
      openAlexResult.status === "fulfilled" ? openAlexResult.value : null;

    const metadata: PaperMetadata | null = crossref ?? openAlex;
    if (metadata === null) {
      if (
        crossrefResult.status === "rejected" &&
        openAlexResult.status === "rejected"
      ) {
        // Neither service answered at all, so "not found" would be a claim we
        // cannot make. Their own message says what actually happened.
        throw crossrefResult.reason instanceof ConvexError
          ? crossrefResult.reason
          : new ConvexError(
              "Neither Crossref nor OpenAlex is answering right now. Please try again in a moment.",
            );
      }
      throw new ConvexError(
        "DOI not found. Check it against the publisher's page, or upload the PDF instead.",
      );
    }

    // Crossref is authoritative for the record; OpenAlex fills the gaps it
    // leaves (abstracts, mostly) and is the sole source of the OA links.
    const merged: PaperMetadata = {
      title: metadata.title,
      authors: metadata.authors ?? openAlex?.authors,
      year: metadata.year ?? openAlex?.year,
      venue: metadata.venue ?? openAlex?.venue,
      abstract: metadata.abstract ?? openAlex?.abstract,
      sourceUrl: metadata.sourceUrl ?? openAlex?.sourceUrl,
      pdfUrls: openAlex?.pdfUrls,
    };

    // The DOI itself is a source of last resort: an arXiv DOI says where the
    // file is whether or not OpenAlex managed to index it, and arXiv records
    // are among the likeliest to arrive with no `pdf_url` at all.
    //
    // Last, but guaranteed a slot. It goes last because OpenAlex's candidates
    // are matched to this exact record and its curated pick is likelier to be
    // the published version than arXiv's preprint. It gets a slot because
    // "last" and "inside the attempt window" are not the same thing: append it
    // to a list already at the cap and it is appended to nothing — and a
    // record padded out with four dead repository mirrors is precisely the
    // record this shortcut exists for. The one URL we positively know serves
    // the file should not be the one the truncation eats.
    const candidates = merged.pdfUrls ?? [];
    const arxiv = arxivPdfUrl(doi);
    const attempts =
      arxiv === undefined
        ? candidates.slice(0, MAX_PDF_FETCH_ATTEMPTS)
        : [
            ...candidates
              .filter((candidate) => candidate !== arxiv)
              .slice(0, MAX_PDF_FETCH_ATTEMPTS - 1),
            arxiv,
          ];

    // First one that hands back actual PDF bytes wins; the rest are mirrors of
    // the same file. All of them failing is not an error — the paper is still
    // worth having, and it lands as `needs-pdf` exactly as it always did.
    let storageId: Id<"_storage"> | undefined;
    for (const candidate of attempts) {
      const pdf = await fetchOpenAccessPdf(candidate);
      if (pdf !== null) {
        storageId = await ctx.storage.store(pdf);
        break;
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

/* -------------------------------------------------------------------------
 * Fetching a free copy the member found
 * ---------------------------------------------------------------------- */

/**
 * The membership gate for `fetchPdfFromUrl` — an action has no database, so
 * the check it needs has to be a query, the same shape as `findByDoi` — and,
 * in the same round trip, the one fact that decides whether to fetch at all.
 */
export const paperFileState = internalQuery({
  args: { paperId: v.id("papers") },
  returns: v.object({ hasPdf: v.boolean() }),
  handler: async (ctx, args) => {
    const { paper } = await requirePaperAccess(ctx, args.paperId);
    return { hasPdf: paper.storageId !== undefined };
  },
});

/**
 * Attach a PDF the action fetched from a link a member pasted.
 *
 * Deliberately not `attachPdf`: there are no pages to record yet (nothing has
 * run pdf.js over a file the browser has never seen) and there is no file to
 * replace. It patches, and the reader fills in the text layer on first open.
 *
 * The re-check is the same race `insertFromDoi` guards: fetching the file took
 * seconds, and in those seconds a colleague could have dropped the real PDF
 * in. Their file is the file — losing an upload someone made by hand to a
 * link someone else pasted would be the wrong way round — so this one goes
 * back to storage rather than orphaning there.
 *
 * It reports that race as a value instead of throwing it, and the reason is
 * the reason `insertFromDoi` has always been written this way. A mutation is
 * a transaction: a handler that throws rolls back every write it made, and
 * `ctx.storage.delete` is one of those writes — while the `ctx.storage.store`
 * the action ran before calling us committed outside the transaction and
 * survives regardless. Deleting and then throwing therefore leaked the blob
 * on every single race, which is precisely what the delete was there to
 * prevent. So the delete commits, the outcome comes back as a value, and the
 * throwing moves up into the action, which has nothing left to roll back.
 */
export const attachFetchedPdf = internalMutation({
  args: { paperId: v.id("papers"), storageId: v.id("_storage") },
  returns: v.union(v.literal("attached"), v.literal("already-has-pdf")),
  handler: async (ctx, args) => {
    const { paper } = await requirePaperAccess(ctx, args.paperId);
    if (paper.storageId !== undefined) {
      await ctx.storage.delete(args.storageId);
      return "already-has-pdf";
    }

    await ctx.db.patch(paper._id, {
      storageId: args.storageId,
      // Same state a DOI-fetched copy lands in: the file is here, its text
      // layer is not, and the first browser to open it makes one.
      ingestStatus: "pending",
      ingestError: undefined,
    });
    // No ledger event. `paper.added` was recorded when the paper arrived, and
    // `saveExtractedText` records `paper.ingested` once a browser has actually
    // read the file — exactly as on the DOI path. A row between the two would
    // be announcing a paper that still can't be annotated.
    return "attached";
  },
});

/**
 * A URL a member typed, on its way into `fetch`.
 *
 * Every other URL this file fetches came from Crossref or OpenAlex. This one
 * came from a text box, which makes it the one that can be aimed at us — see
 * `isFetchableHost` for what that means and how far the guard goes. The rules
 * live there so the redirect loop can apply the same ones; what lives here is
 * the part that only makes sense for a URL a person typed, which is telling
 * them which rule they tripped over.
 */
function readPastedPdfUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new ConvexError(
      "That isn't a link Margin can follow. Paste the whole address, starting with https://.",
    );
  }

  if (parsed.protocol !== "https:") {
    throw new ConvexError(
      "Margin fetches over https only — on a plaintext hop the file could be swapped for another on the way in.",
    );
  }

  if (!isFetchableHost(parsed.hostname)) {
    throw new ConvexError(
      "That link points at a machine rather than a public site. Paste the address you would send to a colleague.",
    );
  }

  return parsed.toString();
}

/**
 * Long enough for the resolver-then-CDN-then-file chains real repositories
 * actually use, short enough that a redirect loop is a refusal rather than a
 * timeout.
 */
const MAX_REDIRECT_HOPS = 5;

/**
 * Fetch the pasted link, checking every address the chain lands on.
 *
 * `readPastedPdfUrl` vetted one URL — the one the member typed. A redirect is
 * the second place a URL is chosen, and that first check does not travel with
 * it: a public host is free to answer 302 with `Location: http://169.254.
 * 169.254/…`, and `fetch` following redirects on its own would have made that
 * request before anything in this file saw the address. So this one steers
 * manually and re-runs the rules on every hop.
 *
 * Failing closed is the whole point. A refused hop, a missing `Location`, a
 * chain longer than five, a runtime that hides the redirect from us — all of
 * them come back `null`, which the caller reports as the same "no PDF came
 * back from that link" a dead URL gets. Losing a legitimate five-hop redirect
 * costs the member the download button they already had; the other kind of
 * mistake costs everyone.
 */
async function fetchPastedPdf(url: string): Promise<Blob | null> {
  try {
    let target = url;
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
      const response = await fetch(target, {
        headers: { Accept: "application/pdf" },
        redirect: "manual",
        signal: AbortSignal.timeout(PDF_FETCH_TIMEOUT_MS),
      });

      if (response.status < 300 || response.status >= 400) {
        return await pdfFromResponse(response);
      }

      const next = nextRedirectHop(target, response.headers.get("location"));
      if (next === null) {
        return null;
      }
      target = next;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch a free copy from a link the member found.
 *
 * OpenAlex misses copies — a repository it has not indexed, a record where
 * every `pdf_url` is empty — and the member is frequently looking at the file
 * in another tab while Margin says there isn't one. Their recourse used to be
 * download, then re-upload. This is the shortcut: the same idea of a PDF the
 * DOI path uses, pointed where they say, server-side so no publisher's CORS
 * policy gets a vote — and rather more careful about where it ends up, since
 * this is the one address in this file a member chose.
 *
 * It will not replace a file. A paper that already has a PDF has a text layer
 * anchored to it, and swapping that out is `attachPdf`'s job — it re-extracts
 * and tells the ledger — so this one refuses and the dropzone stays the way
 * to do it.
 */
export const fetchPdfFromUrl = action({
  args: { paperId: v.id("papers"), url: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    // Also the authorization check: `paperFileState` requires membership.
    const state: { hasPdf: boolean } = await ctx.runQuery(
      internal.papers.paperFileState,
      { paperId: args.paperId },
    );
    if (state.hasPdf) {
      throw new ConvexError(
        "This paper already has a PDF. Use “Replace the file” to swap it for another.",
      );
    }

    const url = readPastedPdfUrl(args.url);
    const pdf = await fetchPastedPdf(url);
    if (pdf === null) {
      // The likeliest cause by a distance, and the member can fix it in one
      // move once they know: `pdfFromResponse` checks the magic bytes, so
      // an abstract page or a "download" interstitial fails here exactly like
      // a dead link does.
      throw new ConvexError(
        "No PDF came back from that link. It may be a page about the paper rather than the file itself — try the link behind “Download PDF”, or save the file and drop it in below.",
      );
    }

    const storageId = await ctx.storage.store(pdf);
    // Annotated for the same reason `findByDoi`'s result is: this action calls
    // a function in its own module, and the inferred type would refer to
    // itself through `internal.papers`.
    const outcome: "attached" | "already-has-pdf" = await ctx.runMutation(
      internal.papers.attachFetchedPdf,
      { paperId: args.paperId, storageId },
    );
    if (outcome === "already-has-pdf") {
      // The mutation has already put our blob back; nothing to clean up here.
      throw new ConvexError(
        "This paper already has a PDF — someone attached one while Margin was fetching yours.",
      );
    }
    return null;
  },
});
