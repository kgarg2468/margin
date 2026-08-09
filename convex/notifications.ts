import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  internalAction,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { emailIsConfigured, renderEmail, sendEmail } from "./auth";
import { requireUserId } from "./lib/authz";
import { notificationKind } from "./schema";

/**
 * Being addressed.
 *
 * Margin delivers at boundaries and nowhere else — that is the architecture
 * decision, and `convex/digests.ts` is where it lives. This module is the one
 * carve-out, and the shape of the carve-out is the argument for it: a
 * *digest* is about activity, and activity is exactly what a lab does not want
 * pinging it all day. A *notification* is about address. Somebody wrote your
 * name in a margin and asked you something; somebody answered the note you
 * left. Neither is ambient, neither coalesces usefully into "3 things
 * happened", and a question that waits for the next boundary is a question
 * that gets answered after the meeting it was for.
 *
 * So: two kinds, both addressed, and no third.
 *
 * ## The rules this module keeps
 *
 * 1. **A private note notifies nobody.** Nothing here decides that — the
 *    callers in `convex/annotations.ts` only ever raise a notification for a
 *    lab-visible note. What this module guarantees is the other half: a
 *    notification whose note stops being lab-visible is deleted, not left
 *    pointing at something the recipient can no longer open.
 * 2. **One row per (note, person).** Sharing, un-sharing and re-sharing a note
 *    must not mail the same mention three times. The dedupe ignores `kind` on
 *    purpose: a person who is both replied to and named in the same reply is
 *    one interruption, not two.
 * 3. **Nothing here is a read receipt.** `acknowledgedAt` moves when the
 *    recipient clicks something, and there is no query anywhere that reports
 *    one member's acknowledgements to another. `listMine` starts from the
 *    signed-in user's id and takes no user argument, so there is no shape of
 *    call that could return somebody else's mail.
 * 4. **Every read is bounded.** A lab that has been running for three years is
 *    a table that grows forever; nothing in here `.collect()`s it.
 */

/* -------------------------------------------------------------------------
 * Bounds
 * ---------------------------------------------------------------------- */

/** What the panel shows. Past this the answer is "open the paper", not "scroll". */
const MAX_PANEL_ITEMS = 30;

/**
 * Where the count stops counting.
 *
 * A rail badge exists to say "there is something for you", and it says that
 * just as well at `20+` as at `2 471` — while costing a bounded read instead
 * of a scan whose price grows with the lab's whole history.
 */
const COUNT_CAP = 20;

/** How many rows one note's mail can be, for the withdraw path. Far past any real fan-out. */
const MAX_PER_ANNOTATION = 64;

/** Enough of a note to recognise it; not so much that the panel becomes the reader. */
const SNIPPET_LENGTH = 140;

/* -------------------------------------------------------------------------
 * Writing (called from convex/annotations.ts)
 * ---------------------------------------------------------------------- */

/** One line of somebody's mail, as a caller asks for it. */
export type NotificationRequest = {
  recipientId: Id<"users">;
  labId: Id<"labs">;
  kind: Doc<"notifications">["kind"];
  annotationId: Id<"annotations">;
  paperId: Id<"papers">;
  actorId: Id<"users">;
};

/**
 * Tell one person about one note, at most once.
 *
 * Returns whether a row was actually written, which is what lets the caller
 * record the matching ledger fact exactly once: a note shared, un-shared and
 * shared again is one mention of one person, however many times its container
 * was toggled.
 *
 * Refuses to notify the actor about their own writing. That is not a courtesy
 * — a lab where the PI writes "@me check this later" would otherwise mail
 * themselves, and self-address is a to-do list, which Margin does not have.
 *
 * The email is *scheduled*, not sent. A mutation cannot fetch, and inlining a
 * network call into the transaction that writes the annotation would make
 * saving a note as slow and as failable as Resend is. `runAfter(0)` hands it
 * to the scheduler, which runs it after this transaction commits — so mail is
 * never sent for a note that then failed to save.
 */
