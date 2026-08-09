import { ConvexError, v } from "convex/values";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { action, mutation, query } from "./_generated/server";
import { emailIsConfigured, renderEmail, sendEmail, siteUrl } from "./auth";
import { getMembership, requirePi, requireUserId } from "./lib/authz";
import { recordEvent } from "./lib/ledger";

/**
 * 32 unambiguous characters: no `I`, `L`, `O`, or `0`, because these codes get
 * read aloud in lab meetings and written on whiteboards. Exactly 32 symbols
 * means a random byte maps to one with `& 31` and no modulo bias.
 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ123456789";
const CODE_LENGTH = 8;
const DEFAULT_TTL_DAYS = 14;
const MAX_TTL_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A lab is a research group, not a mailing list — 25 covers the big ones. */
const DEFAULT_MAX_USES = 25;
const MAX_MAX_USES = 200;
/** One batch of emailed invitations. Same ceiling as a lab, for the same reason. */
const MAX_EMAIL_RECIPIENTS = 25;

/**
 * How many invitations go to Resend at once, and how long the batch waits
 * between mouthfuls.
 *
 * Resend rate-limits a team at ten requests a second. A PI inviting their
 * whole group used to hand all twenty-five to `Promise.allSettled` in one
 * breath, which is twenty-five simultaneous POSTs: the first handful are
 * accepted and the rest come back `429`. Those then surface in `failed` as if
 * the addresses were bad, so the PI is shown a list of their own labmates and
 * told Margin could not reach them — and re-sending does the same thing again.
 *
 * Five at a time, a beat apart, keeps a full lab under the limit and finishes
 * in about three seconds. `sendEmail` still retries a `429` on its own; this is
 * the half that stops provoking one.
 */
const SEND_BURST = 5;
const SEND_BURST_PAUSE_MS = 700;

function randomCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const byte of bytes) {
    code += CODE_ALPHABET.charAt(byte & 31);
  }
  return code;
}

/** Codes are shared by voice and by paste, so accept any casing, spaces, or dashes. */
function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

async function generateUniqueCode(ctx: MutationCtx): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = randomCode();
    const existing = await ctx.db
      .query("invites")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique();
    if (existing === null) {
      return code;
    }
  }
  throw new ConvexError("Could not generate an invite code. Please try again.");
}

/**
 * A refusal the client can branch on without reading the prose.
 *
 * Redemption fails for two unlike reasons, and only one of them is final. If
 * the code is revoked, expired, full or simply wrong, it will still be all of
 * those things in ten seconds, and the caller should stop holding on to it.
 * If the caller merely isn't authenticated yet — an `authz` helper throwing
 * past this function — the code is untouched and perfectly good.
 *
 * The difference is invisible when both arrive as a bare string, and the
 * client guessed wrong: it treated every `ConvexError` as final and threw away
 * live invitations on a lapsed session. So the final ones say so in a field,
 * and everything else is transient by default — the safe way round, because
 * mistaking a dead code for a retryable one costs a wasted click, and the
 * reverse costs the invitation.
 */
function refused(message: string): ConvexError<{
  kind: "invite-refused";
  message: string;
}> {
  return new ConvexError({ kind: "invite-refused" as const, message });
}

/** A code admits people only while it is unrevoked, unexpired, and unfilled. */
function isLive(invite: Doc<"invites">, now: number): boolean {
  return (
    invite.revokedAt === undefined &&
    invite.expiresAt > now &&
    invite.useCount < invite.maxUses
  );
}

/** Mint a shareable join code for a lab. PI only. */
export const createInvite = mutation({
  args: {
    labId: v.id("labs"),
    ttlDays: v.optional(v.number()),
    maxUses: v.optional(v.number()),
  },
  returns: v.object({
    /** So a half-delivered batch can be re-sent on this code instead of a new one. */
    inviteId: v.id("invites"),
    code: v.string(),
    expiresAt: v.number(),
    maxUses: v.number(),
    /** For composing the invitation email, which has to name the lab it is for. */
    labName: v.string(),
  }),
  handler: async (ctx, args) => {
    const membership = await requirePi(ctx, args.labId);
    const lab = await ctx.db.get(args.labId);
    if (lab === null) {
      throw new ConvexError("That lab no longer exists.");
    }

    const ttlDays = args.ttlDays ?? DEFAULT_TTL_DAYS;
    if (!Number.isFinite(ttlDays) || ttlDays <= 0 || ttlDays > MAX_TTL_DAYS) {
      throw new ConvexError(
        `Invite codes can last between 1 and ${MAX_TTL_DAYS} days.`,
      );
    }

    const maxUses = args.maxUses ?? DEFAULT_MAX_USES;
    if (
      !Number.isInteger(maxUses) ||
      maxUses < 1 ||
      maxUses > MAX_MAX_USES
    ) {
      throw new ConvexError(
        `An invite code can admit between 1 and ${MAX_MAX_USES} people.`,
      );
    }

    const code = await generateUniqueCode(ctx);
    const expiresAt = Date.now() + ttlDays * DAY_MS;

    const inviteId = await ctx.db.insert("invites", {
      code,
      labId: args.labId,
      createdBy: membership.userId,
      expiresAt,
      useCount: 0,
      maxUses,
    });

    await recordEvent(ctx, {
      labId: args.labId,
      type: "invite.created",
      actorId: membership.userId,
      inviteId,
    });

    return { inviteId, code, expiresAt, maxUses, labName: lab.name };
  },
});

