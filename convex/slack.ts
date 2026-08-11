import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type QueryCtx,
} from "./_generated/server";
import { pause, retryAfterMs, siteUrl } from "./auth";
import { redactWithdrawn } from "./briefs";
import { getMembership, requirePi, requireUserId } from "./lib/authz";
import { recordEvent } from "./lib/ledger";
import { normalizeWebhookUrl, slackIsConfigured } from "./lib/slack";
import { WITHDRAWN_ITEM_TEXT } from "./synthesis";
import { isStillShared } from "../lib/citations/visibility";
import {
  collisionLine,
  detectCollisions,
  MAX_DIGEST_ITEMS,
  type DigestAnnotation,
} from "../lib/digest/engine";
import {
  composeBoundaryMessage,
  composeBriefMessage,
  composeSynthesisMessage,
  slackDate,
  type SlackMessage,
} from "../lib/slack/compose";

/**
 * Slack delivery: the lab's artifacts, in the room the lab already lives in.
 *
 * Margin's three artifacts — the presenter's brief, the pre-session boundary
 * post, the approved write-up — are what a journal club produces. In the app
 * they are the record. In a channel they are the *distribution*: the thing the
 * postdoc who missed Thursday actually reads, and the thing that makes a lab's
 * reading visible to a lab rather than to whoever opened the tab.
 *
 * ## A webhook, not an app
 *
 * There is no OAuth here, no bot user, no slash command and no DM. A PI pastes
 * one incoming-webhook URL into lab settings and the lab is wired. That is a
 * deliberate ceiling, not a first version: a Slack *app* needs a workspace
 * admin's approval, which for a university lab means a ticket to central IT and
 * a quarter of waiting, and the whole product thesis is that a PI can get their
 * lab running on a Sunday night. One pasted string clears that.
 *
 * It also keeps the blast radius small in both directions. Margin can post into
 * exactly one channel and can do nothing else in the workspace — it cannot read
 * a message, list a member, or open a DM, because a webhook grants none of
 * those. And the only thing Margin stores is the one string.
 *
 * ## Three artifacts, and when each one goes
 *
 * Two of the three are posted because a *person published them*, and one at a
 * boundary the whole lab shares:
 *
 *   - **The brief**, when the presenter or PI marks it reviewed. Not when it is
 *     assembled — `briefs.getForSession` deliberately answers `null` to
 *     everyone but those two people, because a brief is somebody's prep and the
 *     organiser who booked the room has no business reading it. Posting an
 *     unapproved assembly into a channel would walk straight through that rule.
 *     Approval is the presenter saying "this is the meeting's agenda", which is
 *     exactly the act that makes it the lab's to read.
 *   - **The boundary post**, two hours before a meeting, off the same job that
 *     builds the prep digests — and it is emphatically *not* one of those
 *     digests. See `boundaryPayload`.
 *   - **The approved write-up**, when somebody approves it, including a
 *     revision. A revision is news: the lab's record of a meeting changed, and
 *     the channel that holds the old one should hold the correction.
 *
 * Everything else Margin can deliver stays where it is. Mentions and replies
 * are addressed to one person and go to that person's inbox and their email;
 * a per-member digest is per-member mail. Neither belongs in a shared channel,
 * and there is no per-user Slack path here to put them in one.
 *
 * ## The constitution still applies
 *
 * No tracking, no third-party assets, nothing that sells anything —
 * `convex/email.guard.test.ts` says why for mail, and a channel post is the
 * same kind of object: handed to a third party, unrecallable. `siteUrl()` is
 * the only base for a link, and a deployment that does not know its own origin
 * posts nothing at all, because a post whose one link goes nowhere is worse
 * than the in-app artifact that is already sitting there.
 */

/* -------------------------------------------------------------------------
 * The transport
 * ---------------------------------------------------------------------- */

/**
 * How many times one message will ask Slack again before giving up.
 *
 * The same three `sendEmail` uses, for the same reason: it covers a burst that
 * outran a rate limit without turning a broken destination into an action that
 * sits there retrying.
 */
const POST_ATTEMPTS = 3;

/**
 * Slack declining to take a message.
 *
 * Carries the HTTP status separately from the message, because the two have
 * different audiences: the message goes to the deployment log and is for
 * whoever is debugging, while the status is the only part fit to show a lab —
 * it is the difference between "Slack was busy" and "that channel is gone".
 * `null` means the request never got an answer at all.
 *
 * The response body is deliberately in the message and not in a field, so that
 * nothing can idly forward it to a client: Slack's bodies are short and
 * secret-free today, but that is a property of Slack's choices, not ours.
 */
export class SlackRefusal extends Error {
  readonly status: number | null;

  constructor(why: string, status: number | null) {
    super(`Slack refused a message: ${why}`);
    this.name = "SlackRefusal";
    this.status = status;
  }
}

