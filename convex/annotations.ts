import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { recordVersion, sweepVersions } from "./annotationVersions";
import { cascadeForAnnotation } from "./delegations";
import { getMembership, requireMembership, requireUserId } from "./lib/authz";
import { recordEvent } from "./lib/ledger";
import {
  clearNotificationsFor,
  EMAIL_STAGGER_MS,
  raiseNotification,
} from "./notifications";
import {
  anchor,
  annotationType,
  annotationVisibility,
  epistemicStatus,
  reactionKind,
} from "./schema";
import { canApprove } from "./sessions";
import { isStillShared } from "../lib/citations/visibility";
import {
  checkTransition,
  grantsPresenterStanding,
} from "../lib/epistemic/status";
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
 *
 * ## Epistemic status, and the one thing in here that is not the author's
 *
 * Everything above is a member's own writing, and the permission on all of it
 * is authorship (`requireOwn`). A note's *status* — accepted, disputed,
 * resolved, superseded — is the exception, and deliberately so: it is not a
 * claim about the note, it is the lab's claim about the passage, and the author
 * of a critique does not get to record that the lab accepted it. So `setStatus`
 * is gated on the standing to speak for the group (see `mayRuleOnStatus`), it
 * refuses any note the lab cannot see, and every transition is written by a
 * person — nothing in this file infers one from replies, reactions, or types.
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

/** How many kinds of mark there are (see `reactionKind`). */
const REACTION_KIND_COUNT = 5;

/**
 * The most notes `listForPaper` can hand back.
 *
 * Twice the page size, because it reads two pages that are allowed not to
 * overlap: the lab-visible notes, and the caller's own. A margin of 1 000
 * shared notes and 1 000 private ones by the caller is 2 000 rows returned,
 * and anything sized to cover "the notes this query returns" has to be sized
 * to that rather than to one page of it.
 */
const MAX_ANNOTATIONS_RETURNED = 2 * MAX_ANNOTATIONS_PER_PAPER;

/**
 * The ceiling on a paper's tallies, and on one member's own marks.
 *
 * Both sets are bounded by the *content* rather than by the size of the lab:
 * there is at most one tally row per (note, kind), and at most one mark per
 * (note, kind) per member. So this is exactly enough rows for every note the
 * margin can return, whatever the lab's membership does — which is the
 * property the counts rest on and the reason they are read from
 * `reactionTallies` rather than counted from `reactions`.
 */
const MAX_REACTION_ROWS_PER_PAPER =
  REACTION_KIND_COUNT * MAX_ANNOTATIONS_RETURNED;

/**
 * The ceiling on the roster read — the one that says *who*.
 *
 * This one does grow with the lab, and so it is the one read here that can be
 * cut short. That is survivable precisely because nothing depends on it but
 * the names in a tooltip: counts come from the tallies and `mine` comes from
 * the caller's own marks, both exact. Losing rows here costs which names a
 * chip lists, and the sentence it builds ("Nadia, Tom and 12 others") stays
 * true because the 12 is derived from a count this read did not produce.
 */
const MAX_REACTION_ROSTER_ROWS = 8_000;

/** How many marks are cleared per page when a note is deleted outright. */
const REACTION_DELETE_PAGE = 256;

/**
 * And how many of those pages one mutation will do before handing the rest to
 * a scheduled follow-up.
 *
 * The per-note total really is bounded — the uniqueness index allows one row
 * per (member, kind), so a note carries at most five times the lab's member
 * count — and at any real lab that is a few hundred rows in a single pass. But
 * "the bound is small" is an argument, and what is wanted here is a property.
 * A mutation is one transaction: an unbounded drain inside it is a transaction
 * that can grow until the platform refuses it, and a refused transaction rolls
 * back the note's deletion with it. That failure mode is the unacceptable one
 * — the author of a note must always be able to take it back, whatever the
 * lab did to it — so the drain is capped and the remainder is swept
 * afterwards, out of the caller's way.
 */
const MAX_REACTION_DELETE_PAGES = 8;

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

/**
 * How many sessions on one paper are consulted to decide whether the caller has
 * ever presented it.
 *
 * A paper a lab has discussed a hundred times is not a thing, and this is far
 * past the ceiling of any real library. It is a cap rather than a page for the
 * usual reason: the read has to be bounded, and the honest failure of a bound
 * this high is that somebody who presented the 101st meeting about one paper is
 * told to ask the PI.
 */
const MAX_SESSIONS_CONSULTED = 100;