/**
 * One live code the caller already owns, ready to be delivered again.
 *
 * This is what makes re-sending a half-delivered batch cost nothing: without
 * it, every retry minted a fresh code while the first stayed live, so a lab
 * that retried twice was left with three credentials admitting three times the
 * people it meant to invite. Delivery is not admission — mailing the same code
 * a second time must not widen the door.
 *
 * PI only, and the invite has to belong to the lab being claimed: an id from
 * the client is a claim like any other.
 */
export const getLiveInvite = query({
  args: { labId: v.id("labs"), inviteId: v.id("invites") },
  returns: v.object({
    inviteId: v.id("invites"),
    code: v.string(),
    expiresAt: v.number(),
    labName: v.string(),
    /** How many more people this code can still admit. */
    remainingUses: v.number(),
  }),
  handler: async (ctx, args) => {
    await requirePi(ctx, args.labId);

    const invite = await ctx.db.get(args.inviteId);
    if (
      invite === null ||
      invite.labId !== args.labId ||
      !isLive(invite, Date.now())
    ) {
      throw new ConvexError(
        "That code is no longer live. Generate a new one to invite anybody else.",
      );
    }

    const lab = await ctx.db.get(args.labId);
    if (lab === null) {
      throw new ConvexError("That lab no longer exists.");
    }

    return {
      inviteId: invite._id,
      code: invite.code,
      expiresAt: invite.expiresAt,
      labName: lab.name,
      remainingUses: invite.maxUses - invite.useCount,
    };
  },
});

/** Codes are typed by hand as often as they are pasted, so be generous about what an address looks like and strict about what is sent. */
function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

const EMAIL_SHAPE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/**
 * Split whatever the PI pasted into addresses.
 *
 * A roster arrives from a spreadsheet column, a Slack message or a mail
 * client's "to" line, so commas, semicolons and newlines all mean the same
 * thing. Duplicates collapse: mailing the same postdoc twice would also spend
 * two of the code's uses.
 */
export function parseRecipients(input: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const chunk of input) {
    for (const piece of chunk.split(/[\s,;]+/)) {
      const email = normalizeEmail(piece);
      if (email.length > 0) {
        seen.add(email);
      }
    }
  }
  return [...seen];
}

/**
 * The invitation, as text and as HTML.
 *
 * Composed once for the whole batch rather than once per address, because it
 * is the same message: one code covers the batch, so there is nothing in here
 * that varies by recipient. Nothing personalised also means nothing that could
 * accidentally tell one invitee who else was invited.
 *
 * Pure and exported so the copy is readable in a test. This is the first thing
 * anybody outside a lab ever sees of Margin, and a sentence that explains what
 * the product is has to survive being edited by people who are looking at
 * something else.
 */
export function composeInviteEmail(invitation: {
  inviter: string;
  labName: string;
  code: string;
  expires: string;
  url: string;
}): { subject: string; text: string; html: string } {
  const what =
    "Margin is where a lab reads papers together: everyone annotates in the same margin, and the journal club runs off what the group flagged.";
  const fallback = `Or join with the code ${invitation.code}, which expires on ${invitation.expires}.`;

  return {
    subject: `${invitation.inviter} invited you to ${invitation.labName} on Margin`,
    text: [
      `${invitation.inviter} invited you to ${invitation.labName} on Margin.`,
      "",
      what,
      "",
      "Open the invitation:",
      invitation.url,
      "",
      fallback,
      "",
      "Margin",
    ].join("\n"),
    html: renderEmail({
      heading: `${invitation.inviter} invited you to ${invitation.labName}`,
      paragraphs: [
        what,
        "The link opens Margin and takes you straight into the lab.",
      ],
      action: { label: "Join the lab", url: invitation.url },
      footnotes: [fallback],
    }),
  };
}