/**
 * The status codes that mean *this webhook will not work again*, as opposed to
 * *not just now*.
 *
 * Slack answers a webhook whose channel was archived, or whose app was removed
 * from the workspace, with a `404` and `no_service`; a revoked one with `403`.
 * Those are facts about the lab's configuration and the lab is the only one who
 * can fix them, which is what earns them a place on a settings page. A `5xx`, a
 * `429` that outlasted the retries, and a request that never got an answer are
 * all facts about a Tuesday, and telling a lab their channel might be gone
 * because Slack had a bad minute would be a worse lie than saying nothing.
 *
 * `null` for everything that does not qualify — including a failure that is not
 * a `SlackRefusal` at all, which would be a bug in this module rather than
 * anything the lab did.
 */
export function permanentStatus(caught: unknown): number | null {
  if (!(caught instanceof SlackRefusal)) return null;
  const { status } = caught;
  if (status === null || status === 429) return null;
  return status >= 400 && status < 500 ? status : null;
}

/**
 * Hand one message to a Slack incoming webhook.
 *
 * Shaped after `sendEmail` in `convex/auth.ts` — bounded attempts, `retry-after`
 * believed rather than guessed at, the response body kept out of anything the
 * browser can see — and it diverges from it in exactly one place, on purpose.
 *
 * ## Why only a 429 is re-asked
 *
 * `sendEmail` retries `5xx` and network failures as well, and it is right to:
 * it sends an `Idempotency-Key`, so Resend replays the first outcome and a
 * re-ask can only ever *be* a re-ask. An incoming webhook has no such thing.
 * There is no key to send, no id to reconcile against, and no way to ask Slack
 * whether the message it never finished answering about was posted. So a re-ask
 * after an ambiguous answer — a `502` from an edge, a socket that dropped
 * mid-flight — is a coin flip between recovering a lost post and putting the
 * lab's write-up into their channel twice.
 *
 * Those two outcomes are not equally bad, and that is what decides it. The
 * in-app artifact is the record and it is already written; a Slack post that
 * did not arrive costs the lab a notification they can still go and read. A
 * duplicated write-up in the channel is a thing the lab has to explain to
 * itself, cannot delete without workspace permissions Margin does not have, and
 * quietly makes the product look like it does not know what it sent.
 *
 * A `429` is the one refusal with no ambiguity in it: Slack is saying it did
 * not take this message and to come back at a stated time. That gets waited out
 * and re-asked. Everything else — a `5xx`, a `4xx`, a `fetch` that threw — is
 * logged once and dropped.
 *
 * `retryAfterMs` is imported rather than restated. It already reads both
 * spellings of the header, already refuses to believe a delay longer than this
 * action is willing to wait, and already survived being got wrong once; a
 * second copy of that reasoning is a second copy to get wrong again.
 */
export async function postToSlack(
  webhookUrl: string,
  message: SlackMessage,
): Promise<void> {
  const body = JSON.stringify(message);

  for (let attempt = 0; attempt < POST_ATTEMPTS; attempt++) {
    const lastAttempt = attempt === POST_ATTEMPTS - 1;

    let response: Response;
    try {
      response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
    } catch (caught) {
      // Not retried, unlike the mail path: a `fetch` that threw may have
      // delivered before the connection went, and there is no idempotency key
      // to make a second ask safe.
      throw new SlackRefusal(`unreachable (${String(caught)})`, null);
    }

    if (response.ok) {
      return;
    }

    if (response.status === 429 && !lastAttempt) {
      const wait = retryAfterMs(response, attempt);
      // `null` is Slack asking for longer than this action will wait. Falling
      // through to the failure below is the point.
      if (wait !== null) {
        await pause(wait);
        continue;
      }
    }

    // Slack answers a bad webhook with a short body — `no_service`,
    // `invalid_payload`, `channel_not_found` — which is genuinely the most
    // useful thing in the log, and carries no secret. The URL does, so it is
    // never logged and never put in an error.
    const detail = await response.text().catch(() => "");
    throw new SlackRefusal(
      `${response.status} ${detail}`.trim(),
      response.status,
    );
  }
}

/* -------------------------------------------------------------------------
 * Lab settings — the PI's half
 * ---------------------------------------------------------------------- */

/**
 * Whether this lab posts to Slack, and whether you are the one who decides.
 *
 * **Every member sees `connected`, not only the PI.** That is the whole reason
 * this query exists in the shape it does: turning it on means the notes a
 * member writes can be read by everyone in a Slack channel, which may be more
 * people than the lab. Somebody whose writing leaves the building is owed the
 * fact that it does, in the product, without having to ask.
 *
 * What nobody gets is the URL. It is not in this validator, it is not in any
 * other public query in the codebase, and `convex/slack.guard.test.ts` asserts
 * that by walking the schema and every returns validator rather than by
 * trusting this sentence. A webhook URL handed to the browser is a credential
 * in a query cache and in every dev tools pane that cache is ever opened in —
 * and the PI who pasted it has it already, in Slack, where it came from.
 *
 * Answers `false`/`false` rather than throwing for a non-member, the same
 * posture `notifications.outstandingCount` takes: a surface that renders
 * nothing is the correct reading of "you are not in this lab".
 */
