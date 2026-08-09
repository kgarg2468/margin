import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Margin's Convex schema.
 *
 * The data model is the contract for the whole product, so every table is
 * declared here up front even though the functions that write some of them
 * land in later PRs (papers, reader/annotations, sessions, digests).
 *
 * Two invariants come from `.context/architecture-decision.md` and are worth
 * stating where the schema can enforce them:
 *
 * 1. `events` is an APPEND-ONLY ledger. Nothing updates or deletes a row in
 *    it. It is the provenance record that makes point-in-time queries and
 *    typed-pair collision detection possible.
 * 2. The privacy constitution forbids read/dwell tracking. There is
 *    deliberately no `reads` table and no `viewedAt` field anywhere; the only
 *    evidence of engagement Margin ever stores is an authored annotation.
 */

/** The 7-type annotation ontology. `note` is the untyped default; typing is one tap and never required. */
export const annotationType = v.union(
  v.literal("note"),
  v.literal("hypothesis"),
  v.literal("method-note"),
  v.literal("critique"),
  v.literal("definition"),
  v.literal("connection-to-own-work"),
  v.literal("open-question"),
);

/** Annotations are lab-visible inside a session context and private outside one; both are one tap to flip. */
export const annotationVisibility = v.union(
  v.literal("private"),
  v.literal("lab"),
);

/**
 * The five marks a member can put on someone else's note.
 *
 * A closed set, and deliberately a scholarly one: these are the things a
 * reader of a paper wants to say in one tap — I'm convinced, I'm not, this is
 * the important bit, I don't follow, bring it to the meeting. There is no
 * "like" and there will not be one. A reaction is an authored judgement about
 * an argument, not a vote, which is also why nothing in the product sorts or
 * ranks by them.
 *
 * `discuss` is the one no general-purpose annotator has: Margin is journal-club
 * software, and "raise this on Thursday" is the cheapest useful thing a member
 * can contribute while reading.
 */
export const reactionKind = v.union(
  v.literal("agree"),
  v.literal("doubt"),
  v.literal("key"),
  v.literal("unclear"),
  v.literal("discuss"),
);

/**
 * What an hour of discussion leaves behind.
 *
 * A journal club ends in one of three states per thing it touched: the lab
 * settled it (`decision`), the lab failed to settle it (`question`), or
 * somebody agreed to go and find out (`task`). The distinction decides whether
 * the thing comes back — see `lib/actions/outcomes.ts`, where the rule that a
 * decision has no open state lives, and `convex/actions.ts`, which enforces it.
 */
export const actionKind = v.union(
  v.literal("decision"),
  v.literal("question"),
  v.literal("task"),
);

/** Two roles only: the PI (owner/admin) and everyone else. */
export const membershipRole = v.union(v.literal("pi"), v.literal("member"));

/**
 * The two reasons Margin will interrupt a person: somebody named them, or
 * somebody answered them.
 *
 * Both are *addressed* — a fact about a note written to you specifically —
 * which is what separates a notification from a digest. Everything ambient
 * ("the lab annotated four papers this week") belongs to the boundary digest
 * and stays there; there is no notification kind for activity.
 */
export const notificationKind = v.union(
  v.literal("mention"),
  v.literal("reply"),
);

/**
 * Where a journal-club meeting is in its life: `scheduled → live → ended →
 * synthesized`, with `scheduled → cancelled` as the one way out. Every other
 * transition is refused (see `convex/sessions.ts`).
 */
export const sessionStatus = v.union(
  v.literal("scheduled"),
  v.literal("live"),
  v.literal("ended"),
  v.literal("synthesized"),
  v.literal("cancelled"),
);

/**
 * The five sections a synthesis is allowed to have.
 *
 * Fixed rather than model-chosen: the shape of the write-up is a product
 * decision, and pinning it is also what lets the parser reject anything the
 * model invents outside it.
 */
export const synthesisSectionKey = v.union(
  v.literal("summary"),
  v.literal("open-questions"),
  v.literal("critiques-and-methods"),
  v.literal("connections"),
  v.literal("next-reading"),
);

/**
 * The four lenses a pre-session brief is cut into.
 *
 * Fixed for the same reason `synthesisSectionKey` is: the shape of the artifact
 * is a product decision. Here it is also a promise about where each line came
 * from — `collisions` is the shipped gold typed-pair matrix and nothing else,
 * `carried-over` is unanswered questions from earlier sessions on this paper
 * and nothing else. A section key a reader cannot predict the provenance of
 * would defeat the point of assembling rather than generating.
 */
export const briefSectionKey = v.union(
  v.literal("collisions"),
  v.literal("open-questions"),
  v.literal("carried-over"),
  v.literal("floor"),
);

/**
 * Where a paper is on its way to being readable:
 *
 * - `needs-pdf` — metadata only. A DOI lookup found the record but no
 *   open-access file; a member can attach the PDF later.
 * - `pending` — the file is stored but its text layer hasn't been extracted
 *   yet. Extraction runs in the browser (pdf.js), so a PDF that Margin fetched
 *   itself from an open-access host waits here until someone opens it.
 * - `extracting` / `failed` — the states above, in flight and gone wrong.
 * - `ready` — file and per-page text both present; anchors can resolve.
 */
export const ingestStatus = v.union(
  v.literal("needs-pdf"),
  v.literal("pending"),
  v.literal("extracting"),
  v.literal("ready"),
  v.literal("failed"),
);

/**
 * W3C Web Annotation-style redundant selector: a TextQuoteSelector
 * (`quote` + `prefix`/`suffix` context) plus a TextPositionSelector
 * (`start`/`end` character offsets into the page's extracted text). The
 * redundancy is what lets us fuzzy re-anchor when a preprint and the
 * publisher PDF disagree about layout.
 */
export const anchor = v.object({
  quote: v.string(),
  prefix: v.string(),
  suffix: v.string(),
  start: v.number(),
  end: v.number(),
  pageIndex: v.number(),
});

/**
 * Fields every ledger row carries, whatever kind of fact it records.
 *
 * `paperId` and `sessionId` live here rather than only on the variants that
 * need them because an index field has to exist on every document in the
 * table: `by_paper_and_at` and `by_session_and_at` read them. Variants that
 * always have one narrow it back to required (see `paper.added` below).
 */
const eventBase = {
  labId: v.id("labs"),
  actorId: v.id("users"),
  at: v.number(),
  paperId: v.optional(v.id("papers")),
  sessionId: v.optional(v.id("sessions")),
};

/**
 * Every kind of thing that can happen in a lab, as a discriminated union on
 * `type`. Note the absence of any "read"/"viewed" variant — that is
 * intentional and permanent.
 *
 * Each variant declares its own payload as real, typed columns instead of a
 * stringly `Record<string, string>` bag. The ledger is the provenance record
 * the whole product reads back from, so a mistyped payload key should be a
 * compile error, not a silently-missing digest line.
 */