/**
 * Mint a code and mail it to people, instead of reading it out in a meeting.
 *
 * The code is the credential either way — this is a delivery channel, not a
 * second kind of invitation. One code covers the batch rather than one per
 * address: a per-address code would fill the PI's list with rows nobody reads,
 * and the ledger already records who actually joined. `maxUses` is set to the
 * number of recipients, so the code cannot outlive the batch it was minted for,
 * and revoking it calls the whole batch off.
 *
 * Nothing about the recipients is stored. Who was invited is not a fact Margin
 * needs; who joined is, and that is already a `member.joined` event.
 *
 * An action rather than a mutation because sending mail is a network call.
 * `runMutation` carries the caller's identity, so `createInvite` still does the
 * PI check — this function adds no authorization of its own.
 */
export const inviteByEmail = action({
  args: {
    labId: v.id("labs"),
    /** Free text: one address, a comma-separated line, or a pasted column. */
    emails: v.array(v.string()),
    /**
     * Deliver this existing code rather than minting one.
     *
     * Set when re-sending the addresses a previous batch could not reach. The
     * capacity to admit those people was already granted when the batch was
     * first minted, so spending it again would be counting the same guests
     * twice — hence a redelivery, not a new invitation.
     */
    inviteId: v.optional(v.id("invites")),
  },
  returns: v.object({
    /** Pass back on a retry so the failures ride the same code. */
    inviteId: v.id("invites"),
    code: v.string(),
    sent: v.number(),
    /**
     * The addresses Resend would not take, so the PI can see which ones to
     * fix rather than being told a number and left to guess.
     *
     * Handing them back is not a change of privacy stance: they arrived in
     * this same call, they are returned to the caller who sent them, and
     * nothing writes them anywhere. There is still no record of who was
     * invited — only of who joined.
     */
    failed: v.array(v.string()),
  }),
  // The return type is spelled out because this action calls `createInvite`
  // through `api.invites`, i.e. through the type of the module it is declared
  // in. Left to infer, that is a cycle, and TypeScript resolves it by making
  // the whole generated `api` implicitly `any` — which silently unpicks the
  // types of every `useQuery` in the app, not just this one function.
  handler: async (
    ctx,
    args,
  ): Promise<{
    inviteId: Id<"invites">;
    code: string;
    sent: number;
    failed: string[];
  }> => {
    // Checked before anything is minted: a code created for a batch that could
    // never be delivered is just litter in the PI's list.
    if (!emailIsConfigured()) {
      throw new ConvexError(
        "Email isn't set up on this deployment. Share the code instead.",
      );
    }

    // Checked here for the same reason: an invitation is a link, and a
    // deployment that does not know its own origin can only send a link to
    // nowhere. Refused up front rather than delivered broken — the code itself
    // still works, and the message says so.
    const site = siteUrl();
    if (site === null) {
      throw new ConvexError(
        "This deployment doesn't know its own address (SITE_URL), so an invitation link would go nowhere. Share the code instead.",
      );
    }

    const recipients = parseRecipients(args.emails);
    if (recipients.length === 0) {
      throw new ConvexError("Enter at least one email address.");
    }
    if (recipients.length > MAX_EMAIL_RECIPIENTS) {
      throw new ConvexError(
        `You can invite up to ${MAX_EMAIL_RECIPIENTS} people at a time.`,
      );
    }
    const malformed = recipients.find((email) => !EMAIL_SHAPE.test(email));
    if (malformed !== undefined) {
      throw new ConvexError(`${malformed} doesn't look like an email address.`);
    }

    // Minting is for a new batch only. A retry re-delivers the code the batch
    // already has, so the lab's admission capacity is what it was when the PI
    // decided who to invite — not that number again for every send that
    // half-failed.
    let invite: {
      inviteId: Id<"invites">;
      code: string;
      expiresAt: number;
      labName: string;
    };
    if (args.inviteId === undefined) {
      invite = await ctx.runMutation(api.invites.createInvite, {
        labId: args.labId,
        maxUses: recipients.length,
      });
    } else {
      const existing = await ctx.runQuery(api.invites.getLiveInvite, {
        labId: args.labId,
        inviteId: args.inviteId,
      });
      // Capacity is never raised here — a code that cannot seat the retry is
      // refused out loud, so the PI mints one deliberately rather than
      // discovering later that the last person to click was turned away.
      if (recipients.length > existing.remainingUses) {
        throw new ConvexError(
          `That code can only admit ${existing.remainingUses} more ${existing.remainingUses === 1 ? "person" : "people"}. Generate a new invite code for the rest.`,
        );
      }
      invite = existing;
    }

    const viewer = await ctx.runQuery(api.users.viewer, {});
    const inviter = viewer?.name ?? viewer?.email ?? "Someone";

    // `SITE_URL` is the same origin Convex Auth already sends its sign-in
    // links to, so the invitation and the sign-in it triggers agree about
    // where Margin lives. `/app` carries the code through the middleware:
    // signed out it becomes `/signin?invite=…` and comes back after auth.
    const url = `${site}/app?invite=${encodeURIComponent(invite.code)}`;
    const expires = new Date(invite.expiresAt).toISOString().slice(0, 10);
    const message = composeInviteEmail({
      inviter,
      labName: invite.labName,
      code: invite.code,
      expires,
      url,
    });

    // Paced rather than fired all at once — see `SEND_BURST`.
    const results: PromiseSettledResult<void>[] = [];
    for (let start = 0; start < recipients.length; start += SEND_BURST) {
      if (start > 0) {
        await new Promise((resolve) => setTimeout(resolve, SEND_BURST_PAUSE_MS));
      }
      results.push(
        ...(await Promise.allSettled(
          recipients
            .slice(start, start + SEND_BURST)
            .map((to) => sendEmail({ to, ...message })),
        )),
      );
    }

    // Paired back up by position — `Promise.allSettled` preserves the order of
    // what it was given, so index `i` is `recipients[i]`.
    const failed = recipients.filter(
      (_, index) => results[index]?.status === "rejected",
    );
    return {
      inviteId: invite.inviteId,
      code: invite.code,
      sent: recipients.length - failed.length,
      failed,
    };
  },
});