export const status = query({
  args: { labId: v.id("labs") },
  returns: v.object({
    connected: v.boolean(),
    /** Whether the caller is the PI, and so may change it. */
    canManage: v.boolean(),
    /**
     * The last refusal, if the channel is currently refusing.
     *
     * `connected` alone would have the settings page saying "posting to a
     * channel" forever after a channel is archived, which is true about the
     * configuration and false about the world. This is what lets the page say
     * both halves. Every member sees it, not only the PI, for the same reason
     * every member sees `connected`: if a member's writing has stopped leaving
     * the building, that is a change to what they were told.
     */
    lastDeliveryFailed: v.union(
      v.null(),
      v.object({ at: v.number(), statusCode: v.number() }),
    ),
  }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const membership = await getMembership(ctx, args.labId, userId);
    if (membership === null) {
      return { connected: false, canManage: false, lastDeliveryFailed: null };
    }
    const lab = await ctx.db.get(args.labId);
    const last = lab?.slackLastDelivery;
    // Shown only when the record is a refusal *and* it describes the webhook
    // the lab has now. The mutation that writes it already refuses to record an
    // outcome against a replaced credential; this is the same rule applied
    // again at the read, so that a row which somehow got there anyway — a
    // restored backup, a hand-edited document — still cannot make this page
    // tell a lab their live channel is dead.
    const stale =
      last === undefined || last.connectedAt !== (lab?.slackConnectedAt ?? 0);
    return {
      connected: slackIsConfigured(lab),
      canManage: membership.role === "pi",
      lastDeliveryFailed:
        stale || last.statusCode === undefined
          ? null
          : { at: last.at, statusCode: last.statusCode },
    };
  },
});

/**
 * Point this lab at a Slack channel. PI only.
 *
 * The refusal is written for the person holding a URL they thought was right,
 * because that is who gets it: a webhook pasted half-selected, or copied from
 * the wrong page of Slack's own setup flow, looks exactly like one that works.
 * Saying which part is wrong is the difference between fixing it now and
 * discovering at the T−2h boundary that nothing was ever going to arrive.
 *
 * Replacing an existing webhook is accepted here — the patch does not care what
 * was there — and writes the same ledger fact as connecting for the first time,
 * because from the lab's side the fact is the same: their margin leaves the
 * building, by this person's decision, as of now.
 *
 * The settings page does not offer that as a single step, though. It shows the
 * field only while the lab is disconnected, so a PI changing channels presses
 * Disconnect and then pastes — two steps, and one visible state at a time, with
 * no box on screen whose being empty means "unchanged" and whose being full
 * means "replace". That is a deliberate choice about the surface rather than a
 * limitation of this function, and the copy on the failure banner says so.
 */
export const connect = mutation({
  args: { labId: v.id("labs"), webhookUrl: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requirePi(ctx, args.labId);

    const webhookUrl = normalizeWebhookUrl(args.webhookUrl);
    if (webhookUrl === null) {
      throw new ConvexError(
        "That doesn't look like a Slack incoming webhook. It should start with https://hooks.slack.com/ and carry the path Slack gave you — copy the whole URL from the Incoming Webhooks page.",
      );
    }

    // A new identity for a new credential, and the last outcome dropped —
    // pasting a URL is what fixing a dead channel looks like, and leaving the
    // record would have the settings page reporting a `404` against a webhook
    // that no longer exists. The stamp is what lets an outcome still sitting in
    // the scheduler, describing the webhook being replaced right now, be
    // recognised and ignored when it lands.
    await ctx.db.patch(args.labId, {
      slackWebhookUrl: webhookUrl,
      slackConnectedAt: Date.now(),
      slackLastDelivery: undefined,
    });
    await recordEvent(ctx, {
      labId: args.labId,
      actorId: actor.userId,
      type: "slack.delivery_changed",
      connected: true,
    });
    return null;
  },
});

/**
 * Stop posting. PI only.
 *
 * The field is removed rather than blanked, so "off" has one representation
 * and `slackIsConfigured` has one question to answer. Idempotent: disconnecting
 * a lab that was never connected is a no-op and writes no ledger fact, because
 * nothing about the lab changed.
 */