/**
 * Where the lab says this claim stands, as the margin draws it.
 *
 * Composed here rather than handed over as raw columns because two of the
 * fields are answers to questions only the server can ask: who ruled (a name,
 * resolved like every other name in this query) and whether the note named as
 * the replacement is still one the reader may see. A client given a bare
 * `supersededBy` id could render the word and nothing else, which is the one
 * outcome this feature must not produce — a citation the reader cannot check
 * and is not told they cannot check.
 */
const statusView = v.object({
  value: epistemicStatus,
  /** When the lab ruled. The status's effective date, and the card's timestamp. */
  at: v.number(),
  /** Who ruled. A verdict with nobody's name on it is not a verdict. */
  byName: v.string(),
  /** The author of the note that replaces this one, while it is still shared. */
  supersededByName: v.optional(v.string()),
  /**
   * This note names a replacement the reader can no longer see — withdrawn,
   * deleted, or taken private since the ruling. The card says so in those
   * words rather than drawing a bare "Superseded", which would read as a
   * complete fact instead of a withheld one.
   */
  supersededByRedacted: v.boolean(),
});

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
  /**
   * How many states this note has been in, counting the one on screen. Absent
   * means one — the card offers no history control at all — which is what
   * keeps an unedited margin exactly as quiet as it is today.
   *
   * It rides on the note rather than being counted from `annotationVersions`
   * because every card in the rail needs it and counting would be a read per
   * card. See the field's own note in `convex/schema.ts` for why it counts
   * states rather than surviving rows.
   */
  versionCount: v.optional(v.number()),
  /**
   * The lab's ruling on this note, if it has made one. Absent is the ordinary
   * case and the card draws nothing at all for it.
   *
   * Absent also for a note that is private or withdrawn, whatever the row says
   * — a status is a lab-level claim about a lab-visible note, and the audience
   * is decided on the annotation at read time rather than copied anywhere. See
   * `listForPaper`.
   */
  status: v.optional(statusView),
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
 *
 * Takes the send slot to start from and answers the next free one, so a caller
 * that announces several notes in a row — or that follows the mentions with a
 * reply notification — keeps one paced queue instead of restarting the clock
 * and stacking sends back on top of each other.
 */