export async function raiseNotification(
  ctx: MutationCtx,
  request: NotificationRequest,
): Promise<boolean> {
  if (request.recipientId === request.actorId) {
    return false;
  }

  const existing = await ctx.db
    .query("notifications")
    .withIndex("by_annotation_and_recipient", (q) =>
      q
        .eq("annotationId", request.annotationId)
        .eq("recipientId", request.recipientId),
    )
    .first();
  if (existing !== null) {
    return false;
  }

  const notificationId = await ctx.db.insert("notifications", {
    recipientId: request.recipientId,
    labId: request.labId,
    kind: request.kind,
    annotationId: request.annotationId,
    paperId: request.paperId,
    actorId: request.actorId,
    createdAt: Date.now(),
  });

  // A deployment with no mail key is not a deployment that fails to send —
  // it is one where the in-app panel is the whole delivery, and scheduling a
  // job that would only throw is a failed function in the log every time
  // anybody is mentioned.
  if (emailIsConfigured()) {
    await ctx.scheduler.runAfter(0, internal.notifications.deliverEmail, {
      notificationId,
    });
  }
  return true;
}

/**
 * Take back the mail for one note.
 *
 * Called when a note is made private again or withdrawn. A notification is a
 * pointer, and a pointer to something the recipient can no longer open is
 * worse than silence: it says somebody said something about you and refuses to
 * say what. The lab-visible fact that the mention happened stays in the
 * ledger, which is where facts about the lab live; this is one person's inbox,
 * which is not.
 *
 * Bounded rather than exhaustive — the fan-out ceiling is ten people plus a
 * parent author, so 64 is a paranoid margin rather than a page.
 */
export async function clearNotificationsFor(
  ctx: MutationCtx,
  annotationId: Id<"annotations">,
): Promise<void> {
  const rows = await ctx.db
    .query("notifications")
    .withIndex("by_annotation", (q) => q.eq("annotationId", annotationId))
    .take(MAX_PER_ANNOTATION);
  for (const row of rows) {
    await ctx.db.delete(row._id);
  }
}

/* -------------------------------------------------------------------------
 * Reading — the recipient's own, and nobody else's
 * ---------------------------------------------------------------------- */

const notificationView = v.object({
  _id: v.id("notifications"),
  kind: notificationKind,
  paperId: v.id("papers"),
  annotationId: v.id("annotations"),
  /** Who did it. A name, because the panel is prose, not ids. */
  actorName: v.string(),
  paperTitle: v.string(),
  /** The opening of the note, so the panel says what it is about. */
  snippet: v.string(),
  createdAt: v.number(),
  acknowledgedAt: v.optional(v.number()),
});

function displayName(user: Doc<"users"> | null): string {
  return user?.name ?? user?.email ?? "A lab member";
}

/** The first line or so of a note, with the ellipsis only when it earned one. */
function snippetOf(annotation: Doc<"annotations"> | null): string {
  if (annotation === null) {
    return "";
  }
  if (annotation.deletedAt !== undefined) {
    return "Withdrawn by its author.";
  }
  const body = annotation.body.trim();
  if (body.length === 0) {
    // A bare highlight is a real annotation; the passage is what it said.
    return annotation.anchor.quote.slice(0, SNIPPET_LENGTH);
  }
  return body.length > SNIPPET_LENGTH
    ? `${body.slice(0, SNIPPET_LENGTH).trimEnd()}…`
    : body;
}

/**
 * Your mail in one lab, newest first.
 *
 * No `userId` argument, and that is the access control: the query starts from
 * the signed-in identity, so there is no value a caller could pass to read
 * somebody else's. Acknowledged items stay in the list rather than vanishing —
 * the panel is short, and an inbox that erases what you just clicked makes
 * "which paper was that?" unanswerable.
 *
 * Rows whose annotation or paper has gone are dropped from the result rather
 * than rendered as a dead line. They are not deleted here: a query does not
 * write, and the withdraw path already clears them.
 */