export const disconnect = mutation({
  args: { labId: v.id("labs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requirePi(ctx, args.labId);
    const lab = await ctx.db.get(args.labId);
    if (!slackIsConfigured(lab)) {
      return null;
    }
    await ctx.db.patch(args.labId, {
      slackWebhookUrl: undefined,
      slackConnectedAt: undefined,
      slackLastDelivery: undefined,
    });
    await recordEvent(ctx, {
      labId: args.labId,
      actorId: actor.userId,
      type: "slack.delivery_changed",
      connected: false,
    });
    return null;
  },
});

/**
 * What became of one post.
 *
 * Scheduled by each delivery action rather than called inline, because an
 * action cannot write and a post that arrived should not be held up by the
 * bookkeeping about it. Runs after every attempt, including the ones that
 * worked: recording a success is what lets a later-arriving failure know it has
 * been overtaken, and it is what makes the banner leave on its own when a lab
 * fixes its channel.
 *
 * Takes the session rather than the lab so the caller has nothing to look up
 * and nothing to get wrong; the lab, and the presenter this is filed under,
 * both hang off it.
 *
 * ## Nothing here can assume it is on time
 *
 * These mutations are scheduled from actions and race each other, the PI in the
 * settings page, and themselves. Three coordinates travel with an outcome so
 * that a late one can recognise itself as late:
 *
 *   - `connectedAt` — which webhook posted it. If the lab has replaced the
 *     credential since, this outcome is about a channel the lab has already
 *     stopped using, and stamping it would have the settings page reporting a
 *     `404` against a webhook that never saw one.
 *   - `attemptAt` — when the attempt finished. An outcome no newer than the one
 *     already recorded has been overtaken. This is what stops a refusal from
 *     two o'clock overwriting the proof that a post at two-oh-one landed, which
 *     is the sequence that would tell a lab their channel may be gone while
 *     their posts are arriving in it.
 *   - `deliveryAt` — which version of which artifact this was. Two approvals
 *     that both failed are two facts and stay two rows; being told twice about
 *     one failed post is one fact and must stay one row, because the ledger is
 *     append-only and cannot take a duplicate back.
 *
 * The summary and the ledger are guarded separately and on purpose. The mark on
 * `labs` is a claim about how things *are*, so it must never survive being
 * contradicted. A ledger row is a claim about what *happened*, which staleness
 * cannot make untrue — a post that failed at two o'clock failed at two o'clock
 * whatever the webhook is now. So a late outcome can still file its row while
 * being refused the mark, and the only thing that suppresses a row is the row
 * already being there.
 */
export const recordDeliveryOutcome = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    artifact: v.union(
      v.literal("brief"),
      v.literal("boundary"),
      v.literal("write-up"),
    ),
    /** The version stamp of the artifact posted; this delivery's identity. */
    deliveryAt: v.number(),
    /** The lab's `slackConnectedAt` when the post was made. */
    connectedAt: v.number(),
    /** When the attempt finished. */
    attemptAt: v.number(),
    /** The refusal's status, or `null` for a post that landed. */
    statusCode: v.union(v.number(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (session === null) return null;
    const lab = await ctx.db.get(session.labId);
    if (lab === null) return null;

    const last = lab.slackLastDelivery;
    const describesThisWebhook =
      (lab.slackConnectedAt ?? 0) === args.connectedAt &&
      lab.slackWebhookUrl !== undefined;
    const overtaken = last !== undefined && last.at >= args.attemptAt;

    if (describesThisWebhook && !overtaken) {
      await ctx.db.patch(lab._id, {
        slackLastDelivery: {
          at: args.attemptAt,
          connectedAt: args.connectedAt,
          // Absent, not zero: absent is how "it arrived" is spelled, and a
          // status of nothing is not a status.
          statusCode: args.statusCode ?? undefined,
        },
      });
    }

    if (args.statusCode === null) {
      return null;
    }

    // One row per failed delivery. Read off the ledger rather than off the mark
    // above, because the mark is a moving summary and this question is about
    // the permanent record: if the row is already there, being told again
    // changes nothing. The index is narrow — one session's events — and this
    // only runs when a post was refused.
    const filed = await ctx.db
      .query("events")
      .withIndex("by_session", (q) => q.eq("sessionId", session._id))
      .collect();
    const already = filed.some(
      (event) =>
        event.type === "slack.delivery_failed" &&
        event.artifact === args.artifact &&
        event.deliveryAt === args.deliveryAt,
    );
    if (already) {
      return null;
    }

    await recordEvent(ctx, {
      labId: lab._id,
      actorId: session.presenterId,
      sessionId: session._id,
      type: "slack.delivery_failed",
      artifact: args.artifact,
      statusCode: args.statusCode,
      deliveryAt: args.deliveryAt,
    });
    return null;
  },
});

/** Which of the three this was, for the ledger and for nothing else. */
type Artifact = "brief" | "boundary" | "write-up";

/** Everything an outcome needs to know about the post it describes. */
type Delivery = {
  sessionId: Id<"sessions">;
  artifact: Artifact;
  /** The artifact's version stamp — this delivery's identity. */
  deliveryAt: number;
  /** Which webhook made the post, per the payload query that read it. */
  connectedAt: number;
};

/**
 * Hand the outcome of a post to the mutation that records it.
 *
 * `caught` is `null` when the post landed. Anything else is inspected by
 * `permanentStatus`, and a failure that is merely a bad Tuesday leaves no trace
 * anywhere but the deployment log — saying nothing is the correct amount to say
 * about a `503`.
 *
 * `attemptAt` is stamped here rather than in the mutation, because here is where
 * the attempt actually finished. Stamping it on the other side would time the
 * bookkeeping instead of the post, and two outcomes could then be ordered by
 * how busy the scheduler was rather than by when they happened.
 */
