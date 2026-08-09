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
  v.object({
    ...eventBase,
    type: v.literal("annotation.created"),
    paperId: v.id("papers"),
    annotationId: v.id("annotations"),
    annotationType,
    visibility: annotationVisibility,
  }),
  v.object({
    ...eventBase,
    type: v.literal("annotation.edited"),
    paperId: v.id("papers"),
    annotationId: v.id("annotations"),
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
    .index("by_recipient", ["recipientId"])
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
});
