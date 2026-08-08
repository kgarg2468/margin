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
    .index("by_pdf_storage", ["storageId"]),

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
    synthesis: v.optional(v.string()),
    synthesisApprovedAt: v.optional(v.number()),
    /**
     * When a synthesis run claimed this session, if one currently has it.
     *
     * Generation is an action: it leaves the transaction, spends up to two
     * minutes and several thousand tokens at the Anthropic API, and comes back
     * to overwrite one row. Two people pressing the button — or one person
     * pressing it twice — would pay for that twice and race over the result.
     * The marker is a timestamp rather than a flag because an action that dies
     * mid-flight cannot clear anything, and a lease that never expires is a
     * session that can never be synthesized again.
     */
    synthesisGeneratingAt: v.optional(v.number()),
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
    .index("by_lab_and_status", ["labId", "status"]),

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
    .index("by_lab", ["labId"]),

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