async function noteOutcome(
  ctx: ActionCtx,
  delivery: Delivery,
  caught: unknown,
): Promise<void> {
  const statusCode = caught === null ? null : permanentStatus(caught);
  if (caught !== null && statusCode === null) return;
  await ctx.scheduler.runAfter(0, internal.slack.recordDeliveryOutcome, {
    ...delivery,
    attemptAt: Date.now(),
    statusCode,
  });
}

/* -------------------------------------------------------------------------
 * Shared payload plumbing
 * ---------------------------------------------------------------------- */

/**
 * Ceiling on how much of a paper's margin the boundary post looks at.
 *
 * The same thousand `convex/digests.ts` and `convex/briefs.ts` each pool, for
 * the same reason — collision detection is quadratic in it, and reading
 * newest-first means a runaway paper contributes the live end of its
 * conversation rather than its opening months.
 */
const POOL_LIMIT = 1000;

/** A display name, with the same fallbacks the rest of the product uses. */
function displayName(user: Doc<"users"> | null): string {
  return user?.name ?? user?.email ?? "A lab member";
}

/**
 * The lab's webhook, if this lab has one and this session belongs to it.
 *
 * Every payload query starts here, and it is the only place the URL is read.
 *
 * `connectedAt` comes back with it: the credential's non-secret identity, which
 * travels with the post so the outcome can be recognised later as describing
 * *this* webhook rather than whichever one the lab has by then. Zero for a lab
 * connected before that field existed — an identity that matches nothing, which
 * is the safe reading, since the only thing it can cost is a banner not shown.
 */
async function destinationFor(
  ctx: QueryCtx,
  labId: Id<"labs">,
): Promise<{ url: string; connectedAt: number } | null> {
  const lab = await ctx.db.get(labId);
  if (!slackIsConfigured(lab) || lab?.slackWebhookUrl === undefined) {
    return null;
  }
  return { url: lab.slackWebhookUrl, connectedAt: lab.slackConnectedAt ?? 0 };
}

/** Which of these citations are still shared with the lab, one read each. */
async function stillSharedAmong(
  ctx: QueryCtx,
  labId: Id<"labs">,
  citations: Iterable<Id<"annotations">>,
): Promise<Set<Id<"annotations">>> {
  const stillShared = new Set<Id<"annotations">>();
  for (const annotationId of citations) {
    if (isStillShared(await ctx.db.get(annotationId), labId)) {
      stillShared.add(annotationId);
    }
  }
  return stillShared;
}

/* -------------------------------------------------------------------------
 * The brief
 * ---------------------------------------------------------------------- */

const briefPayloadShape = v.object({
  webhookUrl: v.string(),
  /** Which webhook this is, so a late outcome can be told from a current one. */
  connectedAt: v.number(),
  sessionId: v.id("sessions"),
  paperTitle: v.string(),
  scheduledAt: v.number(),
  presenterName: v.string(),
  approvedByName: v.string(),
  citationCount: v.number(),
  sections: v.array(
    v.object({
      heading: v.string(),
      items: v.array(v.string()),
      droppedCount: v.number(),
    }),
  ),
});

/**
 * Everything the brief post needs, re-read at the moment of sending.
 *
 * Re-read rather than carried on the job's arguments, for the reason
 * `notifications.emailPayload` states: the gap between "mutation committed" and
 * "action ran" is a real interval and things happen in it. A note withdrawn or
 * flipped back to private in that window must not be posted, and a channel post
 * is the one delivery Margin cannot take back — it has no permission to edit or
 * delete a message it sent through a webhook.
 *
 * So the same all-or-nothing redaction `briefs.getForSession` applies on read is
 * applied here, out of the same `redactWithdrawn` rather than a second copy of
 * the rule. A redacted line is then **dropped** rather than posted as its
 * marker, which is the one place this diverges from the in-app surface and it
 * is a property of the medium: in the app the marker tells the presenter their
 * agenda has moved under them, and the panel updates when it moves again. A
 * channel post is frozen at the instant it was made, so a tombstone in one is
 * permanent furniture saying a line used to be here, on a page nobody can
 * refresh.
 *
 * `approvedAt` is the guard against posting a superseded review. A brief can be
 * approved, re-assembled and approved again while this job is queued, and each
 * approval schedules its own post; without the check the older job would post
 * the newer text under the older claim.
 */