async function announceMentions(
  ctx: MutationCtx,
  annotation: Doc<"annotations">,
  startSlot = 0,
): Promise<number> {
  if (
    annotation.visibility !== "lab" ||
    annotation.deletedAt !== undefined ||
    annotation.mentions === undefined
  ) {
    return startSlot;
  }

  // Staggered, not fired at once. Every mention here becomes a scheduled
  // action and every action is a POST to Resend, whose limit is ten a second
  // — so a note naming ten people used to arrive as ten simultaneous requests
  // and provoke the very rate limit `sendEmail` then had to wait out. Spacing
  // them by index costs a second and a half on mail nobody reads for minutes.
  let slot = startSlot;
  for (const subjectUserId of annotation.mentions) {
    const raised = await raiseNotification(ctx, {
      recipientId: subjectUserId,
      labId: annotation.labId,
      kind: "mention",
      annotationId: annotation._id,
      paperId: annotation.paperId,
      actorId: annotation.memberId,
      emailDelayMs: slot * EMAIL_STAGGER_MS,
    });
    slot += 1;
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
  return slot;
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
 * Whether the caller may say where a claim stands on this paper: the lab's PI,
 * or anyone who has presented a session about it.
 *
 * Taken from `canApprove` in `convex/sessions.ts` rather than invented, and the
 * argument there transfers exactly. Approving a write-up is narrower than
 * managing a session because the approved copy is *the lab's account of what it
 * worked out*, and an organiser who booked the room has no standing to put
 * words in the presenter's mouth; the two people who do are the one who ran the
 * discussion and the one who answers for the lab. A status is the same object
 * one claim at a time — "we accepted this", "we still dispute this" — so it
 * takes the same two people. `canApprove` is called rather than restated,
 * because a permission with two definitions has one that is out of date.
 *
 * The one adaptation: a status hangs off a *note*, and a note is written on a
 * paper rather than in a session — the reader can be opened either way, so most
 * annotations carry no `sessionId` at all. Reading "presenter" off the note's
 * own session would therefore make the rule PI-only for the whole library,
 * which is a bottleneck exactly where the roadmap wants a habit. So the
 * question asked is "have you ever run this lab's discussion of this paper",
 * which is the standing the rule is actually about.
 *
 * The standing comes from meetings that were *held* — `live`, `ended`,
 * `synthesized` — and never from one that is merely on the calendar. Being
 * assigned to present next Thursday is not having run a discussion, so a member
 * who could rule on this paper's claims the moment the session was booked would
 * be signing the lab's name to their own reading of a paper the lab has not met
 * to argue about. It is also the hole a person could open at will: book a
 * session on any paper, acquire standing over every note in its margin, cancel.
 * `grantsPresenterStanding` is the same hour `canRecord` admits outcomes in
 * (`lib/actions/outcomes.ts`) — during the meeting is exactly when verdicts get
 * recorded, before it is not.
 *
 * What this cannot yet express: a lab whose PI has left, and a lab that would
 * rather every member could rule. Both are settings, and settings are a surface
 * this PR does not have — the narrow rule is the reversible one.
 */
async function mayRuleOnStatus(
  ctx: QueryCtx | MutationCtx,
  paperId: Id<"papers">,
  membership: Doc<"memberships">,
): Promise<boolean> {
  if (membership.role === "pi") {
    return true;
  }
  const sessions = await ctx.db
    .query("sessions")
    .withIndex("by_paper", (q) => q.eq("paperId", paperId))
    .take(MAX_SESSIONS_CONSULTED);
  return sessions.some(
    (session) =>
      grantsPresenterStanding(session.status) && canApprove(session, membership),
  );
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
    // The reply notification takes the slot after the mentions rather than
    // landing on top of them: a reply that also names ten people is eleven
    // sends, and eleven at once is one more than Resend's limit per second.
    const slot = written === null ? 0 : await announceMentions(ctx, written);
    await raiseNotification(ctx, {
      recipientId: parent.memberId,
      labId: parent.labId,
      kind: "reply",
      annotationId,
      paperId: parent.paperId,
      actorId: membership.userId,
      emailDelayMs: slot * EMAIL_STAGGER_MS,
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

    // The count this note carries for this kind, moved by one in the same
    // transaction as the row itself — the `labs.memberCount` contract. Convex
    // mutations are atomic, so the pair cannot come apart; the only way to
    // drift would be a write path that touches one and not the other, and this
    // is the only write path there is.
    const tally = await ctx.db
      .query("reactionTallies")
      .withIndex("by_annotation_and_kind", (q) =>
        q.eq("annotationId", annotation._id).eq("kind", args.kind),
      )
      .unique();

    if (existing !== null) {
      await ctx.db.delete(existing._id);
      if (tally !== null) {
        // Deleted rather than left at zero: an absent row and a zero mean the
        // same thing to every reader, and only one of them accumulates.
        if (tally.count <= 1) {
          await ctx.db.delete(tally._id);
        } else {
          await ctx.db.patch(tally._id, { count: tally.count - 1 });
        }
      }
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
    if (tally === null) {
      await ctx.db.insert("reactionTallies", {
        paperId: annotation.paperId,
        annotationId: annotation._id,
        kind: args.kind,
        count: 1,
      });
    } else {
      await ctx.db.patch(tally._id, { count: tally.count + 1 });
    }
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
    /**
     * Whether the caller may rule on this paper's claims — decided once for the
     * margin rather than re-derived per card, the way `sessions.get` hands the
     * client `canApprove`. It gates which controls are drawn and nothing else:
     * `setStatus` asks the same question again on the way in, because a rule
     * about who may speak for the lab is a rule about the data, not about which
     * buttons rendered.
     */
    canSetStatus: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const paper = await ctx.db.get(args.paperId);
    if (paper === null) {
      return { annotations: [], truncated: false, canSetStatus: false };
    }
    // A stale link renders an empty margin rather than an error, and the answer
    // is the same whether the paper is missing or forbidden.
    const membership = await getMembership(ctx, paper.labId, userId);
    if (membership === null) {
      return { annotations: [], truncated: false, canSetStatus: false };
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

    // The lab's rulings, and the citation each superseded note carries.
    //
    // Two things are decided here rather than stored anywhere:
    //
    // **Who may see a status.** A status is a lab-level claim about a
    // lab-visible note, so it is read off the annotation's own audience on
    // every read — a note that has since gone private or been withdrawn hands
    // back no status at all, in the same instant and by the same act, with no
    // second write to get wrong. The field on the row is left alone: the lab's
    // verdict was not the author's to erase by changing their mind about who
    // may read the sentence, and sharing the note again brings it back.
    //
    // **Whether the supersession still stands up.** `supersededBy` is a
    // citation, and this backend re-checks citations on read rather than
    // trusting what it wrote (`isStillShared`, the same test syntheses and
    // briefs apply to theirs). A replacement that has been withdrawn, deleted,
    // or taken private is reported as redacted rather than dropped, because a
    // bare "Superseded" would read as a complete fact where the truth is that
    // the reader is not being shown the other half of it.
    //
    // Resolved out of the notes this query already returned, at no extra read:
    // `setStatus` refuses a target that is not a lab-visible note on this same
    // paper, so a live target is in `shared` by construction. The one case that
    // resolution cannot tell apart from a withdrawal is a margin over its
    // ceiling, where the target may simply not have been read — and that margin
    // is already saying `truncated`.
    const statuses = new Map<
      Id<"annotations">,
      {
        value: NonNullable<Doc<"annotations">["status"]>;
        at: number;
        byName: string;
        supersededByName?: string;
        supersededByRedacted: boolean;
      }
    >();
    for (const annotation of annotations) {
      if (
        annotation.status === undefined ||
        annotation.visibility !== "lab" ||
        annotation.deletedAt !== undefined
      ) {
        continue;
      }
      let supersededByName: string | undefined;
      let supersededByRedacted = false;
      if (annotation.supersededBy !== undefined) {
        const target = byId.get(annotation.supersededBy) ?? null;
        if (target !== null && isStillShared(target, paper.labId)) {
          supersededByName = await nameOf(target.memberId);
        } else {
          supersededByRedacted = true;
        }
      }
      statuses.set(annotation._id, {
        value: annotation.status,
        // `_creationTime` is not a fallback worth reaching for: a status with
        // no stamp is a row written by something other than `setStatus`, and
        // dating it from the note would put the lab's ruling before the
        // argument that produced it.
        at: annotation.statusSetAt ?? 0,
        byName:
          annotation.statusSetBy === undefined
            ? "A lab member"
            : await nameOf(annotation.statusSetBy),
        ...(supersededByName !== undefined ? { supersededByName } : {}),
        supersededByRedacted,
      });
    }

    // The marks, in three reads that each answer exactly one question.
    //
    // They are split rather than derived from one scan of `reactions` because
    // only one of the three answers can survive being cut short. Counting rows
    // at read time means reading a set that grows with the lab's membership,
    // and a bounded read of it produces a chip reading "3" when five people
    // agreed — a number that is wrong with nothing on screen admitting it.
    // Counts and `mine` therefore come from reads whose size is fixed by the
    // paper's notes rather than by the lab's size, and the only read that can
    // run out is the one whose loss is a shorter list of names.
    //
    // All three are plain capped reads, and what makes that enough is one
    // property a bounded read has for free: **a read that comes back short has
    // returned everything.** Under the ceiling there is nothing left in the
    // table to have missed, so the counts are exact by construction — which is
    // the case every real margin is in, because a tally row exists per (note,
    // kind) and a member's own marks per (note, kind) for one member, so both
    // sets are bounded by the paper's content rather than by the lab's size.
    //
    // A read that comes back *full* is not chased. An earlier version fell
    // back to a read per returned note, which bought exactness in a regime
    // nobody is in by issuing thousands of indexed queries in one transaction
    // — past Convex's scan budget, so the margin would throw rather than
    // render, which is a worse answer than an imperfect one. Reaching these
    // ceilings means the paper holds more marked notes than the query returns
    // at all, and the note list is already truncated and already says so. The
    // honest behaviour there is to serve what the reads produced and disclose
    // it through the flag the rail is already rendering, not to spend the
    // whole transaction pretending the ceiling is not there.
    const tallyRows = await ctx.db
      .query("reactionTallies")
      .withIndex("by_paper", (q) => q.eq("paperId", paper._id))
      .take(MAX_REACTION_ROWS_PER_PAPER);
    const ownMarks = await ctx.db
      .query("reactions")
      .withIndex("by_paper_and_member", (q) =>
        q.eq("paperId", paper._id).eq("memberId", userId),
      )
      .take(MAX_REACTION_ROWS_PER_PAPER);
    const roster = await ctx.db
      .query("reactions")
      .withIndex("by_paper", (q) => q.eq("paperId", paper._id))
      .take(MAX_REACTION_ROSTER_ROWS);

    /**
     * Whether a note's marks belong in the answer at all. The note decides who
     * sees anything attached to it, and a withdrawn one has stopped saying
     * anything — so both are dropped here rather than filtered in the client,
     * which would mean shipping them first.
     */
    function marksVisible(annotationId: Id<"annotations">): boolean {
      const annotation = byId.get(annotationId);
      return annotation !== undefined && annotation.deletedAt === undefined;
    }

    type Tally = { count: number; mine: boolean; others: Id<"users">[] };
    const tallies = new Map<Id<"annotations">, Map<ReactionKind, Tally>>();
    function tallyFor(
      annotationId: Id<"annotations">,
      kind: ReactionKind,
    ): Tally {
      let forNote = tallies.get(annotationId);
      if (forNote === undefined) {
        forNote = new Map();
        tallies.set(annotationId, forNote);
      }
      const existing = forNote.get(kind);
      if (existing !== undefined) {
        return existing;
      }
      const fresh: Tally = { count: 0, mine: false, others: [] };
      forNote.set(kind, fresh);
      return fresh;
    }

    for (const row of tallyRows) {
      if (!marksVisible(row.annotationId)) {
        continue;
      }
      tallyFor(row.annotationId, row.kind).count = row.count;
    }
    for (const mark of ownMarks) {
      if (!marksVisible(mark.annotationId)) {
        continue;
      }
      const tally = tallyFor(mark.annotationId, mark.kind);
      tally.mine = true;
      // The row exists, so the count is at least one. Belt and braces against
      // a tally that somehow fell behind the rows it counts: the margin should
      // never draw a chip that is yours and empty.
      tally.count = Math.max(tally.count, 1);
    }
    for (const mark of roster) {
      // The caller is named by `mine`, not by the roster — the client is what
      // knows how to write "You".
      if (mark.memberId === userId || !marksVisible(mark.annotationId)) {
        continue;
      }
      const tally = tallies.get(mark.annotationId)?.get(mark.kind);
      // No tally means no count, which means nothing to attach a name to.
      if (tally === undefined || tally.others.length >= MAX_REACTION_NAMES) {
        continue;
      }
      tally.others.push(mark.memberId);
      await nameOf(mark.memberId);
    }

    /** The tally for one note, in the order the kinds were first marked. */
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

    // The notes, and the two reads that have to be exact to be worth drawing.
    //
    // A tally or own-mark read that came back full is a margin whose counts
    // may understate and whose chips may draw unpressed, and that is the one
    // thing a count must not do quietly. It cannot be fixed here — see above —
    // so it is disclosed here instead, through the flag that already means
    // "what you are looking at is not all of it". In practice the note reads
    // will have tripped this first: both sets are bounded by the paper's
    // content, so reaching their ceiling takes more marked notes than this
    // query returns at all.
    //
    // The roster read is deliberately absent. Running it short costs which
    // names a tooltip lists, never a count and never `mine`, and claiming
    // "there is more" over an otherwise whole margin would be the query lying
    // in the other direction.
    const truncated =
      shared.length >= MAX_ANNOTATIONS_PER_PAPER ||
      own.length >= MAX_ANNOTATIONS_PER_PAPER ||
      tallyRows.length >= MAX_REACTION_ROWS_PER_PAPER ||
      ownMarks.length >= MAX_REACTION_ROWS_PER_PAPER;

    return {
      truncated,
      canSetStatus: await mayRuleOnStatus(ctx, paper._id, membership),
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
        versionCount: annotation.versionCount,
        status: statuses.get(annotation._id),
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

/**
 * Rewrite a note's body. Author only; the anchor and the type are untouched.
 *
 * The sentence that was there is filed rather than lost (`recordVersion`), and
 * that is the only change of substance here: an edit used to be a destruction
 * and is now an addition. Nothing about who may do it moved — a note's history
 * is written by exactly the person who could already overwrite it.
 *
 * A save that leaves the body identical files nothing. `editedAt` still moves,
 * because the member did press Save and the card has always said so; but a
 * version slot is finite, and spending one on a no-op would eventually push a
 * real earlier draft off the end of a history to record that somebody
 * double-clicked.
 */
export const updateBody = mutation({
  args: { annotationId: v.id("annotations"), body: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { annotation, userId } = await requireOwn(ctx, args.annotationId);
    if (annotation.deletedAt !== undefined) {
      throw new ConvexError("That note was withdrawn.");
    }

    const body = cleanBody(args.body);
    const at = Date.now();
    // Before the patch, and from the document as it stands: this is the state
    // about to be replaced.
    const version =
      body === annotation.body
        ? undefined
        : await recordVersion(ctx, annotation, at);

    await ctx.db.patch(annotation._id, { body, editedAt: at });
    await recordEvent(ctx, {
      labId: annotation.labId,
      type: "annotation.edited",
      actorId: userId,
      paperId: annotation.paperId,
      sessionId: annotation.sessionId,
      annotationId: annotation._id,
      ...(version !== undefined ? { version } : {}),
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
 *
 * It does count as a version, though, and that is not a contradiction.
 * `editedAt` answers "has this prose been rewritten", which is what the card's
 * "· edited" mark means and why retyping still leaves it alone. The history
 * answers a different question — what has this note been — and a note that was
 * filed as a hypothesis in March and a critique in June has been two things.
 * Losing that would lose exactly the transition the epistemic-status work is
 * built to read.
 */
export const setType = mutation({
  args: { annotationId: v.id("annotations"), type: annotationType },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { annotation, userId } = await requireOwn(ctx, args.annotationId);
    if (annotation.deletedAt !== undefined) {
      throw new ConvexError("That note was withdrawn.");
    }
    // The no-op guard that was already here is also what keeps a version slot
    // from being spent on a chip somebody tapped twice.
    if (annotation.type === args.type) {
      return null;
    }

    const version = await recordVersion(ctx, annotation, Date.now());
    await ctx.db.patch(annotation._id, { type: args.type });
    await recordEvent(ctx, {
      labId: annotation.labId,
      type: "annotation.edited",
      actorId: userId,
      paperId: annotation.paperId,
      sessionId: annotation.sessionId,
      annotationId: annotation._id,
      version,
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
      // A machine must not keep working on a question its author has taken
      // back. `userId` rather than the job, because a ledger entry saying a
      // *machine* cancelled the run would be the one reading of "a note was
      // taken back" that leaves the person who took it out of it.
      //
      // `findingsAffected` is ignored on purpose. Locating a finding is not
      // redacting it: read-time whole-item redaction is the defense of record,
      // it re-checks every citation on every read and cannot go stale, and
      // there is nothing for this mutation to write.
      await cascadeForAnnotation(ctx, annotation._id, userId);
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
      // One paced queue across the whole flip, not one per note: sharing a
      // thread releases every note's mentions in the same transaction.
      let slot = 0;
      for (const id of [annotation._id, ...restored]) {
        const row = await ctx.db.get(id);
        if (row !== null) {
          slot = await announceMentions(ctx, row, slot);
        }
      }
    }
    return null;
  },
});

/**
 * Say where a claim stands — accepted, disputed, resolved, superseded — or take
 * the ruling off again.
 *
 * The one mutation in this file that is not the author's. Everything else here
 * is somebody's own writing and is gated on authorship; a status is the lab
 * speaking about a passage, so it is gated on the standing to speak for the lab
 * (`mayRuleOnStatus`) and refuses the author-only path entirely. A member may
 * well rule on their own note — a person conceding their own hypothesis is the
 * best thing that happens in a journal club — but they do it as the presenter
 * or the PI, not as the author.
 *
 * Four refusals, and each is a rule rather than a guard:
 *
 * - **Nothing private.** A status is a claim about a note the lab can see. A
 *   ruling on a note nobody else may read would be the product asserting a
 *   group verdict on a sentence the group has never been shown — and the
 *   ruling would then leak the note's existence the moment anything aggregated
 *   it.
 * - **Nothing withdrawn.** A tombstone says one thing.
 * - **Not on a reply.** A reply is part of the discussion that produces a
 *   verdict; the verdict goes on the claim it is about. This also keeps the
 *   object the margin marks the same object the rail can draw.
 * - **A supersession points at a live, lab-visible note on the same paper.**
 *   Same-paper because the reader is the surface this renders in and a
 *   cross-paper replacement would be a citation nobody can follow from here.
 *   That is a real limit on the memory layer — "this 2019 assay was superseded
 *   by the 2024 paper's" is exactly the cross-paper claim the roadmap wants —
 *   and it wants a surface that can show two papers at once, which does not
 *   exist yet.
 *
 * Nothing here infers anything, and that is the feature. There is no path that
 * writes a status from a count of critiques, a reaction tally, or a model's
 * opinion; every row this mutation writes has a person's id on it. AI-suggested
 * edges, when they come, arrive as proposals that a human accepts *through*
 * this mutation — never as a second writer of it.
 *
 * The ledger takes the fact and the row takes the state, the same split the
 * rest of this backend uses: `annotation.status_set` / `status_cleared` carry a
 * closed vocabulary and two ids and no prose, so the walk between states
 * survives in a table nothing can rewrite, while the current value stays where
 * a reader can be told it has changed.
 */
export const setStatus = mutation({
  args: {
    annotationId: v.id("annotations"),
    /** Absent takes the ruling off, leaving the note unmarked. */
    status: v.optional(epistemicStatus),
    /** The note that replaces this one. Only ever with `superseded`. */
    supersededBy: v.optional(v.id("annotations")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const annotation = await ctx.db.get(args.annotationId);
    if (annotation === null) {
      throw new ConvexError("That note is no longer there.");
    }
    const membership = await requireMembership(ctx, annotation.labId);

    if (annotation.deletedAt !== undefined) {
      throw new ConvexError("That note was withdrawn.");
    }
    if (annotation.visibility !== "lab") {
      throw new ConvexError(
        "That note isn't shared with the lab, so the lab can't say where it stands.",
      );
    }
    if (annotation.parentId !== undefined) {
      throw new ConvexError(
        "A reply is part of the discussion — the status goes on the note it answers.",
      );
    }
    if (!(await mayRuleOnStatus(ctx, annotation.paperId, membership))) {
      throw new ConvexError(
        "Only the lab's PI or someone who has presented this paper can say where a claim stands.",
      );
    }

    // The shape of the move, decided in `lib/epistemic/status.ts` where it can
    // be tested without a database. No transition is forbidden — a lab that
    // accepts a claim in March and disputes it in June is using this correctly
    // — so what comes back is incoherence (a supersession naming nothing, a
    // reference on a word that takes none) or a no-op.
    const check = checkTransition({
      self: annotation._id,
      current: annotation.status ?? null,
      currentSupersededBy: annotation.supersededBy ?? null,
      next: args.status ?? null,
      supersededBy: args.supersededBy ?? null,
    });
    if (!check.ok) {
      throw new ConvexError(check.reason);
    }
    // A ruling that changes nothing writes nothing, the way `setType` refuses
    // to spend a version slot on a chip somebody tapped twice. The ledger
    // answers "when did we last change our mind about this", and a row for a
    // double-click would answer it with the double-click.
    if (!check.changed) {
      return null;
    }

    if (args.supersededBy !== undefined) {
      const target = await ctx.db.get(args.supersededBy);
      // One message for every way the target fails to be visible: which of
      // them applies is exactly what an id-prober would be asking.
      if (target === null || !isStillShared(target, annotation.labId)) {
        throw new ConvexError("That isn't a note the lab can see.");
      }
      if (target.paperId !== annotation.paperId) {
        throw new ConvexError(
          "A note is superseded by another note on the same paper.",
        );
      }
      if (target.parentId !== undefined) {
        throw new ConvexError(
          "A reply can't be the note that supersedes another one.",
        );
      }
      // Two notes each claiming to replace the other is a record that answers
      // "what do we believe now" with a circle. Only the direct case is
      // checked: a longer cycle needs a walk of the chain, and a walk of a
      // chain of unbounded length is the thing every other read in this file is
      // written to avoid.
      if (target.supersededBy === annotation._id) {
        throw new ConvexError(
          "Those two notes would supersede each other. Take the other one's status off first.",
        );
      }
    }

    // `undefined` clears the column in a Convex patch, which is what taking a
    // ruling off means: the note goes back to unmarked rather than to a stored
    // "nobody has ruled", and the stamps go with it — a date and a name with no
    // verdict attached would be provenance for a fact that is not there.
    const at = Date.now();
    await ctx.db.patch(annotation._id, {
      status: args.status,
      supersededBy: args.supersededBy,
      statusSetAt: args.status === undefined ? undefined : at,
      statusSetBy: args.status === undefined ? undefined : userId,
    });

    if (args.status === undefined) {
      await recordEvent(ctx, {
        labId: annotation.labId,
        type: "annotation.status_cleared",
        actorId: userId,
        paperId: annotation.paperId,
        sessionId: annotation.sessionId,
        annotationId: annotation._id,
      });
    } else {
      await recordEvent(ctx, {
        labId: annotation.labId,
        type: "annotation.status_set",
        actorId: userId,
        paperId: annotation.paperId,
        sessionId: annotation.sessionId,
        annotationId: annotation._id,
        status: args.status,
        ...(args.supersededBy !== undefined
          ? { supersededBy: args.supersededBy }
          : {}),
      });
    }
    return null;
  },
});

/**
 * Clear the marks off a note that is going away, up to a bounded amount of
 * work. Returns whether it finished.
 *
 * Marks are not kept for a note that no longer exists: a reaction pointing at
 * an id nothing answers to is not a fact about anything, and it would sit in
 * the table forever, consuming the reader's row budget for that paper, because
 * the only thing that could ever have cleaned it up is this.
 *
 * Bounded per page *and* in total, which is the difference from the first
 * version of this: a page-bounded loop with no ceiling is still an unbounded
 * transaction. When the ceiling is reached this stops and says so, and the
 * caller decides what to do about it — which is never "fail".
 */
async function sweepMarks(
  ctx: MutationCtx,
  annotationId: Id<"annotations">,
): Promise<boolean> {
  for (let page = 0; page < MAX_REACTION_DELETE_PAGES; page += 1) {
    const marks = await ctx.db
      .query("reactions")
      .withIndex("by_annotation_and_member_and_kind", (q) =>
        q.eq("annotationId", annotationId),
      )
      .take(REACTION_DELETE_PAGE);
    for (const mark of marks) {
      await ctx.db.delete(mark._id);
    }
    if (marks.length < REACTION_DELETE_PAGE) {
      // The index came back short, so that was the last of them. The counts go
      // last: while any mark survives they are still describing something, and
      // clearing them first would leave a window where a retry of this saw
      // rows with nothing counting them.
      for (const tally of await ctx.db
        .query("reactionTallies")
        .withIndex("by_annotation_and_kind", (q) =>
          q.eq("annotationId", annotationId),
        )
        .take(REACTION_KIND_COUNT)) {
        await ctx.db.delete(tally._id);
      }
      return true;
    }
  }
  return false;
}

/**
 * The rest of a sweep that did not fit in the mutation that started it.
 *
 * Re-entrant by construction: it does one bounded pass and schedules itself
 * again if there is more, so the work drains in transaction-sized pieces no
 * matter how many marks a note collected. It takes a bare id and asks nothing
 * about the annotation — by the time this runs the row is already gone, which
 * is the point.
 */
export const sweepAnnotationMarks = internalMutation({
  args: { annotationId: v.id("annotations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!(await sweepMarks(ctx, args.annotationId))) {
      await ctx.scheduler.runAfter(
        0,
        internal.annotations.sweepAnnotationMarks,
        args,
      );
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
 *
 * And either way the note's history goes. That is load-bearing on the
 * withdrawn branch in a way it is not on the other: a deleted row's versions
 * are merely garbage, but a *tombstone* that still offered its earlier drafts
 * would be a withdrawal that withdrew nothing — the author would have taken
 * back one sentence and left standing every sentence it was a revision of.
 * Withdrawal has to reach the whole note, not the copy of it that is currently
 * on top.
 */
export const remove = mutation({
  args: { annotationId: v.id("annotations") },
  returns: v.union(v.literal("deleted"), v.literal("withdrawn")),
  handler: async (ctx, args) => {
    const { annotation, userId } = await requireOwn(ctx, args.annotationId);
    if (annotation.deletedAt !== undefined) {
      return "withdrawn";
    }

    // Before either ending, and that ordering is the point: the no-replies
    // branch below hard-deletes the row, and the cascade reads it to place the
    // cancellation in the ledger. Afterwards there would be nothing to read —
    // for rows that predate the denormalized paperId today's enqueue writes;
    // for the rest, the ordering is defense-in-depth rather than the only
    // source.
    // The actor is the author, not the job — a ledger entry saying a *machine*
    // cancelled the run would leave the person who took the note back out of
    // the one record of them doing it.
    //
    // `findingsAffected` is ignored on purpose. Locating a finding is not
    // redacting it: read-time whole-item redaction is the defense of record,
    // it re-checks every citation on every read and cannot go stale, and there
    // is nothing for this mutation to write.
    await cascadeForAnnotation(ctx, annotation._id, userId);

    const replies = await repliesTo(ctx, annotation._id);

    // Attempted inline, where the retention cap guarantees it finishes in one
    // pass, and scheduled otherwise — the same bargain the marks get, for the
    // same reason: the note goes either way. Taking a note back is the one
    // part of this that is the author's by right, and cleanup does not get a
    // veto over it.
    const versionsSwept = await sweepVersions(ctx, annotation._id);

    if (replies.length === 0) {
      // The marks go with the row they were put on — but the note goes either
      // way. Deleting it is the thing the author asked for and the one part of
      // this that is theirs by right; the marks are bookkeeping, and
      // bookkeeping does not get a veto. So the sweep is attempted inline,
      // where it almost always finishes, and anything left over follows on its
      // own schedule after the row is already gone.
      const swept = await sweepMarks(ctx, annotation._id);
      await ctx.db.delete(annotation._id);
      if (!swept) {
        await ctx.scheduler.runAfter(
          0,
          internal.annotations.sweepAnnotationMarks,
          { annotationId: annotation._id },
        );
      }
    } else {
      // A withdrawn note keeps its row, so its marks keep pointing at
      // something real. They are simply never returned again (see
      // `listForPaper`): a tombstone says one thing, and "four people agreed
      // with a sentence you can no longer read" is not it.
      // `versionCount` goes with the rows. A tombstone reading "3 versions"
      // over a history that has been swept would offer a control that opens
      // onto nothing.
      await ctx.db.patch(annotation._id, {
        body: "",
        deletedAt: Date.now(),
        versionCount: undefined,
      });
    }

    if (!versionsSwept) {
      await ctx.scheduler.runAfter(
        0,
        internal.annotationVersions.sweepAnnotationVersions,
        { annotationId: annotation._id },
      );
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