export const listMine = query({
  args: { labId: v.id("labs") },
  returns: v.array(notificationView),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);

    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_recipient_and_lab", (q) =>
        q.eq("recipientId", userId).eq("labId", args.labId),
      )
      .order("desc")
      .take(MAX_PANEL_ITEMS);

    // One read per distinct actor and paper rather than one per row: a panel
    // of thirty items is usually three people and four papers.
    const actors = new Map<Id<"users">, string>();
    const papers = new Map<Id<"papers">, string | null>();

    const items = [];
    for (const row of rows) {
      if (!actors.has(row.actorId)) {
        actors.set(row.actorId, displayName(await ctx.db.get(row.actorId)));
      }
      if (!papers.has(row.paperId)) {
        const paper = await ctx.db.get(row.paperId);
        papers.set(row.paperId, paper === null ? null : paper.title);
      }
      const title = papers.get(row.paperId) ?? null;
      if (title === null) {
        continue;
      }

      const annotation = await ctx.db.get(row.annotationId);
      if (annotation === null) {
        continue;
      }

      items.push({
        _id: row._id,
        kind: row.kind,
        paperId: row.paperId,
        annotationId: row.annotationId,
        actorName: actors.get(row.actorId) ?? "A lab member",
        paperTitle: title,
        snippet: snippetOf(annotation),
        createdAt: row.createdAt,
        acknowledgedAt: row.acknowledgedAt,
      });
    }
    return items;
  },
});

/**
 * How many are outstanding, for the quiet mark in the rail.
 *
 * Capped, and says so: `capped` is what lets the rail render "20+" instead of
 * either lying with a round number or paying for a count that grows with the
 * lab's whole history.
 */
export const outstandingCount = query({
  args: { labId: v.id("labs") },
  returns: v.object({ count: v.number(), capped: v.boolean() }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_recipient_lab_and_ack", (q) =>
        q
          .eq("recipientId", userId)
          .eq("labId", args.labId)
          .eq("acknowledgedAt", undefined),
      )
      .take(COUNT_CAP + 1);
    return {
      count: Math.min(rows.length, COUNT_CAP),
      capped: rows.length > COUNT_CAP,
    };
  },
});

/* -------------------------------------------------------------------------
 * Acknowledging — an act, never a side effect of looking
 * ---------------------------------------------------------------------- */

/**
 * Mark one item done, because the recipient did something about it.
 *
 * Called from the click that opens the paper, and from the dismiss control —
 * both of which are a person deciding. Nothing in the client calls this on
 * mount, on scroll, or on the panel opening, and that restraint is the whole
 * reason the field is called `acknowledgedAt`.
 *
 * Idempotent, and the timestamp does not move on a second call: the first
 * acknowledgement is the true one.
 */
export const acknowledge = mutation({
  args: { notificationId: v.id("notifications") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const row = await ctx.db.get(args.notificationId);
    if (row === null) {
      return null;
    }
    if (row.recipientId !== userId) {
      throw new ConvexError("That isn't yours.");
    }
    if (row.acknowledgedAt === undefined) {
      await ctx.db.patch(row._id, { acknowledgedAt: Date.now() });
    }
    return null;
  },
});

/** "I've seen these" — the same act, taken over everything outstanding at once. */
export const acknowledgeAll = mutation({
  args: { labId: v.id("labs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const now = Date.now();
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_recipient_lab_and_ack", (q) =>
        q
          .eq("recipientId", userId)
          .eq("labId", args.labId)
          .eq("acknowledgedAt", undefined),
      )
      .take(COUNT_CAP + 1);
    for (const row of rows) {
      await ctx.db.patch(row._id, { acknowledgedAt: now });
    }
    return null;
  },
});

/* -------------------------------------------------------------------------
 * Email
 * ---------------------------------------------------------------------- */

const emailPayloadShape = v.object({
  to: v.string(),
  kind: notificationKind,
  actorName: v.string(),
  paperTitle: v.string(),
  paperId: v.id("papers"),
  snippet: v.string(),
});

/**
 * Everything one message needs, re-read at the moment of sending.
 *
 * Re-read rather than carried on the scheduled job's arguments, because the
 * gap between "mutation committed" and "action ran" is a real interval and
 * things happen in it. A note withdrawn, made private again, or deleted in
 * that window must not still go out as mail — and mail is the one delivery
 * Margin cannot take back. So the checks that decide whether to send are made
 * here, against the world as it stands, and returning `null` is the ordinary
 * outcome rather than an error.
 */
