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
import { emailIsConfigured, renderEmail, sendEmail, siteUrl } from "./auth";
import { getMembership, requireUserId } from "./lib/authz";
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
  /**
   * How long to hold this one message before its send is attempted.
   *
   * A fan-out's caller knows something this function cannot: how many other
   * sends it is about to schedule in the same breath. See `EMAIL_STAGGER_MS`.
   */
  emailDelayMs?: number;
};

/**
 * The gap between one note's outgoing messages.
 *
 * A mutation that mentions ten people schedules ten actions, and `runAfter(0)`
 * means the scheduler starts all of them at once. Each is a POST to Resend,
 * which rate-limits at ten requests a second per team — so a note naming ten
 * people plus a reply to its author is eleven requests in one instant, and the
 * eleventh is a `429` every time. `sendEmail` now waits that out and re-asks,
 * but a retry is the apology, not the fix: the fix is not to provoke it.
 *
 * 150 ms puts a full fan-out at under seven requests a second and finishes the
 * whole thing in a second and a half — which is nothing at all against mail
 * that is read minutes later, and is the same bargain `SEND_BURST_PAUSE_MS`
 * strikes for invitations.
 */
export const EMAIL_STAGGER_MS = 150;

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
 * saving a note as slow and as failable as Resend is. `runAfter` hands it to
 * the scheduler, which runs it after this transaction commits — so mail is
 * never sent for a note that then failed to save.
 *
 * `emailDelayMs` is how a fan-out paces itself: the caller staggers what it
 * schedules so a note naming ten people does not become ten simultaneous POSTs
 * to a ten-per-second rate limit.
 */
