import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { getMembership, requireMembership, requireUserId } from "./lib/authz";
import { recordEvent } from "./lib/ledger";
import { clearNotificationsFor, raiseNotification } from "./notifications";
import {
  anchor,
  annotationType,
  annotationVisibility,
  reactionKind,
} from "./schema";
import { disambiguate, MAX_MENTIONS_PER_NOTE } from "../lib/mentions";

/**
 * Typed, anchored notes on a passage — the atom of the product.
 *
 * Three rules run through everything here, and they come from the privacy
 * constitution in `.context/architecture-decision.md` rather than from
 * convenience:
 *
 * 1. **A body never enters the ledger.** Every mutation records a fact —
 *    someone annotated this passage, of this type, at this visibility — and
 *    nothing else. The ledger is append-only and drives digests and collision
 *    detection, so a body written into it could never be redacted, edited, or
 *    made private again. Type and visibility are the columns the digest needs;
 *    the prose stays in the mutable `annotations` row where its author can
 *    still reach it.
 *
 * 2. **Private means invisible, not just unlisted.** `listForPaper` reads
 *    lab-visible annotations and the caller's own, and nothing joins those two
 *    sets. There is no query anywhere that returns one member's private notes
 *    to another member, including the PI.
 *
 * 3. **No read tracking.** Opening a paper writes nothing. The only evidence
 *    Margin stores that anyone read anything is an annotation they chose to
 *    write.
 *
 * ## Mentions, and the rule that governs them
 *
 * A note can name a labmate, and naming one tells them. That is the product's
 * only per-write interruption, and rule 2 above is what keeps it honest:
 *
 *   **A mention in a private note notifies nobody.**
 *
 * Not "notifies them quietly", not "notifies them without a link" — nobody. A
 * private note is a note whose existence its author has not disclosed, and a
 * message saying "Sara wrote something about you that you cannot read" would
 * disclose it. The mention is *stored* on the private note, inert, and becomes
 * live at the moment the note is shared with the lab (see `setVisibility`).
 * Un-sharing takes the mail back; the ledger fact that it once happened stays,
 * because the ledger is append-only and that is what append-only means.
 *
 * The ids come from a picker the author used, never from parsing prose. See
 * `lib/mentions/` for why that distinction is doing real work.
 */

/** Long enough for a paragraph of argument; short enough to stay one document. */
const MAX_BODY_LENGTH = 4_000;

/**
 * A margin can hold a lot, but a paper with a thousand annotations on it is a
 * paper that needs a paged rail and a filter that runs in the database, not a
 * bigger `.take()`. Until that exists this is a ceiling rather than a page:
 * the reader shows what it gets and the number is the signal to build the
 * real thing.
 */
const MAX_ANNOTATIONS_PER_PAPER = 1_000;

/**
 * The same kind of ceiling for marks. Five kinds times a lab's worth of
 * members times the notes on one paper stays far under this in every real
 * case; it is here so one indexed read has a bound rather than a hope.
 */
const MAX_REACTIONS_PER_PAPER = 8_000;

/** Enough to clear every mark off a note that is being deleted outright. */
const MAX_REACTIONS_PER_ANNOTATION = 500;

/**
 * How many names a chip's tooltip carries.
 *
 * The count beside a mark is always exact; this bounds only the list of who,
 * because "Nadia, Tom, Wren and 40 others" and "…and 400 others" are the same
 * sentence to a reader and only one of them costs 400 reads.
 */
const MAX_REACTION_NAMES = 8;

/** Guards against an anchor built by something other than `lib/anchoring`. */
const MAX_QUOTE_LENGTH = 400;
const MAX_CONTEXT_LENGTH = 64;

/**
 * Mirrors `MIN_QUOTE_CHARS` in `lib/anchoring/anchor.ts`, counted the same way
 * (whitespace does not count). A quote shorter than this cannot be
 * re-anchored — it occurs everywhere — so `createAnchor` refuses to build one
 * and this refuses to store one built by anything else.
 */
const MIN_QUOTE_CHARS = 4;