export const emailPayload = internalQuery({
  args: { notificationId: v.id("notifications") },
  returns: v.union(v.null(), emailPayloadShape),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.notificationId);
    if (row === null || row.acknowledgedAt !== undefined) {
      return null;
    }

    const annotation = await ctx.db.get(row.annotationId);
    // The privacy rule, restated at the last possible moment: only a
    // lab-visible, un-withdrawn note is worth anybody's inbox.
    if (
      annotation === null ||
      annotation.visibility !== "lab" ||
      annotation.deletedAt !== undefined
    ) {
      return null;
    }

    // Membership can have lapsed between the mention and the send. Somebody
    // who has left the lab does not get its mail.
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_lab_and_user", (q) =>
        q.eq("labId", row.labId).eq("userId", row.recipientId),
      )
      .unique();
    if (membership === null) {
      return null;
    }

    const recipient = await ctx.db.get(row.recipientId);
    const to = recipient?.email;
    if (to === undefined || to.length === 0) {
      return null;
    }

    const paper = await ctx.db.get(row.paperId);
    if (paper === null) {
      return null;
    }

    return {
      to,
      kind: row.kind,
      actorName: displayName(await ctx.db.get(row.actorId)),
      paperTitle: paper.title,
      paperId: paper._id,
      snippet: snippetOf(annotation),
    };
  },
});

/**
 * One notification, as one plain email.
 *
 * On-brand through `renderEmail`, which means: a sheet of paper with a rule
 * down the left, one thing to click, no images and no tracking pixel. The last
 * of those is not an oversight to be corrected later — a product that promises
 * never to track what you read cannot ship an open-tracking beacon, and the
 * absence is the feature.
 *
 * One message per notification. No batching, no digest of notifications: the
 * fan-out is capped at ten people per note, the dedupe means a note mails a
 * person once ever, and a lab that generates enough of these to want batching
 * has a different problem than an email problem.
 *
 * Failures are logged, not thrown. A scheduled action that throws is retried
 * and re-logged, and there is nothing a second attempt at a rejected address
 * would do differently; the in-app notification is already delivered and is
 * the channel of record.
 */
export const deliverEmail = internalAction({
  args: { notificationId: v.id("notifications") },
  returns: v.null(),
  // Spelled out rather than inferred: this action calls a query declared in
  // its own module, and an inferred return type makes that a cycle TypeScript
  // resolves by widening the whole generated `api` to `any` — see the same
  // note in `convex/invites.ts`.
  handler: async (ctx, args): Promise<null> => {
    if (!emailIsConfigured()) {
      return null;
    }

    const payload = await ctx.runQuery(internal.notifications.emailPayload, {
      notificationId: args.notificationId,
    });
    if (payload === null) {
      return null;
    }

    const siteUrl = (process.env.SITE_URL ?? "").replace(/\/$/, "");
    const url = `${siteUrl}/app/library/${payload.paperId}/read`;

    const subject =
      payload.kind === "mention"
        ? `${payload.actorName} mentioned you on “${payload.paperTitle}”`
        : `${payload.actorName} replied to your note on “${payload.paperTitle}”`;
    const opening =
      payload.kind === "mention"
        ? `${payload.actorName} mentioned you in the margin of “${payload.paperTitle}”.`
        : `${payload.actorName} answered your note in the margin of “${payload.paperTitle}”.`;

    try {
      await sendEmail({
        to: payload.to,
        subject,
        text: [
          opening,
          "",
          payload.snippet,
          "",
          "Open the margin:",
          url,
          "",
          "Margin",
        ].join("\n"),
        html: renderEmail({
          heading: opening,
          paragraphs: [payload.snippet],
          action: { label: "Open the margin", url },
          footnotes: [
            "You're getting this because you're in this lab and this note was addressed to you.",
          ],
        }),
      });
    } catch (caught) {
      // The in-app notification is already written and is the delivery of
      // record; mail is the courtesy copy. Losing it is not worth a retry
      // storm against an address that is not going to become valid.
      console.error(
        `Could not mail notification ${args.notificationId}: ${String(caught)}`,
      );
    }
    return null;
  },
});
