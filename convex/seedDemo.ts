import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { DEMO_ANCHORS, DEMO_PAGES } from "./seedDemoPaper.data";

/**
 * The paper every personal library starts with, and the notes already in its
 * margin.
 *
 * A library provisioned empty asks its owner to prove the product to
 * themselves: paste a DOI, wait for a fetch, wait for a text layer, select a
 * passage, and only then find out what a margin conversation looks like. That
 * is four acts of faith before the first idea. So a new library arrives with
 * one paper already read and a handful of notes already written against real
 * passages of it — the reader's first screen is the thing the product is for,
 * rather than a form.
 *
 * ## Why this paper
 *
 * Ioannidis, "Why Most Published Research Findings Are False", PLoS Medicine
 * 2005 (doi:10.1371/journal.pmed.0020124). Published under Creative Commons
 * Attribution — PLOS has been CC BY since it started — so redistributing the
 * file inside this product is a licence grant, not a hope. That is the hard
 * constraint and the reason a more obvious landmark did not get the job: the
 * famous arXiv preprints carry arXiv's non-exclusive distribution licence,
 * which permits arXiv to distribute them and says nothing about us, and the
 * mid-century classics everyone reaches for first are still in copyright.
 *
 * It also happens to be the right paper for the demonstration. It is six pages,
 * it is about how a field reads its own evidence, and every research group that
 * would use Margin has argued about it.
 *
 * ## What the seeding deliberately does not do
 *
 * It writes no ledger events. `convex/digests.ts` builds a "since you were
 * away" digest by reading `events` for the lab and scanning the papers those
 * events name, so a paper no event mentions cannot enter that pool, cannot
 * produce a digest line, and cannot be paired by the cross-paper collision scan
 * that runs over it. Silence in the ledger is the exclusion, and it is
 * structural rather than a filter somebody has to remember.
 *
 * And the notes are `private`. Every derived surface in this backend is defined
 * as a read of `by_paper_and_visibility` at `"lab"` — the digest pool, the
 * brief's neighbour scan, `delegations.gatherLabVisible` for the scout, the
 * synthesis pool — so a private note is outside all of them by construction,
 * with no exclusion clause to add anywhere and none to forget. That is the
 * whole reason the seeded notes are private rather than lab-visible, and it is
 * also why they are authored by the library's own owner: `listForPaper` returns
 * the lab's shared notes plus *the caller's own*, so a private note by anyone
 * else would be a note nobody could read. See the PR that added this file for
 * the ghost-author alternative and what it would cost.
 */

/**
 * The asset's own version. Bump it only when the stored file changes; libraries
 * provisioned under an earlier revision keep the copy they were given, because
 * a paper somebody has annotated is not a thing to swap underneath them.
 */
const DEMO_REVISION = 1;

/** Where the canonical copy is fetched from, once per deployment. */
const DEMO_PDF_URL =
  "https://journals.plos.org/plosmedicine/article/file?id=10.1371/journal.pmed.0020124&type=printable";

const DEMO_TITLE = "Why Most Published Research Findings Are False";
const DEMO_DOI = "10.1371/journal.pmed.0020124";

/**
 * Bounds on what will be accepted off the wire. The file is a quarter of a
 * megabyte; anything wildly outside that is a redirect to a login page, an
 * error document, or a publisher who has changed what lives at this URL — none
 * of which should be stored and handed to every new account.
 */
const MIN_PDF_BYTES = 100_000;
const MAX_PDF_BYTES = 8 * 1024 * 1024;

/** The deployment's stored copy, as the two functions below pass it around. */
type CanonicalPdf = { storageId: Id<"_storage">; revision: number };

/**
 * Store the deployment's one copy of the demo PDF.
 *
 * Run once per deployment, by hand:
 *
 *   npx convex run seedDemo:seedCanonicalPdf
 *
 * Internal and operator-driven rather than scheduled, because it reaches out to
 * a publisher and because storing the wrong bytes is a mistake every subsequent
 * signup would inherit. A deployment that has never been seeded provisions
 * personal libraries perfectly well — they simply arrive empty, which is the
 * behaviour that predates this file rather than a broken one.
 *
 * Idempotent, and the recording mutation is what makes it so: two operators
 * racing this both store a blob, and the one that loses discards the bytes it
 * stored rather than leaving them in the deployment with nothing pointing at
 * them.
 */
