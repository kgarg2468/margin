import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { query } from "./_generated/server";
import { getMembership, requireUserId } from "./lib/authz";
import {
  MAX_SUBJECT_HISTORY as MAX_FINDING_HISTORY,
  REDACTED_ITEM_TEXT,
  type SubjectRef,
  redactWithdrawnItems,
  resolveSubjectForRead,
  stillSharedAmong,
  subjectOf,
  subjectRef,
} from "./delegations";
import { delegationAgentKind } from "./schema";

/**
 * Reading a scout's finding back.
 *
 * The row is not the answer. It was written against the margin as it stood at
 * the moment a model was asked, and the margin keeps moving: a note behind an
 * item may have been withdrawn or taken private in the meantime, and the item
 * is a paraphrase of that note. So every read re-resolves every citation and
 * re-applies whole-item redaction before anything crosses the wire — the
 * discipline `synthesis.getForSession` and `briefs.getForSession` already
 * apply to theirs, at the stricter threshold §3.7 of the design argues for.
 *
 * This is the defense of record. `findingCitations` makes supersession fast
 * and `store` re-checks citations before writing, but neither is what keeps a
 * withdrawn note out of a reader's cache. This is. If both of those were
 * broken, this read would still redact, which is the property that makes them
 * safe to be optimizations.
 *
 * Nothing here is a read receipt. Opening a finding writes nothing.
 */

/** One item as a reader may be shown it, after the re-check. */
const findingItemView = v.object({
  text: v.string(),
  /**
   * Kept even when the item is redacted. The ids are what let the client run
   * the same test and reach the same verdict, and a redaction marker with no
   * citations behind it would be rendered as though it were the scout's own
   * prose.
   */
  citedAnnotationIds: v.array(v.id("annotations")),
  citedPaperIds: v.array(v.id("papers")),
  /** True when a note behind this line has since been withdrawn or made private. */
  redacted: v.boolean(),
});

const findingView = v.object({
  _id: v.id("findings"),
  delegationId: v.id("delegations"),
  agentKind: delegationAgentKind,
  items: v.array(findingItemView),
  coverage: v.object({
    annotationsSearched: v.number(),
    papersTouched: v.number(),
    queriesRun: v.number(),
  }),
  droppedForCitation: v.number(),
  /** How many items the *read* just redacted, on top of what the gate dropped. */
  redactedCount: v.number(),
  model: v.string(),
  generatedAt: v.number(),
  supersededAt: v.optional(v.number()),
});

/**
 * A stored finding, re-checked against the margin as it stands right now.
 *
 * Exported so the surfaces PR has one implementation to call and cannot grow
 * a second, laxer one beside it.
 */
export async function toView(
  ctx: QueryCtx,
  finding: Doc<"findings">,
): Promise<typeof findingView.type> {
  const live = await stillSharedAmong(
    ctx,
    finding.labId,
    finding.items.flatMap((item) => item.citedAnnotationIds),
  );
  const { items, redactedCount } = redactWithdrawnItems(finding.items, live);
  return {
    _id: finding._id,
    delegationId: finding.delegationId,
    agentKind: finding.agentKind,
    items: items.map((item) => ({
      text: item.text,
      citedAnnotationIds: [...item.citedAnnotationIds],
      citedPaperIds: [...item.citedPaperIds],
      redacted: item.text === REDACTED_ITEM_TEXT,
    })),
    coverage: finding.coverage,
    droppedForCitation: finding.droppedForCitation,
    redactedCount,
    model: finding.model,
    generatedAt: finding.generatedAt,
    supersededAt: finding.supersededAt,
  };
}

/**
 * The newest finding still standing for one open question.
 *
 * Newest *non-superseded*: a subject that has been scouted twice renders the
 * second answer, and the first stays reachable through the delegation history
 * rather than being deleted.
 *
 * Null rather than an error for a subject the caller cannot see — and for an
 * annotation subject, "cannot see" includes one whose author has taken it
 * private since. A member who un-shares their open question un-shares what a
 * machine said about it in the same act, with no second write to get wrong.
 * That is the same answer a stale link gets everywhere else in this backend,
 * and it tells a prober nothing about whether the id was real.
 */
export const newestForSubject = query({
  args: { subject: subjectRef },
  returns: v.union(findingView, v.null()),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const ref: SubjectRef = args.subject;
    const owner =
      ref.kind === "annotation"
        ? await ctx.db.get(ref.annotationId)
        : await ctx.db.get(ref.actionId);
    if (owner === null) {
      return null;
    }
    if ((await getMembership(ctx, owner.labId, userId)) === null) {
      return null;
    }
    if (!(await resolveSubjectForRead(ctx, ref, owner.labId))) {
      return null;
    }

    const rows =
      ref.kind === "annotation"
        ? await ctx.db
            .query("findings")
            .withIndex("by_annotation", (q) =>
              q.eq("annotationId", ref.annotationId),
            )
            .order("desc")
            .take(MAX_FINDING_HISTORY)
        : await ctx.db
            .query("findings")
            .withIndex("by_action", (q) => q.eq("actionId", ref.actionId))
            .order("desc")
            .take(MAX_FINDING_HISTORY);

    const newest = rows.find(
      (row) => row.supersededAt === undefined && row.labId === owner.labId,
    );
    return newest === undefined ? null : await toView(ctx, newest);
  },
});

/**
 * One run's finding, by the delegation that produced it.
 *
 * The history read: a delegation row is permanent, so what it returned stays
 * reachable even once a newer run has superseded it.
 *
 * Permanent is not the same as unconditional. The subject gate runs here too,
 * because a delegation id is a bearer token by accident — anyone who saw the
 * run start is holding one, and without this check a question its author later
 * took private would stay readable to exactly them. The same fence
 * `newestForSubject` and `delegations.listForSubject` stand behind.
 */
export const forDelegation = query({
  args: { delegationId: v.id("delegations") },
  returns: v.union(findingView, v.null()),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const delegation = await ctx.db.get(args.delegationId);
    if (delegation === null) {
      return null;
    }
    if ((await getMembership(ctx, delegation.labId, userId)) === null) {
      return null;
    }
    const ref = subjectOf(delegation);
    if (ref === null) {
      return null;
    }
    if (!(await resolveSubjectForRead(ctx, ref, delegation.labId))) {
      return null;
    }
    const finding = await ctx.db
      .query("findings")
      .withIndex("by_delegation", (q) => q.eq("delegationId", delegation._id))
      .unique();
    return finding === null ? null : await toView(ctx, finding);
  },
});

/**
 * Which annotations one finding rests on, through the join table.
 *
 * The other direction of `delegations.findingsCiting`. Both are lookup, not
 * audience: what a reader is allowed to see is decided by `toView` above,
 * re-reading the annotations themselves.
 */
export async function citationsOf(
  ctx: QueryCtx,
  findingId: Id<"findings">,
): Promise<Id<"annotations">[]> {
  const rows = await ctx.db
    .query("findingCitations")
    .withIndex("by_finding", (q) => q.eq("findingId", findingId))
    .take(MAX_FINDING_HISTORY);
  return rows.map((row) => row.annotationId);
}