export async function raiseNotification(
  ctx: MutationCtx,
  request: NotificationRequest,
): Promise<boolean> {
  if (request.recipientId === request.actorId) {
    return false;
  }

  // Membership is re-checked *here*, at the moment of delivery, and not only
  // where the mention was picked.
  //
  // The two moments can be far apart. A mention is chosen and validated when a
  // note is written, but a note written privately delivers whenever its author
  // shares it — a day, a week, a resignation later. `mentions` is a list of
  // ids frozen at composition time, so trusting it at delivery time would post
  // a lab's margin to somebody who has since left it. Same for a reply landing
  // under a note whose author is no longer in the lab.
  //
  // Silent rather than an error: the author did nothing wrong, and failing
  // their share because a labmate left last week would be a strange way to say
  // so. They simply are not told.
  const membership = await getMembership(
    ctx,
    request.labId,
    request.recipientId,
  );
  if (membership === null) {
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
    await ctx.scheduler.runAfter(
      Math.max(request.emailDelayMs ?? 0, 0),
      internal.notifications.deliverEmail,
      { notificationId },
    );
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
 * No `userId` argument, and that is half the access control: the query starts
 * from the signed-in identity, so there is no value a caller could pass to
 * read somebody else's. Acknowledged items stay in the list rather than
 * vanishing — the panel is short, and an inbox that erases what you just
 * clicked makes "which paper was that?" unanswerable.
 *
 * The other half is the membership check, and it is not redundant with the one
 * on the write. A notification row outlives the membership that justified it:
 * it carries an annotation's snippet, a paper's title and a labmate's name,
 * and none of those stay readable to somebody who has left the lab. Being
 * mailed something once is not a standing licence to keep reading it. So the
 * gate is on both ends — the write refuses to address a former member, and the
 * read refuses to serve one whatever is already on the table.
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
    // Empty rather than an error, and the same answer whether the lab is gone
    // or merely no longer yours — a rail that renders nothing is the correct
    // reading of "you are not in this lab", and an error here would only tell
    // a prober which of the two it was.
    if ((await getMembership(ctx, args.labId, userId)) === null) {
      return [];
    }

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
 *
 * Gated on membership like `listMine`. A bare number discloses less than a
 * snippet does, but "you have four things waiting in the lab you left" is
 * still a fact about that lab, and there is no reason for the two reads to
 * disagree about who may ask.
 */
export const outstandingCount = query({
  args: { labId: v.id("labs") },
  returns: v.object({ count: v.number(), capped: v.boolean() }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    if ((await getMembership(ctx, args.labId, userId)) === null) {
      return { count: 0, capped: false };
    }
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

/**
 * "I've seen these" — the same act, taken over everything outstanding at once.
 *
 * Drained in pages rather than in one `take`. The count in the rail stops at
 * `COUNT_CAP` because a badge does not need to be exact, but this is not a
 * badge: a button that says "I'm caught up" and leaves twenty-one items behind
 * is a button that lies, and the member is left clicking it until it stops
 * doing anything. So it pages until the index has nothing left.
 *
 * Terminating, because each page is patched out of the range it was read from
 * — `by_recipient_lab_and_ack` is keyed on `acknowledgedAt`, so an
 * acknowledged row leaves the `undefined` bucket and cannot be read twice. The
 * loop is bounded anyway at `MAX_PAGES × PAGE`, which is a ceiling on what one
 * transaction should be rewriting rather than on what a person may have
 * waiting: past it the remainder stays outstanding and a second press finishes
 * the job, which is the safe way to run out of room.
 *
 * The natural bound is small in any case. A notification is written once per
 * (note, person), the mention fan-out is capped at ten people per note, and
 * this is scoped to one lab — so the outstanding set is the notes addressed to
 * one member since they last pressed this, not the lab's whole history.
 */
const ACK_PAGE = 256;
const ACK_MAX_PAGES = 16;

export const acknowledgeAll = mutation({
  args: { labId: v.id("labs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const now = Date.now();

    for (let page = 0; page < ACK_MAX_PAGES; page++) {
      const rows = await ctx.db
        .query("notifications")
        .withIndex("by_recipient_lab_and_ack", (q) =>
          q
            .eq("recipientId", userId)
            .eq("labId", args.labId)
            .eq("acknowledgedAt", undefined),
        )
        .take(ACK_PAGE);
      if (rows.length === 0) {
        return null;
      }
      for (const row of rows) {
        await ctx.db.patch(row._id, { acknowledgedAt: now });
      }
      if (rows.length < ACK_PAGE) {
        return null;
      }
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
 * The message itself, as text and as HTML, from nothing but its facts.
 *
 * Pure and exported so the copy can be read back in a test — the wording of
 * what lands in a labmate's inbox is product surface, and it is the one
 * surface nobody on the team sees again after they write it. Both parts say
 * the same sentence in the same order: a mail client that shows the plain part
 * is not being shown a worse email, just an unstyled one.
 *
 * Two kinds and two openings. "Mentioned you" and "replied to your note" are
 * different pieces of news — the first says this was addressed to you in
 * particular, the second that something landed under something of yours — and
 * collapsing them into one line would lose the only thing the subject is for.
 */
export function composeNotificationEmail(message: {
  kind: Doc<"notifications">["kind"];
  actorName: string;
  paperTitle: string;
  snippet: string;
  url: string;
}): { subject: string; text: string; html: string } {
  const subject =
    message.kind === "mention"
      ? `${message.actorName} mentioned you on “${message.paperTitle}”`
      : `${message.actorName} replied to your note on “${message.paperTitle}”`;
  const opening =
    message.kind === "mention"
      ? `${message.actorName} mentioned you in the margin of “${message.paperTitle}”.`
      : `${message.actorName} answered your note in the margin of “${message.paperTitle}”.`;
  const because =
    "You're getting this because you're in this lab and this note was addressed to you.";

  return {
    subject,
    text: [
      opening,
      "",
      message.snippet,
      "",
      "Open the margin:",
      message.url,
      "",
      because,
      "",
      "Margin",
    ].join("\n"),
    html: renderEmail({
      heading: opening,
      paragraphs: [message.snippet],
      action: { label: "Open the margin", url: message.url },
      footnotes: [because],
    }),
  };
}

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
 * Failures are logged, not thrown. `sendEmail` has already waited out and
 * re-asked anything worth re-asking — a rate limit, a bad minute at Resend —
 * so what reaches here is a rejected address or a misconfigured key, and there
 * is nothing a second attempt at either would do differently. The in-app
 * notification is already delivered and is the channel of record.
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

    // A deployment that can send mail but does not know its own origin would
    // send a real message with `href="/app/library/…"` in it — a relative URL,
    // which resolves to nothing at all in a mail client. Better to stay in the
    // app, where the notification already is, and say why in the log.
    const site = siteUrl();
    if (site === null) {
      console.error(
        "SITE_URL is not set on this deployment, so notification mail would carry a link to nowhere. Nothing was sent; the in-app notification stands.",
      );
      return null;
    }

    const payload = await ctx.runQuery(internal.notifications.emailPayload, {
      notificationId: args.notificationId,
    });
    if (payload === null) {
      return null;
    }

    const message = composeNotificationEmail({
      kind: payload.kind,
      actorName: payload.actorName,
      paperTitle: payload.paperTitle,
      snippet: payload.snippet,
      url: `${site}/app/library/${payload.paperId}/read`,
    });

    try {
      await sendEmail({ to: payload.to, ...message });
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