const annotationView = v.object({
  _id: v.id("annotations"),
  paperId: v.id("papers"),
  sessionId: v.optional(v.id("sessions")),
  memberId: v.id("users"),
  authorName: v.string(),
  /** True when the caller wrote it — the client gates its own edit controls on this. */
  mine: v.boolean(),
  anchor,
  type: annotationType,
  body: v.string(),
  visibility: annotationVisibility,
  /**
   * The display names this note addresses, so a card can set them in the
   * accent ink without a second round trip.
   *
   * Names rather than ids because that is all the margin does with them, and
   * because the body already contains the same strings — this is a key for
   * finding them in the prose, not new information about anybody.
   */
  mentionNames: v.optional(v.array(v.string())),
  parentId: v.optional(v.id("annotations")),
  createdAt: v.number(),
  editedAt: v.optional(v.number()),
  /** Withdrawn: the body is gone, the thread it holds up is not. */
  deleted: v.boolean(),
  /** Replies by anyone, which is what freezes visibility and blocks deletion. */
  replyCount: v.number(),
  /**
   * The marks on this note, one entry per kind anyone has used. Kinds nobody
   * has used are absent rather than present with a zero — the margin draws
   * what was said, not a scoreboard of what could have been.
   *
   * Empty for a withdrawn note. A tombstone says one thing ("withdrawn by its
   * author") and endorsements of a body that is gone are not a second thing it
   * should be saying.
   */
  reactions: v.array(
    v.object({
      kind: reactionKind,
      /** Exact, however many names came back. */
      count: v.number(),
      /** The caller is one of them — the chip draws itself as theirs. */
      mine: v.boolean(),
      /**
       * Who, for the chip's tooltip, excluding the caller: `mine` already says
       * they are in there and the client is what knows how to write "You".
       * Bounded by `MAX_REACTION_NAMES`; `count` is not.
       */
      names: v.array(v.string()),
    }),
  ),
});

/** Falls back through the fields a member might not have filled in. */
function displayName(user: Doc<"users"> | null): string {
  return user?.name ?? user?.email ?? "A lab member";
}

function cleanBody(body: string): string {
  // Trailing whitespace only: leading indentation can be deliberate in a note
  // that quotes something.
  const trimmed = body.replace(/\s+$/, "");
  if (trimmed.length > MAX_BODY_LENGTH) {
    throw new ConvexError(
      `A note tops out at ${MAX_BODY_LENGTH} characters. This one is ${trimmed.length}.`,
    );
  }
  return trimmed;
}

type Anchor = Doc<"annotations">["anchor"];

type ReactionKind = Doc<"reactions">["kind"];

/**
 * An anchor from the client is a claim like any other.
 *
 * It is never dereferenced server-side — resolving it needs the page text and
 * the anchoring module, both of which live in the browser — so these checks are
 * about shape and size rather than truth: a quote that is empty cannot be
 * re-anchored to anything, and an unbounded one is a way to put a megabyte in a
 * row that is supposed to hold a sentence.
 */
function validateAnchor(candidate: Anchor, pageCount: number | undefined): void {
  if (candidate.quote.replace(/\s/g, "").length < MIN_QUOTE_CHARS) {
    throw new ConvexError(
      "Select a few more characters — a note needs enough of a passage to find its way back to it.",
    );
  }
  if (
    candidate.quote.length > MAX_QUOTE_LENGTH ||
    candidate.prefix.length > MAX_CONTEXT_LENGTH ||
    candidate.suffix.length > MAX_CONTEXT_LENGTH
  ) {
    throw new ConvexError("That selection is too long to anchor.");
  }
  if (
    !Number.isInteger(candidate.start) ||
    !Number.isInteger(candidate.end) ||
    !Number.isInteger(candidate.pageIndex) ||
    candidate.start < 0 ||
    candidate.end <= candidate.start ||
    candidate.pageIndex < 0
  ) {
    throw new ConvexError("That anchor is malformed.");
  }
  if (pageCount !== undefined && candidate.pageIndex >= pageCount) {
    throw new ConvexError("That page isn't in this paper.");
  }
}