export const seedCanonicalPdf = internalAction({
  args: {},
  returns: v.object({
    storageId: v.id("_storage"),
    revision: v.number(),
    /** False when a copy was already stored and this call changed nothing. */
    stored: v.boolean(),
  }),
  // Annotated because this handler reads `internal.seedDemo.*` — its own
  // module — and the generated api's type is derived from these exports.
  // Without a written return type that circle is one TypeScript cannot close.
  handler: async (ctx): Promise<CanonicalPdf & { stored: boolean }> => {
    const existing: CanonicalPdf | null = await ctx.runQuery(
      internal.seedDemo.canonicalPdf,
      {},
    );
    if (existing !== null && existing.revision === DEMO_REVISION) {
      return { ...existing, stored: false };
    }

    const response = await fetch(DEMO_PDF_URL);
    if (!response.ok) {
      throw new ConvexError(
        `The demo paper's publisher answered ${response.status}. Nothing was stored.`,
      );
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength < MIN_PDF_BYTES || bytes.byteLength > MAX_PDF_BYTES) {
      throw new ConvexError(
        `That download is ${bytes.byteLength} bytes, which is not the demo paper. Nothing was stored.`,
      );
    }
    // The content type is whatever the publisher's CDN chose to claim, so the
    // file's own first bytes are what gets believed. A login page served with
    // `application/pdf` is exactly the failure this catches.
    const header = new TextDecoder().decode(new Uint8Array(bytes, 0, 5));
    if (header !== "%PDF-") {
      throw new ConvexError(
        "That download is not a PDF. Nothing was stored.",
      );
    }

    const storageId = await ctx.storage.store(
      new Blob([bytes], { type: "application/pdf" }),
    );
    const recorded: CanonicalPdf & { stored: boolean } = await ctx.runMutation(
      internal.seedDemo.recordCanonicalPdf,
      { storageId, revision: DEMO_REVISION },
    );
    if (!recorded.stored) {
      // Somebody else's copy is the canonical one now. These bytes are already
      // unreachable, so they go rather than sitting in the deployment forever.
      await ctx.storage.delete(storageId);
    }
    return recorded;
  },
});

/** The deployment's stored demo PDF, or `null` if it has never been seeded. */
export const canonicalPdf = internalQuery({
  args: {},
  returns: v.union(
    v.null(),
    v.object({ storageId: v.id("_storage"), revision: v.number() }),
  ),
  handler: async (ctx) => {
    const row = await ctx.db.query("demoSeeds").order("desc").first();
    return row === null
      ? null
      : { storageId: row.storageId, revision: row.revision };
  },
});

/**
 * File a stored blob as the deployment's demo copy, unless one is already
 * filed. The check and the insert are one transaction, which is what makes two
 * concurrent seed runs produce one row.
 */