export const eventDoc = v.union(
  v.object({
    ...eventBase,
    type: v.literal("lab.created"),
    name: v.string(),
  }),
  v.object({
    ...eventBase,
    type: v.literal("member.joined"),
    subjectUserId: v.id("users"),
    role: membershipRole,
    /** `founding` is the PI who created the lab; `invite` redeemed a code. */
    via: v.union(v.literal("founding"), v.literal("invite")),
  }),
  v.object({
    ...eventBase,
    type: v.literal("member.left"),
    subjectUserId: v.id("users"),
    /** `left` is self-initiated; `removed` was done by the PI. */
    reason: v.union(v.literal("left"), v.literal("removed")),
  }),
  v.object({
    ...eventBase,
    type: v.literal("invite.created"),
    inviteId: v.id("invites"),
  }),
  v.object({
    ...eventBase,
    type: v.literal("invite.revoked"),
    inviteId: v.id("invites"),
  }),
  v.object({
    ...eventBase,
    type: v.literal("paper.added"),
    paperId: v.id("papers"),
    title: v.string(),
  }),
  v.object({
    ...eventBase,
    type: v.literal("paper.ingested"),
    paperId: v.id("papers"),
    pageCount: v.number(),
  }),
  /**
   * A *different* file for a paper that already had one — a preprint swapped
   * for the version of record. Distinct from `paper.ingested` because it
   * invalidates the text layer every existing annotation is anchored to, and
   * a reader looking at why an anchor moved needs to find that fact here.
   */
  v.object({
    ...eventBase,
    type: v.literal("paper.pdf_replaced"),
    paperId: v.id("papers"),
    pageCount: v.number(),
  }),
  /**
   * A label went on a paper, or came off it.
   *
   * The tag itself is carried rather than referenced, and that is the one place
   * the ledger's usual rule bends on purpose. A tag has no row of its own — it
   * is a string on the paper — so there is nothing to point at, and "somebody
   * tagged this paper (with what?)" is not a fact worth appending. It is also
   * not private material: a tag is lab vocabulary by construction, visible to
   * every member the moment it is written, so a copy of one in an append-only
   * table cannot outlive an audience it never had.
   */
  v.object({
    ...eventBase,
    type: v.literal("paper.tagged"),
    paperId: v.id("papers"),
    tag: v.string(),
  }),
  v.object({
    ...eventBase,
    type: v.literal("paper.untagged"),
    paperId: v.id("papers"),
    tag: v.string(),
  }),
  v.object({
    ...eventBase,
    type: v.literal("collection.created"),
    collectionId: v.id("collections"),
    name: v.string(),
  }),
  v.object({
    ...eventBase,
    type: v.literal("collection.renamed"),
    collectionId: v.id("collections"),
    /** The name it goes by *now* — the old one is the previous row. */
    name: v.string(),
  }),
  /**
   * The collection row is gone, and this is all that is left of it. The name
   * rides along for that reason: without it the ledger would say a member
   * deleted a collection nobody can name any more.
   */
  v.object({
    ...eventBase,
    type: v.literal("collection.deleted"),
    collectionId: v.id("collections"),
    name: v.string(),
  }),
  /**
   * One paper joined a collection or left it.
   *
   * Per paper rather than per edit, because `paperId` is what makes the row
   * reachable through `by_paper_and_at` — a paper's own record can then say
   * which shelves it has been put on, which is the question a reader actually
   * asks. A bulk edit becomes several of these, which is what it is.
   */
  v.object({
    ...eventBase,
    type: v.literal("collection.papers_changed"),
    collectionId: v.id("collections"),
    paperId: v.id("papers"),
    change: v.union(v.literal("added"), v.literal("removed")),
  }),
  v.object({
    ...eventBase,
    type: v.literal("annotation.created"),
    paperId: v.id("papers"),
    annotationId: v.id("annotations"),
    annotationType,
    visibility: annotationVisibility,
  }),
  /**
   * A note was rewritten or retyped, and the state it was in before that was
   * preserved.
   *
   * `version` is the ordinal of the state this edit *replaced* — the row in
   * `annotationVersions` the edit created. A number, not the prose: pointing
   * at the prior state is a reference, and the ledger holds references. The
   * thing pointed at is deletable and this row is not, which is the whole
   * reason the split exists (see `annotationVersions`). A reader that follows
   * the pointer and finds nothing has learned the truth: the note was edited,
   * and what it used to say is no longer kept.
   *
   * Optional because rows written before annotation history shipped have no
   * version to name, and the ledger is append-only — there is no pass that
   * could go back and give them one.
   */
  v.object({
    ...eventBase,
    type: v.literal("annotation.edited"),
    paperId: v.id("papers"),
    annotationId: v.id("annotations"),
    version: v.optional(v.number()),
  }),
  v.object({
    ...eventBase,
    type: v.literal("annotation.deleted"),
    paperId: v.id("papers"),
    annotationId: v.id("annotations"),
  }),
  v.object({
    ...eventBase,
    type: v.literal("annotation.visibility_changed"),
    paperId: v.id("papers"),
    annotationId: v.id("annotations"),
    /** The visibility the annotation was moved *to*. */
    visibility: annotationVisibility,
  }),
  v.object({
    ...eventBase,
    type: v.literal("annotation.replied"),
    paperId: v.id("papers"),
    annotationId: v.id("annotations"),
    parentId: v.id("annotations"),
  }),
  /**
   * Somebody named a labmate in a note the lab can see.
   *
   * A lab fact, and recorded as one: who addressed whom, on which passage. It
   * is written when the mention actually becomes live — which for a note
   * written privately and shared later is the moment it is shared, not the
   * moment it was typed. A mention inside a private note is nobody's business
   * but its author's, and there is deliberately no ledger row for it.
   *
   * One row per *delivery*, not per pair of people. While a note stays shared
   * it announces each person once, however many times it is edited. Un-sharing
   * takes the recipient's copy back, so re-sharing hands it over again and
   * appends a second row — which is the honest record: the ledger says what
   * happened, and what happened is that they were told twice.
   *
   * There is no matching `annotation.mention_acknowledged`. Whether a
   * notification has been dismissed is the recipient's own state, not
   * something the lab gets to read back out of the ledger — that would be a
   * read receipt with extra steps.
   */
  v.object({
    ...eventBase,
    type: v.literal("annotation.mentioned"),
    paperId: v.id("papers"),
    annotationId: v.id("annotations"),
    /** The member who was named. */
    subjectUserId: v.id("users"),
  }),
  v.object({
    ...eventBase,
    type: v.literal("session.scheduled"),
    paperId: v.id("papers"),
    sessionId: v.id("sessions"),
    scheduledAt: v.number(),
    presenterId: v.id("users"),
  }),
  /**
   * A session moved to a different time. Recorded as its own fact rather than
   * folded into `session.scheduled` because the prep digest is computed from a
   * boundary two hours before `scheduledAt` — when that boundary moves, the
   * ledger has to be able to say when it moved and who moved it.
   */
  v.object({
    ...eventBase,
    type: v.literal("session.rescheduled"),
    paperId: v.id("papers"),
    sessionId: v.id("sessions"),
    /** The time the session was moved *to*. */
    scheduledAt: v.number(),
  }),
  v.object({
    ...eventBase,
    type: v.literal("session.presenter_changed"),
    paperId: v.id("papers"),
    sessionId: v.id("sessions"),
    /** The member who is presenting *now*. */
    presenterId: v.id("users"),
  }),
  /**
   * A presenter's brief was assembled for a session.
   *
   * A collective fact, unlike a digest — which is why this variant exists and
   * `digests` deliberately has none (see the note at the top of
   * `convex/digests.ts`). A digest is one person's mail and recording its
   * delivery would put an attention trail in the ledger; a brief is the
   * meeting's agenda, read by the presenter and the PI, and "the lab had a
   * brief for this session and it rested on 14 notes" is exactly the kind of
   * fact the ledger holds.
   *
   * `actorId` is the presenter even when `trigger` is `scheduled`, because the
   * brief is theirs and a job has no name — which is what `trigger` is for.
   * Without it the ledger would quietly claim the presenter pressed a button at
   * two in the morning.
   */
  v.object({
    ...eventBase,
    type: v.literal("brief.generated"),
    paperId: v.id("papers"),
    sessionId: v.id("sessions"),
    briefId: v.id("briefs"),
    /** Which assembly this was for the session, counting from 1. */
    generation: v.number(),
    /** How many lines it came out with, across every section. */
    itemCount: v.number(),
    /** Whether a person asked for it or the T−2h boundary did. */
    trigger: v.union(v.literal("scheduled"), v.literal("manual")),
  }),
  /**
   * The presenter (or the PI) read the brief and marked it reviewed.
   *
   * Bound to a `generation` because a brief is a machine artifact end to end —
   * unlike a synthesis, where the approved copy is prose a person wrote and
   * survives the draft being rebuilt. Approving here means "I have read *this*
   * assembly", so re-assembling starts a new generation with nobody's name on
   * it, and the ledger keeps every generation that was ever signed off.
   */
  v.object({
    ...eventBase,
    type: v.literal("brief.approved"),
    paperId: v.id("papers"),
    sessionId: v.id("sessions"),
    briefId: v.id("briefs"),
    generation: v.number(),
    /** Notes still shared at the moment of approval — the size of what was checked. */
    citationCount: v.number(),
  }),
  v.object({
    ...eventBase,
    type: v.literal("session.started"),
    sessionId: v.id("sessions"),
  }),
  v.object({
    ...eventBase,
    type: v.literal("session.ended"),
    sessionId: v.id("sessions"),
  }),
  v.object({
    ...eventBase,
    type: v.literal("session.synthesized"),
    sessionId: v.id("sessions"),
  }),
  /**
   * A person signed the write-up off. `session.synthesized` says a model
   * produced a draft; this says a human read it, edited it, and put the lab's
   * name on the result — which is the only version that is the lab's official
   * record, and a different fact with a different actor.
   *
   * Written on every approval rather than only the first. An approved copy
   * goes stale when a note it cites is withdrawn, and the fix is to review it
   * and approve it again; the ledger is where that history lives, since the
   * session row only ever holds the latest one.
   *
   * `citationCount` is the size of the citation snapshot the copy was checked
   * against at that moment — a number, not the ids, because the ledger is
   * append-only and holds references rather than a second copy of state it
   * would then have to keep true. The ids live on the session, where they can
   * be re-checked against the margin as it stands.
   */
  v.object({
    ...eventBase,
    type: v.literal("synthesis.approved"),
    paperId: v.id("papers"),
    sessionId: v.id("sessions"),
    citationCount: v.number(),
    /** True when this replaced a copy that had already been approved. */
    reapproved: v.boolean(),
  }),
  /**
   * A meeting that was scheduled and then wasn't held. The row stays — a
   * cancelled session is a fact about the lab's history, and annotations
   * written during its prep still point at it.
   */
  v.object({
    ...eventBase,
    type: v.literal("session.cancelled"),
    paperId: v.id("papers"),
    sessionId: v.id("sessions"),
  }),
  /**
   * Someone put a mark on a note.
   *
   * A fact about what a member *did*, which is the only kind of engagement the
   * constitution lets the ledger hold: a reaction is authored — chosen, typed,
   * attributable — where a view is something that merely happened to a person.
   * The distinction is the whole line between this and read tracking.
   */
  v.object({
    ...eventBase,
    type: v.literal("annotation.reacted"),
    paperId: v.id("papers"),
    annotationId: v.id("annotations"),
    kind: reactionKind,
  }),
  /**
   * And took it off again.
   *
   * Its own variant rather than a `removed: true` flag on the one above,
   * because the ledger is a list of facts and "agreed, then didn't" is two of
   * them. A flag would also make every reader of `annotation.reacted` — the
   * digest among them — have to remember to check it, and the one that forgot
   * would quietly report a mark that had been withdrawn.
   */
  v.object({
    ...eventBase,
    type: v.literal("annotation.unreacted"),
    paperId: v.id("papers"),
    annotationId: v.id("annotations"),
    kind: reactionKind,
  }),
  /**
   * The discussion produced something the lab is carrying: a decision, a
   * question it failed to answer, or a task somebody took on.
   *
   * References all the way down. `citedAnnotationId` is the note the outcome
   * came out of and never the note's prose — the ledger is append-only, so a
   * body copied in here would outlive its author's right to withdraw it, and
   * the reader re-checks the citation's visibility on every read instead
   * (`convex/actions.ts`). The outcome's own text is on the `actions` row,
   * where the person who wrote it can still reach it.
   *
   * `subjectUserId` is the member a task was recorded against, and is absent on
   * everything else — a decision is nobody's in particular, and an unassigned
   * task is a task the room has not yet found a volunteer for.
   */
  v.object({
    ...eventBase,
    type: v.literal("action.recorded"),
    paperId: v.id("papers"),
    sessionId: v.id("sessions"),
    actionId: v.id("actions"),
    kind: actionKind,
    citedAnnotationId: v.optional(v.id("annotations")),
    subjectUserId: v.optional(v.id("users")),
  }),
  /**
   * A task changed hands, or found its first owner.
   *
   * Its own fact rather than a field the `actions` row quietly overwrites: who
   * agreed to do a thing, and when the lab stopped expecting it of them, is
   * exactly the history a PI is asking about six weeks later, and the row only
   * ever holds the current answer.
   */
  v.object({
    ...eventBase,
    type: v.literal("action.assigned"),
    paperId: v.id("papers"),
    sessionId: v.id("sessions"),
    actionId: v.id("actions"),
    /** The member it is now with. */
    subjectUserId: v.id("users"),
  }),
  /**
   * Somebody declared it carried no further: the question is answered, or the
   * task is done.
   *
   * One variant with a `kind` rather than a `task.completed` and a
   * `question.resolved`, on the same reasoning
   * `annotation.visibility_changed` carries the visibility it moved *to*. The
   * fact has one shape — a member said this stops travelling — and `kind` is
   * what makes a reader able to say which of the two words to use for it.
   * Never written for a decision: recording a decision is the settling.
   */
  v.object({
    ...eventBase,
    type: v.literal("action.settled"),
    paperId: v.id("papers"),
    sessionId: v.id("sessions"),
    actionId: v.id("actions"),
    kind: actionKind,
  }),
  /**
   * And back open, because the answer didn't hold.
   *
   * Recorded rather than achieved by deleting the settling event, which is what
   * append-only means: the lab did think this was finished, and a memory that
   * quietly edits out the fortnight it believed so is worth less than one that
   * says it.
   */
  v.object({
    ...eventBase,
    type: v.literal("action.reopened"),
    paperId: v.id("papers"),
    sessionId: v.id("sessions"),
    actionId: v.id("actions"),
    kind: actionKind,
  }),
  /**
   * Taken back by whoever recorded it — the mis-heard decision, the task typed
   * against the wrong name. The row goes; this stays, because the row was in
   * front of the lab and the ledger does not pretend otherwise.
   */
  v.object({
    ...eventBase,
    type: v.literal("action.withdrawn"),
    paperId: v.id("papers"),
    sessionId: v.id("sessions"),
    actionId: v.id("actions"),
    kind: actionKind,
  }),
);

