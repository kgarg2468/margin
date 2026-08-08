import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { getMembership, requireMembership, requireUserId } from "./lib/authz";
import { recordEvent } from "./lib/ledger";
import { anchor, annotationType, annotationVisibility } from "./schema";

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

/** Guards against an anchor built by something other than `lib/anchoring`. */
const MAX_QUOTE_LENGTH = 400;
const MAX_CONTEXT_LENGTH = 64;

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
  parentId: v.optional(v.id("annotations")),
  createdAt: v.number(),
  editedAt: v.optional(v.number()),
  /** Withdrawn: the body is gone, the thread it holds up is not. */
  deleted: v.boolean(),
  /** Replies by anyone, which is what freezes visibility and blocks deletion. */
  replyCount: v.number(),
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
  if (candidate.quote.trim().length === 0) {
    throw new ConvexError("Select some text to annotate.");
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
  },
  returns: v.id("annotations"),
  handler: async (ctx, args) => {
    const { paper, membership } = await requirePaper(ctx, args.paperId);
    if (args.sessionId !== undefined) {
      await requireSessionFor(ctx, args.sessionId, paper);
    }
    validateAnchor(args.anchor, paper.pageCount);
    const body = cleanBody(args.body);

    const annotationId = await ctx.db.insert("annotations", {
      labId: paper.labId,
      paperId: paper._id,
      sessionId: args.sessionId,
      memberId: membership.userId,
      anchor: args.anchor,
      type: args.type,
      body,
      visibility: args.visibility,
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

    return annotationId;
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
 */
export const listForPaper = query({
  args: { paperId: v.id("papers") },
  returns: v.array(annotationView),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const paper = await ctx.db.get(args.paperId);
    if (paper === null) {
      return [];
    }
    // A stale link renders an empty margin rather than an error, and the answer
    // is the same whether the paper is missing or forbidden.
    if ((await getMembership(ctx, paper.labId, userId)) === null) {
      return [];
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

    // One read per distinct author rather than one per annotation: a session's
    // worth of margins is dozens of notes by a handful of people.
    const authors = new Map<Id<"users">, string>();
    for (const annotation of annotations) {
      if (!authors.has(annotation.memberId)) {
        authors.set(
          annotation.memberId,
          displayName(await ctx.db.get(annotation.memberId)),
        );
      }
    }

    return annotations.map((annotation) => ({
      _id: annotation._id,
      paperId: annotation.paperId,
      sessionId: annotation.sessionId,
      memberId: annotation.memberId,
      authorName: authors.get(annotation.memberId) ?? "A lab member",
      mine: annotation.memberId === userId,
      anchor: annotation.anchor,
      type: annotation.type,
      body: annotation.body,
      visibility: annotation.visibility,
      parentId: annotation.parentId,
      createdAt: annotation._creationTime,
      editedAt: annotation.editedAt,
      deleted: annotation.deletedAt !== undefined,
      replyCount: replyCounts.get(annotation._id) ?? 0,
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
      await ctx.db.delete(annotation._id);
    } else {
      await ctx.db.patch(annotation._id, { body: "", deletedAt: Date.now() });
    }

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