export const recordCanonicalPdf = internalMutation({
  args: { storageId: v.id("_storage"), revision: v.number() },
  returns: v.object({
    storageId: v.id("_storage"),
    revision: v.number(),
    stored: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("demoSeeds").order("desc").first();
    if (existing !== null && existing.revision >= args.revision) {
      return {
        storageId: existing.storageId,
        revision: existing.revision,
        stored: false,
      };
    }
    await ctx.db.insert("demoSeeds", {
      storageId: args.storageId,
      revision: args.revision,
      seededAt: Date.now(),
    });
    return { storageId: args.storageId, revision: args.revision, stored: true };
  },
});

/** One seeded note, before it knows which library or which paper it belongs to. */
type SeededNote = {
  anchor: keyof typeof DEMO_ANCHORS;
  type:
    | "note"
    | "critique"
    | "method-note"
    | "open-question"
    | "connection-to-own-work";
  body: string;
  /** Index into this array of the note this one answers, for the one thread. */
  replyTo?: number;
};

/**
 * The margin the first screen shows.
 *
 * Five notes, four passages, and one of them a reply — because a margin with no
 * thread in it demonstrates highlighting rather than conversation, and the
 * conversation is the product. The types are spread deliberately across the
 * vocabulary a reader would actually reach for on this paper: what the argument
 * proves, what its method rests on, what it leaves open, and where it touches
 * work of your own.
 *
 * Written to survive being read closely. Somebody who opens Margin for the
 * first time and finds four sentences of filler learns that the margin is
 * decoration; these are notes a person could have written about this paper, and
 * they are meant to be argued with, edited, or thrown away.
 */
const SEEDED_NOTES: readonly SeededNote[] = [
  {
    anchor: "thesis",
    type: "critique",
    body: "“Proven” is doing a lot of work here. What follows is an argument from a 2×2 table and some plausible values for R, β and u — analytic, not measured. That is not a weakness of the paper, but it is the difference between “most findings are false” and “most findings are false under these assumptions,” and almost everyone who cites this drops the second half.",
  },
  {
    anchor: "pvalue",
    type: "method-note",
    body: "The whole edifice rests here: a single study, one threshold, treated as conclusive. Every corollary further down is a different way of saying the pre-study odds were worse than the test admits.",
  },
  {
    anchor: "bias",
    type: "open-question",
    body: "u is carrying an enormous amount of the argument and is never estimated — only assumed across a range. Has anyone since actually measured it in a field, rather than reasoning about what it might plausibly be?",
  },
  {
    anchor: "bias",
    type: "note",
    replyTo: 2,
    body: "Partial answer, years later: the trial-registration literature gets at it sideways. Comparing registered outcomes against published ones is u observed rather than assumed — not the same quantity, but the closest thing to a measurement of it we have.",
  },
  {
    anchor: "corollary3",
    type: "connection-to-own-work",
    body: "This is the corollary that bites anything screening-shaped. Any pipeline that tests thousands of relationships and reports the survivors inherits it whole, however careful the individual tests are.",
  },
];

/**
 * Put the demo paper, its text layer, and its margin into one library.
 *
 * A plain function over a `MutationCtx` rather than a mutation of its own: it
 * runs inside whichever transaction provisioned the library, so a signup either
 * gets a library with a paper on its shelf or gets neither. Half a provisioning
 * is the one outcome worth ruling out — a lab whose demo paper failed to land
 * is indistinguishable, forever, from a lab whose owner deleted it.
 *
 * Answers `null` when the deployment has never been seeded, which is a library
 * that arrives empty rather than a signup that fails.
 *
 * `addedBy` and every note's `memberId` are the library's own owner. See the
 * block comment at the top of this file for why the notes are theirs and not a
 * ghost's, and what that buys.
 */
export async function seedDemoPaper(
  ctx: MutationCtx,
  labId: Id<"labs">,
  userId: Id<"users">,
): Promise<Id<"papers"> | null> {
  const seed = await ctx.db.query("demoSeeds").order("desc").first();
  if (seed === null) {
    return null;
  }

  const paperId = await ctx.db.insert("papers", {
    labId,
    title: DEMO_TITLE,
    authors: ["John P. A. Ioannidis"],
    year: 2005,
    venue: "PLoS Medicine",
    doi: DEMO_DOI,
    sourceUrl: "https://doi.org/" + DEMO_DOI,
    storageId: seed.storageId,
    pageCount: DEMO_PAGES.length,
    // Ready, and honestly so: the text layer goes in below, in this same
    // transaction, so the margins are open the moment the reader opens it.
    // Nothing has to wait for a browser to extract anything.
    ingestStatus: "ready",
    addedBy: userId,
  });

  for (let pageIndex = 0; pageIndex < DEMO_PAGES.length; pageIndex++) {
    await ctx.db.insert("paperPages", {
      paperId,
      pageIndex,
      text: DEMO_PAGES[pageIndex] ?? "",
    });
  }

  const inserted: Id<"annotations">[] = [];
  for (const note of SEEDED_NOTES) {
    const anchor = DEMO_ANCHORS[note.anchor];
    const parentId =
      note.replyTo === undefined ? undefined : inserted[note.replyTo];
    inserted.push(
      await ctx.db.insert("annotations", {
        labId,
        paperId,
        memberId: userId,
        anchor: {
          quote: anchor.quote,
          prefix: anchor.prefix,
          suffix: anchor.suffix,
          start: anchor.start,
          end: anchor.end,
          pageIndex: anchor.pageIndex,
        },
        type: note.type,
        body: note.body,
        // The load-bearing line. See the top of this file: private is what puts
        // these outside the digest, the brief, the scout and the synthesis
        // without a single exclusion clause anywhere for someone to forget.
        visibility: "private",
        ...(parentId === undefined ? {} : { parentId }),
      }),
    );
  }

  // No `recordEvent`, deliberately, for the paper or for any of the notes. The
  // ledger's silence is what keeps seeded content out of every digest.
  return paperId;
}