export default defineSchema({
  // Auth-owned tables: users, authAccounts, authSessions, authRefreshTokens,
  // authVerificationCodes, authVerifiers, authRateLimits. `users` is the
  // canonical person record (name, email) that memberships point at.
  ...authTables,

  /** A research group. Created by its PI; everything else in the product hangs off a lab. */
  labs: defineTable({
    name: v.string(),
    institution: v.optional(v.string()),
    createdBy: v.id("users"),
    /**
     * Denormalized count of rows in `memberships` for this lab. It is here
     * because the sidebar renders it for every lab you belong to, and reading
     * it by counting memberships made that a query per lab. Every mutation
     * that adds or removes a membership must move this in the same
     * transaction — Convex mutations are atomic, so it cannot drift.
     */
    memberCount: v.number(),
  }).index("by_creator", ["createdBy"]),

  /** Join table between users and labs; the single source of truth for authorization. */
  memberships: defineTable({
    labId: v.id("labs"),
    userId: v.id("users"),
    role: membershipRole,
    joinedAt: v.number(),
  })
    .index("by_lab", ["labId"])
    .index("by_user", ["userId"])
    .index("by_lab_and_user", ["labId", "userId"]),

  /** A shareable 8-character code that grants `member` access to one lab; reusable until it expires, fills up, or is revoked. */
  invites: defineTable({
    code: v.string(),
    labId: v.id("labs"),
    createdBy: v.id("users"),
    expiresAt: v.number(),
    /**
     * A counter, not a roster. *Who* redeemed a code is already a
     * `member.joined` fact in the ledger with full provenance; duplicating it
     * as an array here only bought an unbounded field on a hot document.
     */
    useCount: v.number(),
    /** Redemptions are refused past this. A code is a credential, not a URL. */
    maxUses: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_code", ["code"])
    .index("by_lab", ["labId"]),

  /**
   * A paper in a lab's library.
   *
   * `doi` is stored normalized (lowercase, bare — no `https://doi.org/`
   * prefix) so `by_lab_and_doi` can be the dedupe key: one DOI is one paper
   * per lab, however it got there.
   *
   * The extracted text does NOT live here. A book-length PDF's text runs to
   * several megabytes and a Convex document is capped at 1 MiB, so it hangs
   * off `paperPages` instead, one document per page.
   */
  papers: defineTable({
    labId: v.id("labs"),
    title: v.string(),
    authors: v.optional(v.array(v.string())),
    year: v.optional(v.number()),
    venue: v.optional(v.string()),
    abstract: v.optional(v.string()),
    doi: v.optional(v.string()),
    sourceUrl: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
    pageCount: v.optional(v.number()),
    ingestStatus,
    ingestError: v.optional(v.string()),
    addedBy: v.id("users"),
    /**
     * The lab's shelf marks for this paper, canonical form only (lowercased,
     * trimmed, ≤32 characters, ≤12 of them — see `lib/library/tags.ts`).
     *
     * A field rather than a join table, and the reason is that filtering by tag
     * is not a query here: `listPapers` already reads the lab's whole library
     * under one bounded `take(200)`, so the tags arrive with the rows that are
     * about to be drawn and the filter is a pass over an array the client is
     * holding anyway. A `paperTags` table would add a second read per paper —
     * or a fan-out per render — to answer a question the first read had already
     * answered. It would also make "the lab's vocabulary" a scan of a table
     * with no `labId` on it, which is the same shape of problem `paperPages`
     * has and the reason ⌘K cannot search inside PDFs.
     *
     * What that costs: no index on a tag, so this stops scaling at roughly the
     * point `listPapers`'s own ceiling does. That is the right trade at 200
     * papers and the wrong one at 20,000; the 201st paper is the signal to
     * revisit both together.
     */
    tags: v.optional(v.array(v.string())),
  })
    .index("by_lab", ["labId"])
    .index("by_lab_and_doi", ["labId", "doi"])
    /**
     * "Is any paper using this blob?" — the question `discardUpload` asks
     * before deleting a file the browser uploaded and then failed to attach.
     * Without it that check would be a full scan of the table, which is a
     * strange price to pay for cleaning up after a dropped connection.
     */
    .index("by_pdf_storage", ["storageId"])
    /**
     * What ⌘K looks papers up by. Titles only: the extracted text lives in
     * `paperPages`, which carries no `labId` and so cannot be filtered to the
     * caller's lab in a search index at all.
     *
     * `labId` is a filter field rather than a post-filter because a search
     * index is global to the table — without it a query would rank every
     * lab's library together and then throw most of it away.
     */
    .searchIndex("search_title", {
      searchField: "title",
      filterFields: ["labId"],
    }),

  /**
   * One page of pdf.js-extracted text, the surface anchors resolve against.
   *
   * A row per page rather than an array on `papers` for two reasons: the 1 MiB
   * document limit, and the fact that the reader only ever needs the pages it
   * is showing. `pageIndex` is 0-based and matches the `anchor.pageIndex` an
   * annotation records.
   */
  paperPages: defineTable({
    paperId: v.id("papers"),
    pageIndex: v.number(),
    text: v.string(),
  })
    .index("by_paper", ["paperId"])
    .index("by_paper_and_page", ["paperId", "pageIndex"]),

  /**
   * A named, ordered shelf of papers — "Foundational", "Methods week".
   *
   * `paperIds` is an array on the collection rather than a join table, and the
   * ordering is why. A collection is a *reading order*: the first paper is the
   * one to read first, and that is the whole difference between a collection
   * and a tag. An array is that order, natively; a join table would need an
   * explicit rank column, and every reorder would rewrite a row per paper to
   * express something a single array write already says. A paper sits in as
   * many collections as it likes — the same id simply appears in several of
   * these — so the many-to-many the join table would have bought is here too.
   *
   * Bounded at `MAX_COLLECTION_PAPERS` (see `convex/collections.ts`) for the
   * usual reason an array field is bounded: a Convex document is capped at
   * 1 MiB, and an unbounded list on a hot document is a table with no ceiling
   * wearing a field's clothes. The cap is the library's own `take(200)`, so a
   * collection can hold every paper a lab can list and no more.
   *
   * A collection is lab property: any member makes one, any member puts papers
   * in it. Renaming and deleting are narrower (creator or PI) because those
   * take something away from everyone else.
   */
  collections: defineTable({
    labId: v.id("labs"),
    name: v.string(),
    createdBy: v.id("users"),
    paperIds: v.array(v.id("papers")),
  }).index("by_lab", ["labId"]),

  /**
   * A filter a member gave a name to. Personal, and deliberately so.
   *
   * Everything else in this schema is lab property — tags, collections, the
   * ledger. This is not: "the papers I still have to read for Thursday" is a
   * working note about one person's week, and publishing everyone's to the lab
   * would turn a convenience into a status board. It is also the reason there
   * is no ledger event anywhere near this table. A saved filter records nothing
   * about the lab's reasoning; it is furniture, and the ledger is for facts.
   *
   * The payload mirrors `LibraryFilter` in `lib/library/filter.ts` — tags, a
   * collection, an ingest state. Not the text box: what you type into the
   * library right now is how you find one paper you already have in mind, and
   * filing it under a name would be saving the question instead of the shelf.
   *
   * `collectionId` is a plain id with no referential guarantee. Collections are
   * deleted by people, saved filters belong to other people, and cascading a
   * delete into a colleague's saved views would be one member silently editing
   * another's. The reader resolves it and says the shelf is gone.
   */
  savedFilters: defineTable({
    userId: v.id("users"),
    labId: v.id("labs"),
    name: v.string(),
    tags: v.array(v.string()),
    collectionId: v.optional(v.id("collections")),
    ingestStatus: v.optional(ingestStatus),
  })
    .index("by_user", ["userId"])
    .index("by_user_and_lab", ["userId", "labId"]),

  /**
   * One journal-club meeting: a lab reads one paper, someone presents, then it
   * gets synthesized.
   *
   * The lifecycle is `scheduled → live → ended → synthesized`, with
   * `scheduled → cancelled` as the one way out. A cancelled session is kept
   * rather than deleted: annotations written during its prep still point at it,
   * and the ledger already says it existed.
   */
  sessions: defineTable({
    labId: v.id("labs"),
    paperId: v.id("papers"),
    title: v.optional(v.string()),
    scheduledAt: v.number(),
    presenterId: v.id("users"),
    status: sessionStatus,
    presenterNotes: v.optional(v.string()),
    /**
     * The approved write-up: the markdown a person edited and signed off, and
     * the only version that is the lab's official record. The generated
     * sections in `syntheses` are the draft it was made from — re-generating
     * replaces that row and deliberately leaves this one alone, because a
     * human artifact is not something a model gets to overwrite.
     */
    synthesis: v.optional(v.string()),
    synthesisApprovedAt: v.optional(v.number()),
    /**
     * The annotations the approved copy rested on when it was approved, as
     * they stood at that moment.
     *
     * The generated draft re-checks its citations on every read and redacts
     * what is no longer shared (see `applyWithdrawals`). An approved copy
     * cannot do that: it is prose a person wrote, and no machine can tell
     * which sentence of it came from which note. So it does the honest other
     * thing — it keeps the list it was checked against, and when one of those
     * notes is withdrawn or made private the reader is told the copy is no
     * longer current and asked to review it. Silence would be the write-up
     * quoting a note somebody has taken back.
     */
    synthesisCitedAnnotationIds: v.optional(v.array(v.id("annotations"))),
    /**
     * When a synthesis run claimed this session, if one currently has it.
     *
     * Generation is an action: it leaves the transaction, spends up to two
     * minutes and several thousand tokens at the model provider, and comes back
     * to overwrite one row. Two people pressing the button — or one person
     * pressing it twice — would pay for that twice and race over the result.
     * The marker is a timestamp rather than a flag because an action that dies
     * mid-flight cannot clear anything, and a lease that never expires is a
     * session that can never be synthesized again.
     */
    synthesisGeneratingAt: v.optional(v.number()),
    /**
     * Which run holds that claim.
     *
     * The timestamp alone is not enough, because the lease expires: a run that
     * overran it would come back and clear — or overwrite — the work of the
     * run that legitimately replaced it. Every write in the generation path
     * presents this token and does nothing if the session is holding another.
     */
    synthesisGeneratingLease: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    cancelledAt: v.optional(v.number()),
    /**
     * The scheduled job that builds this session's T−2h prep digest.
     *
     * Stored because the boundary moves: rescheduling has to cancel the job
     * aimed at the old time and replace it, and cancelling the session has to
     * call it off entirely. Without the handle there is no way to reach a job
     * once it is queued, and a lab that moved its meeting would get a digest
     * for the time it moved away from.
     */
    prepDigestJobId: v.optional(v.id("_scheduled_functions")),
    createdBy: v.id("users"),
  })
    .index("by_lab", ["labId"])
    .index("by_paper", ["paperId"])
    .index("by_lab_and_scheduled", ["labId", "scheduledAt"])
    .index("by_lab_and_status", ["labId", "status"])
    /**
     * Sessions by the name someone gave them. A session's `title` is optional
     * — most of them are known by the paper they are about — so this finds the
     * ones a lab bothered to name ("Methods week", "Reviewer 2 postmortem")
     * and nothing else. Finding a meeting by its paper is what the paper hit
     * is for.
     */
    .searchIndex("search_title", {
      searchField: "title",
      filterFields: ["labId"],
    }),

  /** A typed, anchored note on a passage — the atom of the product. `parentId` makes threads. */
  annotations: defineTable({
    labId: v.id("labs"),
    paperId: v.id("papers"),
    sessionId: v.optional(v.id("sessions")),
    memberId: v.id("users"),
    anchor,
    type: annotationType,
    body: v.string(),
    visibility: annotationVisibility,
    /**
     * The labmates this note names, as ids the author *picked* from a menu.
     *
     * Structured rather than parsed. The body keeps the plain text the author
     * wrote ("@Sara Chen") and this keeps who that meant — so nothing has to
     * regex names or email addresses back out of prose, and an address quoted
     * from a methods section can never become a message to a stranger.
     *
     * Stored on private notes too, and inert there: a mention is only ever
     * *delivered* from a lab-visible note, so the field is a record of who the
     * author addressed and the visibility is what decides whether anyone is
     * told. That is what lets a note written privately and shared a day later
     * notify the right people at the moment it is shared.
     */
    mentions: v.optional(v.array(v.id("users"))),
    parentId: v.optional(v.id("annotations")),
    editedAt: v.optional(v.number()),
    /**
     * How many states this note has had, counting the one it is in now.
     *
     * Absent means one — a note nobody has edited — so an untouched margin
     * carries no extra bytes and no backfill was needed to ship this.
     *
     * A denormalized count under the same obligation as `labs.memberCount` and
     * `reactionTallies.count`: every write that files a prior state into
     * `annotationVersions` moves this in the same transaction, and Convex
     * mutations are atomic, so it cannot drift. It is here rather than counted
     * from the version rows because the margin needs it for every note it
     * draws, and counting would be a read per card — the fan-out
     * `listForPaper` refuses everywhere else.
     *
     * It counts *states*, not surviving rows. Past the retention cap the
     * oldest version rows are dropped and this keeps climbing, which is what
     * lets the history panel say "3 of 60 versions are still kept" instead of
     * quietly presenting the tail as the whole story.
     *
     * Cleared when a note is withdrawn, alongside the rows themselves: a
     * tombstone has no history, because withdrawing a note that still offered
     * its previous drafts would not be withdrawing anything.
     */
    versionCount: v.optional(v.number()),
    deletedAt: v.optional(v.number()),
  })
    .index("by_paper", ["paperId"])
    .index("by_paper_and_member", ["paperId", "memberId"])
    .index("by_paper_and_visibility", ["paperId", "visibility"])
    .index("by_member", ["memberId"])
    .index("by_parent", ["parentId"])
    .index("by_session", ["sessionId"])
    .index("by_lab", ["labId"])
    /**
     * Search over what the lab wrote.
     *
     * All three filter fields exist for the same reason: the privacy
     * constitution's rule that a private note is invisible to everyone but its
     * author has to hold *inside the index*, not in a filter applied to its
     * results. `convex/search.ts` runs two separate queries — lab-visible
     * notes, and the caller's own private ones — and there is no combination
     * of `.eq()`s here that would return someone else's private note.
     */
    .searchIndex("search_body", {
      searchField: "body",
      filterFields: ["labId", "visibility", "memberId"],
    }),

  /**
   * What a note used to say — one row per state an annotation has been in and
   * left.
   *
   * ## Why this is not in the ledger
   *
   * It is the obvious place for it, and it is the one place it can never go.
   * `events` is append-only: nothing updates a row and nothing deletes one.
   * A body written there could never afterwards be redacted, withdrawn, or
   * made private again — the author of a note would lose the right to take
   * their own words back the moment they edited them once. The ledger
   * therefore keeps doing what it does (a member edited this note, at this
   * time, replacing this version ordinal) and the prose lives here, in a
   * mutable table whose rows are allowed to die.
   *
   * ## Rows that die with the thing they describe
   *
   * These rows are not independent objects. They are the earlier states of one
   * annotation, and they last exactly as long as it does:
   *
   * - Withdrawing or deleting a note hard-deletes every version of it
   *   (`sweepVersions`). A withdrawn note whose drafts were still readable
   *   would be a withdrawal that withdrew nothing.
   * - **No visibility is stored here.** A version's audience is read from the
   *   parent annotation at read time, every time, so flipping a note to
   *   private hides its history in the same instant and by the same act. A
   *   `visibility` column on this table would be a second copy of the rule,
   *   and a second copy is a copy that can be stale — the one failure mode
   *   this whole table is arranged to make impossible.
   *
   * There is deliberately no `memberId` either. Only a note's author can edit
   * it, so every version of it is theirs by construction, and storing the fact
   * again would invite a future reader to trust the copy instead of the parent.
   *
   * ## Bounded
   *
   * Capped at `MAX_VERSIONS_KEPT` rows per annotation, oldest dropped first
   * (see `convex/annotationVersions.ts`). Refusing the edit instead was the
   * alternative and it is the wrong one: an author must always be able to fix
   * their own sentence, and a product that says "you have revised this too
   * many times" to a person correcting a typo has chosen its bookkeeping over
   * its user. What is owed instead is honesty about the loss, which is what
   * `annotations.versionCount` and the panel's truncation line are for.
   */
  annotationVersions: defineTable({
    annotationId: v.id("annotations"),
    /**
     * Which state this was, counting from 1 — the ordinal the note carried
     * before the edit that replaced it. Never reused and never renumbered, so
     * the gap between 1 and the lowest surviving row is exactly how much
     * history the cap has taken.
     */
    version: v.number(),
    /** What it said. Empty is a real value: a bare highlight is a real note. */
    body: v.string(),
    type: annotationType,
    /** When this state stopped being the current one. */
    replacedAt: v.number(),
  })
    /**
     * Both reads this table has, from one index: on the `annotationId` prefix
     * it is a note's history in order, and full-width it is the exact row the
     * retention cap drops.
     */
    .index("by_annotation_and_version", ["annotationId", "version"]),

  /**
   * What a discussion produced: a decision, an unanswered question, or a task
   * with somebody's name on it.
   *
   * The other half of the ritual. A brief carries what the lab already wrote
   * *into* the meeting; this carries what the meeting decided back out, and an
   * open item travels to the next session about the same paper until somebody
   * settles it. That loop is the point — this week's outcomes are what make
   * next week's page worth opening.
   *
   * ## Authored, not derived
   *
   * Unlike a brief item or a synthesis line, an outcome's `body` is a sentence
   * a member typed, not a rearrangement of notes. That difference decides the
   * redaction rule: withdrawing the cited note redacts the **citation** and
   * leaves the outcome standing, where a brief line loses its text outright.
   * "The lab settled on the 4°C protocol" does not stop being true because the
   * critique that prompted it went private.
   *
   * ## Lab-visible, always
   *
   * There is no `visibility` field and there is not meant to be one. A private
   * decision is not a decision — it is a note, and Margin already has those,
   * with two visibilities and a constitution around them. Everything in this
   * table is the lab's, which is also why `citedAnnotationId` may only ever
   * point at a lab-visible annotation and is re-checked on every read.
   */
  actions: defineTable({
    labId: v.id("labs"),
    /** The meeting that produced it. An outcome always has one. */
    sessionId: v.id("sessions"),
    /**
     * Denormalized from the session, because carrying forward asks "what did
     * earlier meetings *about this paper* leave open" and asking it through
     * the sessions table would be a read per meeting to answer a question one
     * index can.
     */
    paperId: v.id("papers"),
    kind: actionKind,
    /** What the member wrote down. Never empty: an outcome nobody stated is not one. */
    body: v.string(),
    /**
     * The lab-visible note this came out of, if it came out of one.
     *
     * An id, kept, and re-resolved on read — the discipline `synthesis.ts`
     * and `briefs.ts` both apply. A citation is a claim about a row, the
     * margin moves underneath it, and a later un-share has to take the quote
     * back off this page too.
     */
    citedAnnotationId: v.optional(v.id("annotations")),
    recordedBy: v.id("users"),
    /**
     * Tasks only: the member who took it on.
     *
     * Optional because a room often agrees something needs doing before it
     * agrees who is doing it, and a form that refuses to record the first
     * without the second is a form people stop using mid-meeting.
     */
    ownerId: v.optional(v.id("users")),
    /**
     * When somebody declared it carried no further — the question answered,
     * the task done. Absent means open, and open is what travels.
     *
     * Never set on a decision. Recording a decision is the settling of it, and
     * the mutation refuses the transition rather than leaving a field whose
     * meaning depends on the kind beside it.
     */
    settledAt: v.optional(v.number()),
    settledBy: v.optional(v.id("users")),
  })
    .index("by_session", ["sessionId"])
    /** The carry-forward read: one paper's outcomes, newest first. */
    .index("by_paper", ["paperId"])
    .index("by_lab", ["labId"])
    /** "What am I on the hook for?" — asked per member, never across the lab. */
    .index("by_owner", ["ownerId"]),

  /**
   * The Ledger: append-only, never updated, never deleted. Every row is a
   * fact with full provenance (who, what, where, when). Collision detection
   * and "since you were away" deltas both read from here.
   */
  events: defineTable(eventDoc)
    .index("by_lab", ["labId"])
    .index("by_lab_and_at", ["labId", "at"])
    .index("by_paper", ["paperId"])
    .index("by_paper_and_at", ["paperId", "at"])
    .index("by_session", ["sessionId"])
    .index("by_session_and_at", ["sessionId", "at"])
    .index("by_actor", ["actorId"]),

  /**
   * One person's mail: somebody named you, or somebody answered you.
   *
   * The exception to Margin's boundary-delivery rule, and it is narrow on
   * purpose. Digests exist so the product does not page a lab about every
   * write; a notification exists because being *addressed* is not ambient
   * activity — a question written to you and never delivered is just a
   * question nobody answered. Two kinds, both addressed, and no third that
   * quietly grows into an activity feed.
   *
   * ## Why `acknowledgedAt` and not `readAt`
   *
   * The privacy constitution forbids read tracking, and it does not stop being
   * forbidden because the thing being read is a notification. This timestamp
   * moves when a person *acts* — clicks the item, or dismisses the panel — and
   * never because a panel scrolled into view or a query ran. The name says
   * which of the two it is, and `convex/privacy.guard.test.ts` fails the build
   * on the other one.
   *
   * Per-recipient private state, so unlike the ledger these rows are mutable
   * and deletable: a notification pointing at a note that has since been
   * withdrawn or made private is cleared, because the alternative is mail
   * whose only remaining content is that somebody once said something.
   */
  notifications: defineTable({
    recipientId: v.id("users"),
    labId: v.id("labs"),
    kind: notificationKind,
    /** The note that names or answers the recipient. */
    annotationId: v.id("annotations"),
    paperId: v.id("papers"),
    actorId: v.id("users"),
    /** Stamped rather than read off `_creationTime`, so a backfill can be honest about when the fact happened. */
    createdAt: v.number(),
    /** Set by an explicit act of the recipient's. Absent means outstanding. */
    acknowledgedAt: v.optional(v.number()),
  })
    .index("by_recipient_and_lab", ["recipientId", "labId"])
    /**
     * The count in the rail. Reading outstanding items through the index means
     * a member with a decade of acknowledged mail pays for the ones that are
     * still outstanding and nothing else.
     */
    .index("by_recipient_lab_and_ack", ["recipientId", "labId", "acknowledgedAt"])
    /**
     * "Has this person already been told about this note?" — asked before every
     * insert, so re-sharing a note cannot mail the same mention twice, and
     * asked again when a note is withdrawn so its mail can be taken back.
     */
    .index("by_annotation", ["annotationId"])
    .index("by_annotation_and_recipient", ["annotationId", "recipientId"]),

  /** Per-recipient staleness: how far into the ledger a member has caught up, per paper or per session. */
  seenCursors: defineTable({
    userId: v.id("users"),
    labId: v.id("labs"),
    paperId: v.optional(v.id("papers")),
    sessionId: v.optional(v.id("sessions")),
    lastSeenAt: v.number(),
  })
    .index("by_user_and_paper", ["userId", "paperId"])
    .index("by_user_and_session", ["userId", "sessionId"])
    .index("by_user_and_lab", ["userId", "labId"]),

  /**
   * A materialized digest for one member at one boundary, built by the
   * sim-validated `digest_gold5` policy: gold typed-pair collisions become
   * individual passage-addressed lines, everything else coalesces to one line
   * per paper, hard cap 5 items.
   */
  digests: defineTable({
    userId: v.id("users"),
    labId: v.id("labs"),
    sessionId: v.optional(v.id("sessions")),
    boundary: v.union(
      v.literal("session-prep"),
      v.literal("session-start"),
      v.literal("since-away"),
    ),
    generatedAt: v.number(),
    deliveredAt: v.optional(v.number()),
    acknowledgedAt: v.optional(v.number()),
    /**
     * How many items the hard cap cut, so the reader can say "and 4 more"
     * instead of silently pretending five was all there was.
     */
    droppedCount: v.optional(v.number()),
    items: v.array(
      v.object({
        kind: v.union(v.literal("collision"), v.literal("coalesced")),
        paperId: v.id("papers"),
        // The far side of a cross-paper collision — two members on the same
        // claim in two different papers. Absent on every other item, which is
        // what keeps `paperId` meaning what it has always meant: the paper the
        // line is filed under, and the one the recipient has their own
        // annotation in. Only that one is safe to link to or to advance a
        // cursor on; the other is named in the line, not caught up on.
        otherPaperId: v.optional(v.id("papers")),
        annotationIds: v.array(v.id("annotations")),
        // e.g. "hypothesis x critique" — the cell of the type-pair matrix
        // that fired. Absent for coalesced lines.
        pairType: v.optional(v.string()),
        line: v.string(),
      }),
    ),
  })
    .index("by_user", ["userId"])
    .index("by_user_and_lab", ["userId", "labId"])
    .index("by_session", ["sessionId"]),

  /**
   * The presenter's pre-session brief: what the lab has already written about
   * this paper, cut into the four questions a presenter is actually asking.
   *
   * ## Why this is not a `digests` row
   *
   * They look adjacent — both are assembled at the T−2h boundary from the same
   * margin — and they are different objects. A digest is **one person's mail**:
   * keyed `by_user`, capped at five lines, and `listMine` starts at the
   * signed-in user's id, which is what makes "there is no argument that could
   * return somebody else's inbox" true by construction. A brief is **the
   * meeting's agenda**: one per session, sectioned, cited, and reviewable by
   * two named people. Folding it in would have meant making `userId` optional
   * on a table whose privacy guarantee is that the field is the index — and
   * every digest row carrying an empty `sections` array to pay for it.
   *
   * ## One row per session, replaced
   *
   * Re-assembling replaces the row and bumps `generation`, the way `syntheses`
   * does. What does *not* carry over is the approval: `approvedAt` means "a
   * person read this assembly", so a new assembly starts unread. That is the
   * opposite of the synthesis rule — there, the approved copy is prose a human
   * wrote and a model does not get to overwrite it — and the difference is
   * exactly that a brief has no human-authored half. Every generation that was
   * ever signed off stays in the ledger.
   *
   * ## What is not in here
   *
   * No private annotations, ever — a brief is read by the PI as well as the
   * presenter, and the presenter's own private notes are assembled in the
   * browser from their own subscription instead (`lib/brief/prep.ts`). No
   * per-member tallies either: that section is derived on the client from rows
   * already on the page, so no stored shape and no query in this backend can
   * answer "who has annotated".
   */
  briefs: defineTable({
    sessionId: v.id("sessions"),
    labId: v.id("labs"),
    paperId: v.id("papers"),
    /** Which assembly this is for the session, counting from 1. */
    generation: v.number(),
    generatedAt: v.number(),
    /**
     * Who this assembly is credited to: whoever asked for it, or the presenter
     * when the T−2h boundary did. A scheduled job has no name of its own, and
     * `trigger` is what keeps that from reading as a person pressing a button
     * at two in the morning.
     */
    generatedBy: v.id("users"),
    trigger: v.union(v.literal("scheduled"), v.literal("manual")),
    /** When the presenter or PI marked this generation reviewed, if they have. */
    approvedAt: v.optional(v.number()),
    approvedBy: v.optional(v.id("users")),
    sections: v.array(
      v.object({
        key: briefSectionKey,
        heading: v.string(),
        /** Candidates the per-section cap held back, so the panel can say so. */
        droppedCount: v.number(),
        items: v.array(
          v.object({
            text: v.string(),
            /**
             * The annotations this line was built from.
             *
             * Never empty. Every line in a brief is a rearrangement of notes
             * the lab wrote, so a line that cited nothing would be the one
             * thing this feature exists to refuse — and `briefs.getForSession`
             * re-resolves each id on read and redacts a line whose notes have
             * all been withdrawn, the same discipline `synthesis.getForSession`
             * applies. A stored citation is a claim about a row, and a claim is
             * worth re-reading.
             */
            annotationIds: v.array(v.id("annotations")),
            /** The gold matrix cell, on collision lines only. */
            pairType: v.optional(v.string()),
            /**
             * Which earlier session left this open, and when it was held — on
             * carried-over lines only. An epoch number, not a formatted date:
             * a date has a timezone and a reader, and the server has neither.
             */
            fromSessionId: v.optional(v.id("sessions")),
            fromSessionAt: v.optional(v.number()),
          }),
        ),
      }),
    ),
  })
    .index("by_session", ["sessionId"])
    .index("by_lab", ["labId"]),

  /**
   * The post-meeting synthesis: what the lab worked out, assembled from what
   * the lab actually wrote.
   *
   * Stored as structured sections rather than one blob of prose because the
   * constraint that makes it trustworthy is per-item: every item carries the
   * names it is attributed to, so a reader can check any line against the
   * annotation it came from. A model that cannot cite is a model that made it
   * up.
   *
   * One row per session — re-generating replaces it. The generated text is
   * never the last word: the session's own `synthesis` field is where an
   * approved, human-edited version lands.
   */
  syntheses: defineTable({
    sessionId: v.id("sessions"),
    labId: v.id("labs"),
    sections: v.array(
      v.object({
        key: synthesisSectionKey,
        heading: v.string(),
        items: v.array(
          v.object({
            text: v.string(),
            /** Display names of the members whose annotations back this item. */
            attribution: v.array(v.string()),
            /**
             * The annotations this item was drawn from, by id.
             *
             * A name is an attribution; an id is a citation. The model is made
             * to cite the `[A#]` labels it used and they are resolved back to
             * rows here, so a reader can open the annotation behind any line
             * and an item that cited nothing real never reaches this table.
             */
            annotationIds: v.array(v.id("annotations")),
          }),
        ),
      }),
    ),
    /** The exact model id that produced this, for provenance. */
    model: v.string(),
    generatedAt: v.number(),
    generatedBy: v.id("users"),
  })
    .index("by_session", ["sessionId"])
    .index("by_lab", ["labId"]),

  /**
   * One mark by one member on one note — the cheapest thing anyone can say.
   *
   * A row per (annotation, member, kind) rather than a counter on the
   * annotation, for the reason every social feature eventually learns: a count
   * cannot be un-counted by the person who made it, and a member who takes a
   * mark back has to be able to. It also keeps the marks *attributable*, which
   * is what makes them worth anything in a lab — "three people agree" is
   * noise, "Nadia and Tom agree" is a conversation.
   *
   * Reactions carry no visibility of their own. A mark is visible exactly
   * where the note it sits on is visible, and a private note is invisible to
   * everyone but its author — so a reaction on one can only ever be its
   * author's own, and goes private and comes back with it for free.
   *
   * `paperId` is denormalized off the annotation so the reader can fetch a
   * whole paper's marks in one indexed read instead of one per note. It is
   * written once and never changes: an annotation cannot move between papers.
   */
  reactions: defineTable({
    labId: v.id("labs"),
    paperId: v.id("papers"),
    annotationId: v.id("annotations"),
    memberId: v.id("users"),
    kind: reactionKind,
    createdAt: v.number(),
  })
    /**
     * Every mark on the paper, for the hover roster only.
     *
     * Deliberately *not* what the counts are computed from: this table grows
     * with the lab's membership, so any cap on reading it is a cap that a
     * big enough lab walks past — and a count that quietly understates is
     * worse than no count. Counts come from `reactionTallies`. Truncating
     * this read costs *which* names a tooltip lists, never how many there
     * are and never whether the mark is yours.
     */
    .index("by_paper", ["paperId"])
    /**
     * The caller's own marks on one paper, which is what decides whether each
     * chip draws as theirs.
     *
     * `mine` cannot come from the roster read above for the same reason the
     * counts cannot: a member whose rows fell past the cap would see their own
     * marks render unpressed and un-toggle them by tapping. One member's marks
     * on one paper are bounded by kinds x notes, so this read has a ceiling
     * that does not move with the size of the lab.
     */
    .index("by_paper_and_member", ["paperId", "memberId"])
    /**
     * Both the uniqueness check and the by-annotation read, from one index.
     *
     * Full-width it is the toggle's exact lookup — one member, one note, one
     * kind, `.unique()` — and on the `annotationId` prefix alone it is every
     * mark on a note. One reaction per (annotation, member, kind) is enforced
     * here rather than by a schema constraint Convex does not have, which is
     * why the toggle reads before it writes.
     */
    .index("by_annotation_and_member_and_kind", [
      "annotationId",
      "memberId",
      "kind",
    ]),

  /**
   * How many members have put one kind of mark on one note.
   *
   * A denormalized count, in the same spirit — and under the same obligation —
   * as `labs.memberCount`: `annotations.react` moves this in the same
   * transaction as the `reactions` row it inserts or deletes, and Convex
   * mutations are atomic, so it cannot drift.
   *
   * It exists because the honest alternative does not scale. Counting the
   * `reactions` rows at read time means reading a set that grows with the
   * lab's membership, and every bounded read of it is a number that silently
   * understates once a paper gets popular enough — a chip reading "3" when
   * five people agreed, with nothing on screen admitting it. This table is
   * bounded by the *content* instead: at most one row per (note, kind), so a
   * paper's tallies are capped by its notes times the five kinds however many
   * people are in the lab.
   *
   * A row is deleted rather than left at zero, so the reader's "kinds nobody
   * has used are absent rather than present with a zero" stays true of the
   * storage as well as of the view.
   */
  reactionTallies: defineTable({
    paperId: v.id("papers"),
    annotationId: v.id("annotations"),
    kind: reactionKind,
    count: v.number(),
  })
    /** The reader's single read for a whole paper's counts. */
    .index("by_paper", ["paperId"])
    /** The toggle's exact row, to move by one. */
    .index("by_annotation_and_kind", ["annotationId", "kind"]),
});