/** A paper the caller may touch, and the membership that says so. */
async function requirePaper(
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

/**
 * A session a paper may be annotated under.
 *
 * Both halves matter: a session from another lab would leak the fact that it
 * exists, and a session about another paper would file the annotation into a
 * digest for a meeting nobody is having about it.
 */
async function requireSessionFor(
  ctx: QueryCtx | MutationCtx,
  sessionId: Id<"sessions">,
  paper: Doc<"papers">,
): Promise<void> {
  const session = await ctx.db.get(sessionId);
  if (session === null || session.labId !== paper.labId) {
    throw new ConvexError("That session isn't one of this lab's.");
  }
  if (session.paperId !== paper._id) {
    throw new ConvexError("That session is about a different paper.");
  }
}

/** Replies to an annotation, by anyone. Bounded because it only ever gates a decision. */
async function repliesTo(
  ctx: QueryCtx | MutationCtx,
  annotationId: Id<"annotations">,
): Promise<Doc<"annotations">[]> {
  return await ctx.db
    .query("annotations")
    .withIndex("by_parent", (q) => q.eq("parentId", annotationId))
    .take(MAX_ANNOTATIONS_PER_PAPER);
}

/**
 * Turn the ids a client says were picked into the ids this lab will honour.
 *
 * Every one is a claim, exactly like a `labId` is. The check that matters is
 * membership: without it, a crafted request could name any user in the
 * deployment and have Margin mail them the contents of a lab they have never
 * been in. Non-members are dropped silently rather than refused — the author
 * did nothing wrong if a labmate left between the picker rendering and the
 * save landing, and failing their note would be a strange way to say so.
 *
 * The author's own id survives, because the body shows it and the highlighting
 * should match; it simply never produces a notification (`raiseNotification`
 * refuses to mail somebody about their own writing).
 */
async function resolveMentions(
  ctx: MutationCtx,
  picked: readonly Id<"users">[] | undefined,
  labId: Id<"labs">,
): Promise<Id<"users">[]> {
  if (picked === undefined || picked.length === 0) {
    return [];
  }
  const resolved: Id<"users">[] = [];
  for (const userId of [...new Set(picked)].slice(0, MAX_MENTIONS_PER_NOTE)) {
    if ((await getMembership(ctx, labId, userId)) !== null) {
      resolved.push(userId);
    }
  }
  return resolved;
}

/**
 * Deliver a note's mentions — if, and only if, the lab can see it.
 *
 * The single place the visibility rule is applied, called from every path that
 * could make a mention live: writing a lab-visible note, replying (replies are
 * always lab-visible), and sharing a note that was private. Routing all three
 * through one function is what stops the rule from being three rules that
 * drift.
 *
 * The ledger fact is written only when a notification was genuinely new, which
 * makes the ledger a record of deliveries rather than of intentions. While a
 * note stays shared, re-running this is a no-op — so editing or re-sharing an
 * already-visible note cannot mail anyone twice. Un-sharing does take the
 * recipient's copy back (`clearNotificationsFor`), so a note made private and
 * shared again genuinely notifies again, and says so in the ledger. That is
 * the right way round: the alternative is a note somebody un-shared by mistake
 * that can never reach the person it was written to.
 */
async function announceMentions(
  ctx: MutationCtx,
  annotation: Doc<"annotations">,
): Promise<void> {
  if (
    annotation.visibility !== "lab" ||
    annotation.deletedAt !== undefined ||
    annotation.mentions === undefined
  ) {
    return;
  }

  for (const subjectUserId of annotation.mentions) {
    const raised = await raiseNotification(ctx, {
      recipientId: subjectUserId,
      labId: annotation.labId,
      kind: "mention",
      annotationId: annotation._id,
      paperId: annotation.paperId,
      actorId: annotation.memberId,
    });
    if (!raised) {
      continue;
    }
    await recordEvent(ctx, {
      labId: annotation.labId,
      type: "annotation.mentioned",
      actorId: annotation.memberId,
      paperId: annotation.paperId,
      sessionId: annotation.sessionId,
      annotationId: annotation._id,
      subjectUserId,
    });
  }
}

/** The caller's own annotation, or a refusal. Authorship is the only edit right. */
async function requireOwn(
  ctx: MutationCtx,
  annotationId: Id<"annotations">,
): Promise<{ annotation: Doc<"annotations">; userId: Id<"users"> }> {
  const userId = await requireUserId(ctx);
  const annotation = await ctx.db.get(annotationId);
  if (annotation === null) {
    throw new ConvexError("That note is no longer there.");
  }
  if (annotation.memberId !== userId) {
    throw new ConvexError("Only the person who wrote a note can change it.");
  }
  // Membership can have lapsed since it was written.
  await requireMembership(ctx, annotation.labId);
  return { annotation, userId };
}

/**
 * Write a note in the margin.
 *
 * `body` may be empty: a bare highlight — "this passage matters" — is a real
 * annotation and the cheapest thing a reader can do. `type` defaults to `note`
 * in the UI, because the ontology says typing is one tap and never required.
 *
 * `visibility` arrives explicitly rather than being inferred from `sessionId`.
 * The default the client applies is the constitution's — lab inside a session
 * context, private outside one — but the member is shown it and can flip it
 * before saving, so the server records what they chose.
 */
export const create = mutation({
  args: {
    paperId: v.id("papers"),
    sessionId: v.optional(v.id("sessions")),
    type: annotationType,
    body: v.string(),
    anchor,
    visibility: annotationVisibility,
    /**
     * The labmates the author picked out of the composer's menu, and whose
     * names are still in `body`. The client reconciles those two before
     * sending (`collectMentionedIds`); the server checks they are members and
     * believes nothing else about them.
     */
    mentions: v.optional(v.array(v.id("users"))),
  },
  returns: v.id("annotations"),
  handler: async (ctx, args) => {
    const { paper, membership } = await requirePaper(ctx, args.paperId);
    if (args.sessionId !== undefined) {
      await requireSessionFor(ctx, args.sessionId, paper);
    }
    validateAnchor(args.anchor, paper.pageCount);
    const body = cleanBody(args.body);
    const mentions = await resolveMentions(ctx, args.mentions, paper.labId);

    const annotationId = await ctx.db.insert("annotations", {
      labId: paper.labId,
      paperId: paper._id,
      sessionId: args.sessionId,
      memberId: membership.userId,
      anchor: args.anchor,
      type: args.type,
      body,
      visibility: args.visibility,
      ...(mentions.length > 0 ? { mentions } : {}),
    });

    await recordEvent(ctx, {
      labId: paper.labId,
      type: "annotation.created",
      actorId: membership.userId,
      paperId: paper._id,
      sessionId: args.sessionId,
      annotationId,
      annotationType: args.type,
      visibility: args.visibility,
    });

    // Nothing happens here for a private note, by design: the mentions are on
    // the row, and sharing it later is what makes them live.
    const created = await ctx.db.get(annotationId);
    if (created !== null) {
      await announceMentions(ctx, created);
    }

    return annotationId;
  },
});

/**
 * Answer someone.
 *
 * Replies exist only on lab-visible annotations. A private note is invisible to
 * everyone but its author, so a reply to one could only ever come from the
 * author replying to themselves — which is an edit, not a conversation.
 *
 * Threads are one level deep on purpose. A margin is not a forum: the useful
 * shape is "a passage, and what the lab said about it", and nesting turns that
 * into a tree nobody can align to a line of text.
 *
 * The anchor is inherited rather than re-sent. A reply is about the same
 * passage by definition, and letting the client name a different one would be a
 * way to file a note under a passage its author never read.
 */
export const reply = mutation({
  args: {
    parentId: v.id("annotations"),
    body: v.string(),
    type: v.optional(annotationType),
    mentions: v.optional(v.array(v.id("users"))),
  },
  returns: v.id("annotations"),
  handler: async (ctx, args) => {
    const parent = await ctx.db.get(args.parentId);
    if (parent === null) {
      throw new ConvexError("That note is no longer there.");
    }
    const membership = await requireMembership(ctx, parent.labId);

    if (parent.parentId !== undefined) {
      throw new ConvexError(
        "Replies go on the note itself, not on another reply.",
      );
    }
    if (parent.visibility !== "lab") {
      throw new ConvexError("That note isn't shared with the lab.");
    }
    if (parent.deletedAt !== undefined) {
      throw new ConvexError("That note was withdrawn.");
    }

    const body = cleanBody(args.body);
    if (body.trim().length === 0) {
      throw new ConvexError("A reply needs something in it.");
    }

    const mentions = await resolveMentions(ctx, args.mentions, parent.labId);

    const annotationId = await ctx.db.insert("annotations", {
      labId: parent.labId,
      paperId: parent.paperId,
      sessionId: parent.sessionId,
      memberId: membership.userId,
      anchor: parent.anchor,
      type: args.type ?? "note",
      body,
      visibility: "lab",
      parentId: parent._id,
      ...(mentions.length > 0 ? { mentions } : {}),
    });

    await recordEvent(ctx, {
      labId: parent.labId,
      type: "annotation.replied",
      actorId: membership.userId,
      paperId: parent.paperId,
      sessionId: parent.sessionId,
      annotationId,
      parentId: parent._id,
    });

    // Mentions first, then the answer itself. Both are one interruption per
    // person — `raiseNotification` writes one row per (note, recipient) — so
    // whoever is named *and* answered gets the more specific of the two, which
    // is the mention: it says this reply is addressed to them in particular,
    // where "somebody replied" only says it landed under their note.
    const written = await ctx.db.get(annotationId);
    if (written !== null) {
      await announceMentions(ctx, written);
    }
    await raiseNotification(ctx, {
      recipientId: parent.memberId,
      labId: parent.labId,
      kind: "reply",
      annotationId,
      paperId: parent.paperId,
      actorId: membership.userId,
    });

    return annotationId;
  },
});

/**
 * Put a mark on a note, or take it back off.
 *
 * One mutation rather than a react/unreact pair, because from the member's
 * side it is one control: the chip is either yours or it isn't, and tapping it
 * flips that. The server decides which way by reading first — the row's
 * presence *is* the state — so a double-tap on a slow connection lands as one
 * add and one remove rather than two rows the uniqueness index would have to
 * refuse.
 *
 * Marks go on anything the caller can see, which includes their own private
 * notes. Marking your own note is not vanity when nobody else can read it; it
 * is a reader flagging their own margin — "come back to this", "raise it
 * Thursday" — and the alternative is a rule that exists only to stop something
 * harmless.
 *
 * A withdrawn note takes no new marks and shows none. Removing one is still
 * allowed, so a note withdrawn between the render and the tap un-marks quietly
 * instead of erroring at someone who was trying to take it back anyway.
 */
export const react = mutation({
  args: { annotationId: v.id("annotations"), kind: reactionKind },
  returns: v.union(v.literal("added"), v.literal("removed")),
  handler: async (ctx, args) => {
    const annotation = await ctx.db.get(args.annotationId);
    if (annotation === null) {
      throw new ConvexError("That note is no longer there.");
    }
    const membership = await requireMembership(ctx, annotation.labId);
    // Unreachable through the UI — a private note is not in anyone else's
    // margin to tap — which is exactly why it is checked. Visibility is a rule
    // about the data, not about which buttons got rendered.
    if (
      annotation.visibility !== "lab" &&
      annotation.memberId !== membership.userId
    ) {
      throw new ConvexError("That note isn't shared with the lab.");
    }

    const existing = await ctx.db
      .query("reactions")
      .withIndex("by_annotation_and_member_and_kind", (q) =>
        q
          .eq("annotationId", annotation._id)
          .eq("memberId", membership.userId)
          .eq("kind", args.kind),
      )
      .unique();

    if (existing !== null) {
      await ctx.db.delete(existing._id);
      await recordEvent(ctx, {
        labId: annotation.labId,
        type: "annotation.unreacted",
        actorId: membership.userId,
        paperId: annotation.paperId,
        sessionId: annotation.sessionId,
        annotationId: annotation._id,
        kind: args.kind,
      });
      return "removed";
    }

    if (annotation.deletedAt !== undefined) {
      throw new ConvexError("That note was withdrawn.");
    }

    await ctx.db.insert("reactions", {
      labId: annotation.labId,
      paperId: annotation.paperId,
      annotationId: annotation._id,
      memberId: membership.userId,
      kind: args.kind,
      createdAt: Date.now(),
    });
    await recordEvent(ctx, {
      labId: annotation.labId,
      type: "annotation.reacted",
      actorId: membership.userId,
      paperId: annotation.paperId,
      sessionId: annotation.sessionId,
      annotationId: annotation._id,
      kind: args.kind,
    });
    return "added";
  },
});

/**
 * Everything on a paper the caller is allowed to see: the lab's, plus their own
 * private notes.
 *
 * Two index reads and a merge rather than one scan with a filter. The overlap —
 * the caller's own lab-visible notes, which both reads return — is deduplicated
 * by id.
 *
 * Flat, with `parentId`, rather than nested: the rail has to place a card
 * against a line of the PDF, which means it needs the top-level notes in
 * document order and the replies indexed by parent. Building a tree here would
 * only make the client take it apart again.
 *
 * `truncated` says the ceiling was reached and the margin the reader is looking
 * at is not the whole margin. It is a wrapper object rather than a bare array
 * for exactly that: a query that silently returns 1 000 of 1 400 notes is a
 * query that lies, and the rail says so in one quiet line.
 */
export const listForPaper = query({
  args: { paperId: v.id("papers") },
  returns: v.object({
    annotations: v.array(annotationView),
    /** The cap was hit: there are notes on this paper that are not in here. */
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const paper = await ctx.db.get(args.paperId);
    if (paper === null) {
      return { annotations: [], truncated: false };
    }
    // A stale link renders an empty margin rather than an error, and the answer
    // is the same whether the paper is missing or forbidden.
    if ((await getMembership(ctx, paper.labId, userId)) === null) {
      return { annotations: [], truncated: false };
    }

    const shared = await ctx.db
      .query("annotations")
      .withIndex("by_paper_and_visibility", (q) =>
        q.eq("paperId", paper._id).eq("visibility", "lab"),
      )
      .take(MAX_ANNOTATIONS_PER_PAPER);
    const own = await ctx.db
      .query("annotations")
      .withIndex("by_paper_and_member", (q) =>
        q.eq("paperId", paper._id).eq("memberId", userId),
      )
      .take(MAX_ANNOTATIONS_PER_PAPER);

    const byId = new Map<Id<"annotations">, Doc<"annotations">>();
    for (const annotation of [...shared, ...own]) {
      byId.set(annotation._id, annotation);
    }
    const annotations = [...byId.values()].sort(
      (a, b) => a._creationTime - b._creationTime,
    );

    const replyCounts = new Map<Id<"annotations">, number>();
    for (const annotation of annotations) {
      if (annotation.parentId !== undefined) {
        replyCounts.set(
          annotation.parentId,
          (replyCounts.get(annotation.parentId) ?? 0) + 1,
        );
      }
    }

    // One read per distinct person rather than one per row: a session's worth
    // of margin is dozens of notes and a few hundred marks by a handful of
    // people. Shared by the note authors, the people named in them, and by
    // the reactors below.
    const names = new Map<Id<"users">, string>();
    async function nameOf(id: Id<"users">): Promise<string> {
      const known = names.get(id);
      if (known !== undefined) {
        return known;
      }
      const resolved = displayName(await ctx.db.get(id));
      names.set(id, resolved);
      return resolved;
    }

    const mentionNames = new Map<Id<"annotations">, string[]>();
    for (const annotation of annotations) {
      await nameOf(annotation.memberId);
      if (annotation.mentions === undefined || annotation.mentions.length === 0) {
        continue;
      }
      const resolved: string[] = [];
      for (const userId of annotation.mentions) {
        resolved.push(await nameOf(userId));
      }
      mentionNames.set(annotation._id, resolved);
    }

    // Every mark on the paper in one indexed read, bucketed in memory. The
    // alternative — an index read per note — is the same data at fifty times
    // the round trips, and the margin subscribes to this query live.
    const marks = await ctx.db
      .query("reactions")
      .withIndex("by_paper", (q) => q.eq("paperId", paper._id))
      .take(MAX_REACTIONS_PER_PAPER);

    type Tally = { count: number; mine: boolean; others: Id<"users">[] };
    const tallies = new Map<Id<"annotations">, Map<ReactionKind, Tally>>();
    for (const mark of marks) {
      const annotation = byId.get(mark.annotationId);
      // A mark whose note this caller cannot see, or one that has been
      // withdrawn. The note decides who sees anything attached to it, and in
      // both of those cases it has already said no — so the reaction is
      // dropped here rather than filtered in the client, which would mean
      // shipping it first.
      if (annotation === undefined || annotation.deletedAt !== undefined) {
        continue;
      }
      let forNote = tallies.get(mark.annotationId);
      if (forNote === undefined) {
        forNote = new Map();
        tallies.set(mark.annotationId, forNote);
      }
      const tally = forNote.get(mark.kind) ?? {
        count: 0,
        mine: false,
        others: [],
      };
      tally.count += 1;
      if (mark.memberId === userId) {
        tally.mine = true;
      } else if (tally.others.length < MAX_REACTION_NAMES) {
        tally.others.push(mark.memberId);
      }
      forNote.set(mark.kind, tally);
    }
    for (const forNote of tallies.values()) {
      for (const tally of forNote.values()) {
        for (const id of tally.others) {
          await nameOf(id);
        }
      }
    }

    /** The tally for one note, in the order the marks were first made. */
    function reactionsFor(
      annotationId: Id<"annotations">,
    ): { kind: ReactionKind; count: number; mine: boolean; names: string[] }[] {
      const forNote = tallies.get(annotationId);
      if (forNote === undefined) {
        return [];
      }
      return [...forNote.entries()].map(([kind, tally]) => ({
        kind,
        count: tally.count,
        mine: tally.mine,
        names: tally.others.map((id) => names.get(id) ?? "A lab member"),
      }));
    }

    const truncated =
      shared.length >= MAX_ANNOTATIONS_PER_PAPER ||
      own.length >= MAX_ANNOTATIONS_PER_PAPER;

    return {
      truncated,
      annotations: annotations.map((annotation) => ({
        _id: annotation._id,
        paperId: annotation.paperId,
        sessionId: annotation.sessionId,
        memberId: annotation.memberId,
        authorName: names.get(annotation.memberId) ?? "A lab member",
        mine: annotation.memberId === userId,
        anchor: annotation.anchor,
        type: annotation.type,
        body: annotation.body,
        visibility: annotation.visibility,
        mentionNames: mentionNames.get(annotation._id),
        parentId: annotation.parentId,
        createdAt: annotation._creationTime,
        editedAt: annotation.editedAt,
        deleted: annotation.deletedAt !== undefined,
        replyCount: replyCounts.get(annotation._id) ?? 0,
        reactions: reactionsFor(annotation._id),
      })),
    };
  },
});

/**
 * Who this paper's margin can address: the lab, minus you.
 *
 * Keyed on the paper rather than the lab because that is what the composer
 * has. It is also the safer argument — a `labId` from a reader would be a
 * second claim to check, where the paper's own `labId` is a fact the server
 * already holds.
 *
 * You are left out of your own picker. Mentioning yourself notifies nobody
 * (`raiseNotification` refuses it), so offering the option would be offering
 * a control that does nothing — and a to-do list, which is a different feature
 * that Margin does not have yet.
 *
 * Names are made unique before they leave here. Two people called Sara Chen is
 * an ordinary Tuesday in a large department, and a mention is stored as an id
 * but read as text: if the menu offers the same string twice, the author
 * cannot see which one they picked and the client cannot tell the two tokens
 * apart when it reconciles them against the body.
 *
 * Emails are dropped from the response. `labs.listMembers` shows them because
 * a roster is where you look somebody up; a mention menu only needs a name,
 * and the disambiguating local part is already folded into it where it was
 * actually needed.
 */
export const mentionCandidates = query({
  args: { paperId: v.id("papers") },
  returns: v.array(v.object({ userId: v.id("users"), name: v.string() })),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const paper = await ctx.db.get(args.paperId);
    if (paper === null) {
      return [];
    }
    if ((await getMembership(ctx, paper.labId, userId)) === null) {
      return [];
    }

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_lab", (q) => q.eq("labId", paper.labId))
      .collect();

    const people = [];
    for (const membership of memberships) {
      if (membership.userId === userId) {
        continue;
      }
      const user = await ctx.db.get(membership.userId);
      people.push({
        userId: membership.userId,
        name: displayName(user),
        email: user?.email,
        role: membership.role,
        joinedAt: membership.joinedAt,
      });
    }

    // Same order as the roster — PI first, then longest standing — so the menu
    // is a list somebody can learn the shape of rather than one that reshuffles
    // with every new member.
    people.sort((a, b) => {
      if (a.role !== b.role) {
        return a.role === "pi" ? -1 : 1;
      }
      return a.joinedAt - b.joinedAt;
    });

    return disambiguate(people).map((person) => ({
      userId: person.userId,
      name: person.name,
    }));
  },
});

/** Rewrite a note's body. Author only; the anchor and the type are untouched. */
export const updateBody = mutation({
  args: { annotationId: v.id("annotations"), body: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { annotation, userId } = await requireOwn(ctx, args.annotationId);
    if (annotation.deletedAt !== undefined) {
      throw new ConvexError("That note was withdrawn.");
    }

    await ctx.db.patch(annotation._id, {
      body: cleanBody(args.body),
      editedAt: Date.now(),
    });
    await recordEvent(ctx, {
      labId: annotation.labId,
      type: "annotation.edited",
      actorId: userId,
      paperId: annotation.paperId,
      sessionId: annotation.sessionId,
      annotationId: annotation._id,
    });
    return null;
  },
});

/**
 * Change a note's type. Same right as editing its body: the author's.
 *
 * Retyping is the cheapest correction in the product — a member marks a
 * passage, reads on, and realises the thing they wrote is a critique rather
 * than a note — so it is a separate mutation from `updateBody` and does not
 * count as an edit of the prose.
 */
export const setType = mutation({
  args: { annotationId: v.id("annotations"), type: annotationType },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { annotation, userId } = await requireOwn(ctx, args.annotationId);
    if (annotation.deletedAt !== undefined) {
      throw new ConvexError("That note was withdrawn.");
    }
    if (annotation.type === args.type) {
      return null;
    }

    await ctx.db.patch(annotation._id, { type: args.type });
    await recordEvent(ctx, {
      labId: annotation.labId,
      type: "annotation.edited",
      actorId: userId,
      paperId: annotation.paperId,
      sessionId: annotation.sessionId,
      annotationId: annotation._id,
    });
    return null;
  },
});