/** Live invite codes for a lab, so the PI can re-read one instead of minting a new one. PI only. */
export const listInvites = query({
  args: { labId: v.id("labs") },
  returns: v.array(
    v.object({
      _id: v.id("invites"),
      code: v.string(),
      expiresAt: v.number(),
      useCount: v.number(),
      maxUses: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    await requirePi(ctx, args.labId);
    const now = Date.now();

    const invites = await ctx.db
      .query("invites")
      .withIndex("by_lab", (q) => q.eq("labId", args.labId))
      .collect();

    return invites
      .filter((invite) => isLive(invite, now))
      .sort((a, b) => b._creationTime - a._creationTime)
      .map((invite) => ({
        _id: invite._id,
        code: invite.code,
        expiresAt: invite.expiresAt,
        useCount: invite.useCount,
        maxUses: invite.maxUses,
      }));
  },
});

/**
 * Kill a code before it expires — the only remedy when one is pasted into the
 * wrong Slack. PI only, and idempotent so a double-click is harmless.
 *
 * Revocation is a patch on the invite, not a delete: `listInvites` stops
 * showing it and `redeemInvite` stops honouring it, but the ledger's
 * `invite.created` fact keeps pointing at a row that still exists.
 */
export const revokeInvite = mutation({
  args: { inviteId: v.id("invites") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const invite = await ctx.db.get(args.inviteId);
    if (invite === null) {
      throw new ConvexError("That invite code is not valid.");
    }
    const membership = await requirePi(ctx, invite.labId);

    if (invite.revokedAt !== undefined) {
      return null;
    }

    await ctx.db.patch(invite._id, { revokedAt: Date.now() });
    await recordEvent(ctx, {
      labId: invite.labId,
      type: "invite.revoked",
      actorId: membership.userId,
      inviteId: invite._id,
    });
    return null;
  },
});

/**
 * Join a lab with a code. Idempotent: redeeming twice (or redeeming a code for
 * a lab you already belong to, including your own) is a no-op that reports
 * `alreadyMember` instead of erroring or duplicating a membership.
 */
export const redeemInvite = mutation({
  args: { code: v.string() },
  returns: v.object({
    labId: v.id("labs"),
    labName: v.string(),
    alreadyMember: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const code = normalizeCode(args.code);

    if (code.length !== CODE_LENGTH) {
      throw refused("Invite codes are 8 characters.");
    }

    const invite = await ctx.db
      .query("invites")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique();

    // Same message for "wrong code", "expired", "revoked", and "full" — an
    // invite code should not be an oracle for which labs exist.
    if (invite === null || !isLive(invite, Date.now())) {
      throw refused("That invite code is not valid.");
    }

    const lab = await ctx.db.get(invite.labId);
    if (lab === null) {
      throw refused("That invite code is not valid.");
    }

    const existing = await getMembership(ctx, invite.labId, userId);
    if (existing !== null) {
      return { labId: lab._id, labName: lab.name, alreadyMember: true };
    }

    await ctx.db.insert("memberships", {
      labId: invite.labId,
      userId,
      role: "member",
      joinedAt: Date.now(),
    });
    await ctx.db.patch(lab._id, { memberCount: lab.memberCount + 1 });
    await ctx.db.patch(invite._id, { useCount: invite.useCount + 1 });

    await recordEvent(ctx, {
      labId: invite.labId,
      type: "member.joined",
      actorId: userId,
      subjectUserId: userId,
      role: "member",
      via: "invite",
    });

    return { labId: lab._id, labName: lab.name, alreadyMember: false };
  },
});
