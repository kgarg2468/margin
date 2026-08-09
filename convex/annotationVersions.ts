import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, query } from "./_generated/server";
import { getMembership, requireUserId } from "./lib/authz";
import { annotationType } from "./schema";
import { MAX_VERSIONS_KEPT } from "../lib/annotation-history/history";

/**
 * What a note used to say.
 *
 * An edit is not a deletion. Today's `updateBody` overwrites a body in place
 * and the sentence that was there is gone — which means the substrate cannot
 * answer the question the whole memory layer is for: what did the lab think in
 * March, and what superseded it. This module is the storage that makes edits
 * accumulate instead of destroy.
 *
 * ## Why not the ledger, given the ledger is *for* history
 *
 * Because the ledger's guarantee and this feature's guarantee point in
 * opposite directions, and only one of them can win per row.
 *
 * `events` is append-only: no row is ever updated and no row is ever deleted.
 * That is what makes it a provenance record worth trusting. It is also what
 * makes it the one place a body must never go — a prior draft written into an
 * append-only table could never afterwards be redacted, withdrawn, or made
 * private again, so the first time a member edited a note they would silently
 * and permanently lose the right to take those words back. The privacy
 * constitution's first rule ("a body never enters the ledger") is not a
 * stylistic preference about payload size; it is the thing that keeps
 * withdrawal meaningful.
 *
 * So the split: the ledger records the *fact* of an edit and the ordinal of
 * the state it replaced — references, both — and the prose lives here, in a
 * table whose rows are allowed to die.
 *
 * ## The three properties these rows are arranged around
 *
 * 1. **They die with the note.** `sweepVersions` hard-deletes every version of
 *    an annotation when it is withdrawn or deleted, on both of `remove`'s two
 *    endings. A withdrawn note whose earlier drafts were still readable would
 *    be a withdrawal that withdrew nothing — the author would have taken back
 *    the sentence and left every sentence it was ever a revision of.
 *
 * 2. **They carry no visibility.** Not "they inherit it", not "it is copied
 *    on write" — the column does not exist. `listForAnnotation` reads the
 *    audience off the parent annotation on every single read, so flipping a
 *    note to private makes its history invisible to the lab in the same
 *    instant and by the same act, with no second write to get wrong and no
 *    window in between. A stored copy of a visibility rule is a copy that can
 *    go stale, and this is the exact table where staleness would mean
 *    disclosing a draft its author had just taken back.
 *
 * 3. **They are bounded, and honest about it.** At most `MAX_VERSIONS_KEPT`
 *    per note, oldest dropped first. The alternative — refusing the edit — was
 *    considered and rejected: an author must always be able to fix their own
 *    sentence, and a note that says "you have revised this too many times" to
 *    someone correcting a typo has put its bookkeeping above its user. What is
 *    owed instead is disclosure, and `annotations.versionCount` keeps counting
 *    past the cap precisely so the panel can say "50 of 61 versions kept"
 *    rather than presenting the surviving tail as the beginning of the story.
 *
 * And no read tracking, here as everywhere: opening a note's history writes
 * nothing. `listForAnnotation` is a query, and queries in Convex cannot write
 * even if someone later wanted them to.
 */

/**
 * How many version rows one mutation clears per page, and how many pages it
 * will do before handing the rest to a scheduled follow-up.
 *
 * A page comfortably exceeds the retention cap, so in practice the first pass
 * always finishes and the scheduler is never reached. The loop and the
 * follow-up exist anyway for the reason `sweepMarks` has them: a mutation is
 * one transaction, an unbounded drain inside it is a transaction that can grow
 * until the platform refuses it, and a refused transaction would roll back the
 * note's withdrawal along with it. The author of a note must always be able to
 * take it back, whatever the table behind it looks like — so the drain is
 * capped and anything left over is swept afterwards, out of their way.
 */
const VERSION_DELETE_PAGE = 64;
const MAX_VERSION_DELETE_PAGES = 8;

const versionView = v.object({
  version: v.number(),
  body: v.string(),
  type: annotationType,
  replacedAt: v.number(),
});

/**
 * File the state a note is in right now, immediately before something replaces
 * it. Returns the ordinal that was filed, for the ledger to point at.
 *
 * Called from `updateBody` and `setType` and nowhere else, and called only
 * when the note has genuinely moved — a save that changed nothing files
 * nothing, because a version slot is a finite resource and spending one on a
 * no-op would push a real earlier draft off the end of the history.
 *
 * `at` is passed in rather than read from the clock here so that the moment
 * this state ended and the moment recorded on the annotation as its edit are
 * the same number, by construction rather than by two calls that agree.
 *
 * The count on the parent moves in the same transaction as the insert — the
 * `labs.memberCount` contract — which is what lets every card in the margin
 * know it has a history without a read per card.
 */