export const briefPayload = internalQuery({
  args: { sessionId: v.id("sessions"), approvedAt: v.number() },
  returns: v.union(v.null(), briefPayloadShape),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (session === null || session.status === "cancelled") {
      return null;
    }
    const destination = await destinationFor(ctx, session.labId);
    if (destination === null) {
      return null;
    }

    const brief = await ctx.db
      .query("briefs")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .unique();
    if (brief === null || brief.approvedAt !== args.approvedAt) {
      return null;
    }

    const paper = await ctx.db.get(session.paperId);
    if (paper === null) {
      return null;
    }

    const cited = new Set<Id<"annotations">>();
    for (const section of brief.sections) {
      for (const item of section.items) {
        for (const annotationId of item.annotationIds) cited.add(annotationId);
      }
    }
    const stillShared = await stillSharedAmong(ctx, session.labId, cited);

    const sections = redactWithdrawn(brief.sections, stillShared)
      .map((section) => {
        const kept = section.items.filter(
          (item) => item.text !== WITHDRAWN_ITEM_TEXT,
        );
        return {
          heading: section.heading,
          items: kept.map((item) => item.text),
          // Lines withdrawn since the brief was assembled are counted in with
          // the ones the cap held back. In the app a withdrawal leaves a marker
          // where the line was, so the section still accounts for itself; here
          // the line is simply gone, and a count that ignored it would have the
          // section quietly show fewer items than it says it has. What the
          // sentence means to somebody reading it in Slack is "this section has
          // more in it than you can see", and that is true of both kinds.
          droppedCount:
            section.droppedCount + (section.items.length - kept.length),
        };
      })
      .filter((section) => section.items.length > 0);
    // A brief whose every line has been withdrawn is not a brief. Nothing is
    // posted, and the in-app panel already says so to the two people it is for.
    if (sections.length === 0) {
      return null;
    }

    return {
      webhookUrl: destination.url,
      connectedAt: destination.connectedAt,
      sessionId: session._id,
      paperTitle: paper.title,
      scheduledAt: session.scheduledAt,
      presenterName: displayName(await ctx.db.get(session.presenterId)),
      approvedByName:
        brief.approvedBy === undefined
          ? "the presenter"
          : displayName(await ctx.db.get(brief.approvedBy)),
      citationCount: stillShared.size,
      sections,
    };
  },
});

/**
 * Post the brief, because its presenter signed it off.
 *
 * Failures are logged, never thrown. The brief is already in the app and is the
 * artifact of record; a channel post is the courtesy copy, and a job that
 * throws would show up as a failed function every time a lab's webhook is stale
 * without anything useful happening as a result.
 */
export const deliverBrief = internalAction({
  args: { sessionId: v.id("sessions"), approvedAt: v.number() },
  returns: v.null(),
  // Spelled out rather than inferred: this action calls a query declared in its
  // own module, and an inferred return type makes that a cycle TypeScript
  // resolves by widening the whole generated `api` to `any` — the same note as
  // in `convex/notifications.ts`.
  handler: async (ctx, args): Promise<null> => {
    const site = siteUrl();
    if (site === null) {
      console.error(
        "SITE_URL is not set on this deployment, so a Slack post would carry a link to nowhere. Nothing was posted; the brief stands in the app.",
      );
      return null;
    }

    const payload = await ctx.runQuery(internal.slack.briefPayload, {
      sessionId: args.sessionId,
      approvedAt: args.approvedAt,
    });
    if (payload === null) {
      return null;
    }

    // The approval this post is carrying, and the webhook carrying it. Both
    // travel with the outcome so a late one can be recognised as late.
    const brief: Delivery = {
      sessionId: args.sessionId,
      artifact: "brief",
      deliveryAt: args.approvedAt,
      connectedAt: payload.connectedAt,
    };

    try {
      await postToSlack(
        payload.webhookUrl,
        composeBriefMessage({
          paperTitle: payload.paperTitle,
          when: slackDate(payload.scheduledAt),
          presenterName: payload.presenterName,
          approvedByName: payload.approvedByName,
          sections: payload.sections,
          citationCount: payload.citationCount,
          url: `${site}/app/sessions/${payload.sessionId}`,
        }),
      );
      await noteOutcome(ctx, brief, null);
    } catch (caught) {
      console.error(`Could not post a brief to Slack: ${String(caught)}`);
      await noteOutcome(ctx, brief, caught);
    }
    return null;
  },
});

/* -------------------------------------------------------------------------
 * The boundary post
 * ---------------------------------------------------------------------- */

const boundaryPayloadShape = v.object({
  webhookUrl: v.string(),
  /** Which webhook this is, so a late outcome can be told from a current one. */
  connectedAt: v.number(),
  paperId: v.id("papers"),
  paperTitle: v.string(),
  scheduledAt: v.number(),
  presenterName: v.string(),
  lines: v.array(v.string()),
  annotationCount: v.number(),
});