/**
 * Share a private note with the lab, or take a shared one back.
 *
 * Sharing is always allowed. Un-sharing is allowed right up until someone else
 * has replied — at that point the note is holding up a conversation that isn't
 * the author's to disappear, and making it private would leave the replies
 * answering nothing. Withdrawing the *body* is still available (`remove`), and
 * that is the honest form of the same wish: the words go, the fact that
 * something was said stays.
 */
export const setVisibility = mutation({
  args: {
    annotationId: v.id("annotations"),
    visibility: annotationVisibility,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { annotation, userId } = await requireOwn(ctx, args.annotationId);
    if (annotation.visibility === args.visibility) {
      return null;
    }
    if (annotation.parentId !== undefined) {
      throw new ConvexError(
        "A reply is part of a lab conversation and can't be made private.",
      );
    }

    /** The author's own replies that come back to the lab alongside the note. */
    const restored: Id<"annotations">[] = [];

    if (args.visibility === "private") {
      const replies = await repliesTo(ctx, annotation._id);
      if (replies.some((r) => r.memberId !== userId)) {
        throw new ConvexError(
          "Someone has replied to this note, so it can't be made private. You can withdraw it instead.",
        );
      }
      // The author's own replies to their own note go private with it, or they
      // would be lab-visible replies to a note nobody else can see.
      for (const own of replies) {
        await ctx.db.patch(own._id, { visibility: "private" });
        await clearNotificationsFor(ctx, own._id);
      }
      // And the mail goes with them. A notification is a pointer, and a
      // pointer into a note the recipient can no longer open says only that
      // somebody once said something about them — which is worse than never
      // having said it. The ledger keeps the fact; the inbox does not.
      await clearNotificationsFor(ctx, annotation._id);
    } else {
      // And come back when it does. Those replies were written to the lab and
      // were only hidden because their parent was; leaving them private would
      // make un-sharing a one-way door that quietly swallowed half a thread.
      // Only the author's own, and only ever as the mirror of the patch above:
      // a reply by anyone else is not this mutation's to touch, and there
      // cannot be one, because the branch above refuses to hide it.
      for (const own of await repliesTo(ctx, annotation._id)) {
        if (own.memberId === userId && own.visibility !== "lab") {
          await ctx.db.patch(own._id, { visibility: "lab" });
          restored.push(own._id);
        }
      }
    }

    await ctx.db.patch(annotation._id, { visibility: args.visibility });
    await recordEvent(ctx, {
      labId: annotation.labId,
      type: "annotation.visibility_changed",
      actorId: userId,
      paperId: annotation.paperId,
      sessionId: annotation.sessionId,
      annotationId: annotation._id,
      visibility: args.visibility,
    });

    // The flip path, and the reason mentions are stored on private notes at
    // all. A member writes a note naming a labmate, thinks about it overnight,
    // and shares it in the morning — this is the morning. Nobody was told
    // while it was private; everybody named is told now, once, whether the
    // note was shared today or after three rounds of second thoughts.
    if (args.visibility === "lab") {
      for (const id of [annotation._id, ...restored]) {
        const row = await ctx.db.get(id);
        if (row !== null) {
          await announceMentions(ctx, row);
        }
      }
    }
    return null;
  },
});