export async function recordVersion(
  ctx: MutationCtx,
  annotation: Doc<"annotations">,
  at: number,
): Promise<number> {
  const version = Math.max(1, Math.trunc(annotation.versionCount ?? 1));

  await ctx.db.insert("annotationVersions", {
    annotationId: annotation._id,
    version,
    body: annotation.body,
    type: annotation.type,
    replacedAt: at,
  });
  await ctx.db.patch(annotation._id, { versionCount: version + 1 });

  // Retention, as one indexed delete rather than a count and a trim.
  //
  // The rule is that the rows retained are always the last `MAX_VERSIONS_KEPT`
  // ordinals, so filing version N past the cap displaces exactly one row and
  // its ordinal is known without reading anything: N minus the cap. Counting
  // the rows to find out how many are too many would be a read that grows with
  // the history it is policing, to answer a question arithmetic already
  // answers.
  if (version > MAX_VERSIONS_KEPT) {
    const displaced = await ctx.db
      .query("annotationVersions")
      .withIndex("by_annotation_and_version", (q) =>
        q
          .eq("annotationId", annotation._id)
          .eq("version", version - MAX_VERSIONS_KEPT),
      )
      .unique();
    if (displaced !== null) {
      await ctx.db.delete(displaced._id);
    }
  }

  return version;
}

/**
 * Clear a note's history, up to a bounded amount of work. Returns whether it
 * finished.
 *
 * Called from both of `remove`'s endings, and the deleted branch is not the
 * interesting one — a version row pointing at an id nothing answers to is
 * simply garbage. The withdrawn branch is the one that matters: that note
 * keeps its row, with its body cleared, because replies are standing on it.
 * Leaving its earlier drafts behind would mean the tombstone reads "withdrawn
 * by its author" above a panel offering every sentence the author just
 * withdrew.
 */
export async function sweepVersions(
  ctx: MutationCtx,
  annotationId: Id<"annotations">,
): Promise<boolean> {
  for (let page = 0; page < MAX_VERSION_DELETE_PAGES; page += 1) {
    const rows = await ctx.db
      .query("annotationVersions")
      .withIndex("by_annotation_and_version", (q) =>
        q.eq("annotationId", annotationId),
      )
      .take(VERSION_DELETE_PAGE);
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    // A read that came back short has returned everything there was.
    if (rows.length < VERSION_DELETE_PAGE) {
      return true;
    }
  }
  return false;
}

/**
 * The rest of a sweep that did not fit in the mutation that started it.
 *
 * Re-entrant like `sweepAnnotationMarks`: one bounded pass, then it schedules
 * itself again if there is more. It takes a bare id and asks nothing about the
 * annotation, because by the time it runs the row may already be gone — which
 * is the point.
 */
export const sweepAnnotationVersions = internalMutation({
  args: { annotationId: v.id("annotations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!(await sweepVersions(ctx, args.annotationId))) {
      await ctx.scheduler.runAfter(
        0,
        internal.annotationVersions.sweepAnnotationVersions,
        args,
      );
    }
    return null;
  },
});

/**
 * What one note used to say — to its author, and to the lab if the lab can see
 * the note.
 *
 * The audience is decided here, on the parent, on every read, and there are
 * four ways to be told nothing. All four return an empty history rather than
 * an error, the way `listForPaper` renders an empty margin for a paper that is
 * missing or forbidden: the answer to "may I see this" should not itself
 * disclose which of the two reasons applies.
 *
 * - The note is gone.
 * - The caller is not in its lab.
 * - The note is private and the caller did not write it. A private note is
 *   invisible to everyone but its author, and its drafts are more private than
 *   it is, not less.
 * - The note has been withdrawn. Its rows are swept when that happens, so this
 *   is belt and braces — but it is the check that holds if a sweep is still
 *   draining, and the one that makes the rule readable in one place.
 *
 * Bounded at the retention cap plus one, which is the whole of a history by
 * construction. `truncated` reports the read hitting that ceiling rather than
 * storage having dropped anything — the panel says *that* from
 * `versionCount`, which counts states the rows no longer hold — so a `true`
 * here means something has gone wrong with the cap rather than that a note is
 * simply old.
 */
export const listForAnnotation = query({
  args: { annotationId: v.id("annotations") },
  returns: v.object({
    /** Oldest first. The state the note is in now is not in here — it is on the note. */
    versions: v.array(versionView),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const empty = { versions: [], truncated: false };

    const userId = await requireUserId(ctx);
    const annotation = await ctx.db.get(args.annotationId);
    if (annotation === null || annotation.deletedAt !== undefined) {
      return empty;
    }
    if ((await getMembership(ctx, annotation.labId, userId)) === null) {
      return empty;
    }
    if (
      annotation.visibility !== "lab" &&
      annotation.memberId !== userId
    ) {
      return empty;
    }

    const rows = await ctx.db
      .query("annotationVersions")
      .withIndex("by_annotation_and_version", (q) =>
        q.eq("annotationId", annotation._id),
      )
      .take(MAX_VERSIONS_KEPT + 1);

    return {
      truncated: rows.length > MAX_VERSIONS_KEPT,
      versions: rows.slice(0, MAX_VERSIONS_KEPT).map((row) => ({
        version: row.version,
        body: row.body,
        type: row.type,
        replacedAt: row.replacedAt,
      })),
    };
  },
});