/**
 * The margin as it stands two hours out, addressed to the room.
 *
 * ## Why this is not one of the digests the same boundary just wrote
 *
 * `digests.buildSessionPrep` writes a row per member, and a `digests` row is
 * **one person's mail**: its delta is computed against that member's own
 * cursor, its lines are phrased with "you", and its whole privacy story is that
 * `listMine` starts from the signed-in user's id. Posting one into a shared
 * channel would undo all of that at once, and so would posting the union of
 * them — what a member has and has not caught up on is exactly the attention
 * data the privacy constitution refuses to store an aggregate of, and a channel
 * post computed from cursors is that aggregate, published.
 *
 * So the boundary post is built from the part of the same computation that is a
 * fact about the *paper* rather than about anybody: the gold collisions in its
 * margin. Two people landing on one passage from different directions is true
 * whether or not either of them has read the other, and it is the single most
 * useful thing to put in front of a lab two hours before they argue about it.
 *
 * `detectCollisions` is re-run here rather than passed down from the boundary
 * job, which costs one extra quadratic pass over a capped pool twice per
 * session — and buys the thing that matters more: a note withdrawn between T−2h
 * and this POST is simply not in the pool, because the pool is read now.
 *
 * The recipient handed to `collisionLine` is the empty string, which is not a
 * user id and so matches nobody. That is what keeps "you" out of a line
 * addressed to a room: the engine writes a collision from the recipient's side
 * when they are one of its two authors, and a channel is not one of the
 * authors. Every line therefore names both members, which is what the room
 * wants anyway.
 *
 * The `scheduled` / `expectedScheduledAt` guard is the same one the boundary
 * job makes and is re-made here for the same reason `briefs.buildForSession`
 * re-makes it: this is a separate transaction, later, and the cheapest way for
 * a check to stay true is for it never to be inherited. A meeting moved or
 * called off in the interval gets no post.
 */
export const boundaryPayload = internalQuery({
  args: { sessionId: v.id("sessions"), expectedScheduledAt: v.number() },
  returns: v.union(v.null(), boundaryPayloadShape),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (session === null) {
      return null;
    }
    if (
      session.status !== "scheduled" ||
      session.scheduledAt !== args.expectedScheduledAt
    ) {
      return null;
    }
    const destination = await destinationFor(ctx, session.labId);
    if (destination === null) {
      return null;
    }
    const paper = await ctx.db.get(session.paperId);
    if (paper === null) {
      return null;
    }

    // Privacy is the index, not a filter: `by_paper_and_visibility` at "lab"
    // cannot return a private annotation.
    const visible = await ctx.db
      .query("annotations")
      .withIndex("by_paper_and_visibility", (q) =>
        q.eq("paperId", session.paperId).eq("visibility", "lab"),
      )
      .order("desc")
      .take(POOL_LIMIT);
    const live = visible.filter((a) => a.deletedAt === undefined);
    if (live.length === 0) {
      // Nothing in the margin at all is not "no collisions" — it is a paper
      // nobody has opened, and a post saying so two hours out would be the
      // product nagging a lab about their homework.
      return null;
    }

    // "Someone", not the "A lab member" this module uses for a presenter or an
    // approver. These names are fed to the digest engine, whose contract names
    // this fallback and whose lines are written around it — "Someone marked the
    // same passage" reads as English where "A lab member marked" does not — and
    // it is the same line `convex/digests.ts` builds for the same lab's mail.
    // Resolved here rather than through `displayName` so the fallback that runs
    // is the documented one.
    const names = new Map<Id<"users">, string>();
    for (const authorId of new Set(live.map((a) => a.memberId))) {
      const user = await ctx.db.get(authorId);
      names.set(authorId, user?.name ?? user?.email ?? "Someone");
    }

    const pool: DigestAnnotation<
      Id<"papers">,
      Id<"annotations">,
      Id<"users">
    >[] = live.map((a) => ({
      id: a._id,
      paperId: a.paperId,
      memberId: a.memberId,
      // `names` was built from these very ids, so the fallback is the type
      // system's, not a behaviour — the reachable one is up there.
      memberName: names.get(a.memberId) ?? "Someone",
      type: a.type,
      pageIndex: a.anchor.pageIndex,
      start: a.anchor.start,
      end: a.anchor.end,
      quote: a.anchor.quote,
      createdAt: a._creationTime,
    }));

    // Already ranked newest-first by the engine, and capped at the same five a
    // digest is capped at — the number the simulation validated, and the number
    // past which a channel post stops being read.
    const lines = detectCollisions(pool)
      .slice(0, MAX_DIGEST_ITEMS)
      .map((collision) => collisionLine(collision, "", paper.title));

    return {
      webhookUrl: destination.url,
      connectedAt: destination.connectedAt,
      paperId: paper._id,
      paperTitle: paper.title,
      scheduledAt: session.scheduledAt,
      presenterName: displayName(await ctx.db.get(session.presenterId)),
      lines,
      annotationCount: live.length,
    };
  },
});

/** The T−2h post. Logged rather than thrown, as the brief's is. */
export const deliverBoundary = internalAction({
  args: { sessionId: v.id("sessions"), expectedScheduledAt: v.number() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const site = siteUrl();
    if (site === null) {
      console.error(
        "SITE_URL is not set on this deployment, so a Slack post would carry a link to nowhere. Nothing was posted; the digests stand in the app.",
      );
      return null;
    }

    const payload = await ctx.runQuery(internal.slack.boundaryPayload, {
      sessionId: args.sessionId,
      expectedScheduledAt: args.expectedScheduledAt,
    });
    if (payload === null) {
      return null;
    }

    // A boundary post has no approval to be stamped by, so the session's
    // scheduled time stands in: it is what the delivery is *about*, and moving
    // a session makes it a different post about a different meeting.
    const boundary: Delivery = {
      sessionId: args.sessionId,
      artifact: "boundary",
      deliveryAt: args.expectedScheduledAt,
      connectedAt: payload.connectedAt,
    };

    try {
      await postToSlack(
        payload.webhookUrl,
        composeBoundaryMessage({
          paperTitle: payload.paperTitle,
          when: slackDate(payload.scheduledAt),
          presenterName: payload.presenterName,
          lines: payload.lines,
          annotationCount: payload.annotationCount,
          url: `${site}/app/library/${payload.paperId}/read`,
        }),
      );
      await noteOutcome(ctx, boundary, null);
    } catch (caught) {
      console.error(
        `Could not post a session boundary to Slack: ${String(caught)}`,
      );
      await noteOutcome(ctx, boundary, caught);
    }
    return null;
  },
});