/**
 * Take a note back.
 *
 * Two endings, decided by whether anyone answered it:
 *
 * - **No replies** — the row goes. Nothing was built on it, so leaving a
 *   tombstone in the margin would be clutter with no purpose.
 * - **Replies** — the row stays with its body cleared and `deletedAt` set. The
 *   replies are other people's writing and deleting the parent would orphan
 *   them; the reader draws it as "withdrawn". Redaction rather than deletion is
 *   also the only version of this that is honest about the ledger, which
 *   already records that the note existed and cannot be rewritten.
 *
 * Either way the passage stops being highlighted, because the annotation no
 * longer says anything about it.
 */
export const remove = mutation({
  args: { annotationId: v.id("annotations") },
  returns: v.union(v.literal("deleted"), v.literal("withdrawn")),
  handler: async (ctx, args) => {
    const { annotation, userId } = await requireOwn(ctx, args.annotationId);
    if (annotation.deletedAt !== undefined) {
      return "withdrawn";
    }
    const replies = await repliesTo(ctx, annotation._id);

    if (replies.length === 0) {
      // The marks go with the row they were put on. A reaction pointing at an
      // id nothing answers to is not a fact about anything, and it would sit
      // in the table forever because the only thing that could ever have
      // cleaned it up is this line.
      for (const mark of await ctx.db
        .query("reactions")
        .withIndex("by_annotation_and_member_and_kind", (q) =>
          q.eq("annotationId", annotation._id),
        )
        .take(MAX_REACTIONS_PER_ANNOTATION)) {
        await ctx.db.delete(mark._id);
      }
      await ctx.db.delete(annotation._id);
    } else {
      // A withdrawn note keeps its row, so its marks keep pointing at
      // something real. They are simply never returned again (see
      // `listForPaper`): a tombstone says one thing, and "four people agreed
      // with a sentence you can no longer read" is not it.
      await ctx.db.patch(annotation._id, { body: "", deletedAt: Date.now() });
    }

    // Withdrawing a note withdraws the mail it sent. Either ending leaves
    // nothing for a recipient to open — a deleted row is gone and a tombstone
    // has no body — so an item still sitting in somebody's panel would be a
    // link to an empty room.
    await clearNotificationsFor(ctx, annotation._id);

    await recordEvent(ctx, {
      labId: annotation.labId,
      type: "annotation.deleted",
      actorId: userId,
      paperId: annotation.paperId,
      sessionId: annotation.sessionId,
      annotationId: annotation._id,
    });
    return replies.length === 0 ? "deleted" : "withdrawn";
  },
});