/* -------------------------------------------------------------------------
 * The write-up
 * ---------------------------------------------------------------------- */

const synthesisPayloadShape = v.object({
  webhookUrl: v.string(),
  /** Which webhook this is, so a late outcome can be told from a current one. */
  connectedAt: v.number(),
  sessionId: v.id("sessions"),
  paperTitle: v.string(),
  scheduledAt: v.number(),
  approvedByName: v.string(),
  markdown: v.string(),
  citationCount: v.number(),
  revised: v.boolean(),
});

/**
 * The approved write-up, re-read at the moment of sending.
 *
 * The prose is posted exactly as the approver stored it — this is the version
 * of the meeting the lab keeps, and it is not this module's business to edit
 * it on the way out any more than it was `synthesis.approve`'s to check it.
 * What is re-read is everything *around* it: the citation count is recomputed
 * against what is still shared right now, so the footer's claim is true at the
 * instant it is made rather than at the instant it was queued.
 *
 * `approvedAt` guards against posting a superseded version. Two approvals a
 * minute apart schedule two jobs; without the check the first job could run
 * second and post the older prose underneath the newer one.
 *
 * `approvedBy` rides on the job's arguments rather than being re-read, because
 * there is nowhere to re-read it from — `sessions` records *when* a write-up was
 * approved and not by whom, and the name belongs in the post. It is immutable
 * history in any case: who approved a given `approvedAt` is a fact that cannot
 * change, and the `approvedAt` check is what pins the pair together.
 */
export const synthesisPayload = internalQuery({
  args: {
    sessionId: v.id("sessions"),
    approvedAt: v.number(),
    approvedBy: v.id("users"),
    revised: v.boolean(),
  },
  returns: v.union(v.null(), synthesisPayloadShape),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (session === null) {
      return null;
    }
    if (
      session.synthesis === undefined ||
      session.synthesisApprovedAt !== args.approvedAt
    ) {
      return null;
    }
    const destination = await destinationFor(ctx, session.labId);
    if (destination === null) {
      return null;
    }
    const paper = await ctx.db.get(session.paperId);
    if (paper === null) {
      return null;
    }

    const stillShared = await stillSharedAmong(
      ctx,
      session.labId,
      session.synthesisCitedAnnotationIds ?? [],
    );

    return {
      webhookUrl: destination.url,
      connectedAt: destination.connectedAt,
      sessionId: session._id,
      paperTitle: paper.title,
      scheduledAt: session.scheduledAt,
      approvedByName: displayName(await ctx.db.get(args.approvedBy)),
      markdown: session.synthesis,
      citationCount: stillShared.size,
      revised: args.revised,
    };
  },
});

/** The write-up post. Logged rather than thrown, as the other two are. */
export const deliverSynthesis = internalAction({
  args: {
    sessionId: v.id("sessions"),
    approvedAt: v.number(),
    approvedBy: v.id("users"),
    revised: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const site = siteUrl();
    if (site === null) {
      console.error(
        "SITE_URL is not set on this deployment, so a Slack post would carry a link to nowhere. Nothing was posted; the write-up stands in the app.",
      );
      return null;
    }

    const payload = await ctx.runQuery(internal.slack.synthesisPayload, {
      sessionId: args.sessionId,
      approvedAt: args.approvedAt,
      approvedBy: args.approvedBy,
      revised: args.revised,
    });
    if (payload === null) {
      return null;
    }

    const writeUp: Delivery = {
      sessionId: args.sessionId,
      artifact: "write-up",
      deliveryAt: args.approvedAt,
      connectedAt: payload.connectedAt,
    };

    try {
      await postToSlack(
        payload.webhookUrl,
        composeSynthesisMessage({
          paperTitle: payload.paperTitle,
          when: slackDate(payload.scheduledAt),
          approvedByName: payload.approvedByName,
          markdown: payload.markdown,
          citationCount: payload.citationCount,
          revised: payload.revised,
          url: `${site}/app/sessions/${payload.sessionId}`,
        }),
      );
      await noteOutcome(ctx, writeUp, null);
    } catch (caught) {
      console.error(`Could not post a write-up to Slack: ${String(caught)}`);
      await noteOutcome(ctx, writeUp, caught);
    }
    return null;
  },
});
