import Google from "@auth/core/providers/google";
import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";
import type { AuthProviderConfig, EmailConfig } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { DataModel, Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { ensurePersonalLibrary } from "./labs";

/**
 * Three ways in, and the deployment decides which of them exist.
 *
 * Passwords are the floor: they need no third party, so a PI can get their lab
 * in without waiting on anyone's IT department, and they are always on. Google
 * and the emailed sign-in link are additions, each switched on by setting its
 * key on the Convex deployment:
 *
 *   AUTH_GOOGLE_ID + AUTH_GOOGLE_SECRET   Google OAuth
 *   RESEND_API_KEY                        sign-in links and emailed invites
 *
 * A provider whose key is missing is not registered at all, so `signIn` for it
 * fails with "provider not configured" rather than with something from deep
 * inside an OAuth handshake. The browser cannot read Convex deployment env, so
 * the buttons are gated separately by NEXT_PUBLIC_AUTH_GOOGLE /
 * NEXT_PUBLIC_AUTH_EMAIL — see `.env.example`. Leave those unset and the
 * sign-in page is exactly the password form it has always been.
 *
 * The link matters more than it looks. A postdoc handed a Margin invitation
 * should go click link → reading the paper, with no password ceremony in
 * between; that is the whole reason this file grew past `Password`.
 *
 * ## What a deployment that sends mail has to have set
 *
 * `RESEND_API_KEY` switches sending on. Two more are not optional in practice
 * and neither of them announces itself when it is wrong:
 *
 *   AUTH_EMAIL_FROM   an address on a domain verified in Resend. Left unset,
 *                     mail comes from the sandbox sender, which delivers only
 *                     to the Resend account owner and refuses everyone else.
 *   SITE_URL          the app's real public origin. Every message Margin sends
 *                     is an envelope around one link, and `siteUrl()` below
 *                     refuses to build that link out of nothing.
 *
 * And one thing that lives in Resend rather than here: open tracking and click
 * tracking are per-domain switches in their dashboard, and they must both be
 * off. Open tracking inserts a pixel into the HTML on the way out; click
 * tracking rewrites every `href` to a redirector that records the press. Both
 * would be added *after* this code has finished writing the message, and both
 * are exactly the thing `renderEmail` refuses to do. A product that promises
 * never to track what you read cannot ship either one, and no assertion in
 * this repository can see them — only an operator looking at the domain's
 * settings can.
 */

/** An hour is long enough to walk to a laptop, short enough that a forwarded mail is stale. */
const SIGN_IN_LINK_TTL_S = 60 * 60;

const RESEND_ENDPOINT = "https://api.resend.com/emails";

const nonEmpty = (v: string | undefined): boolean =>
  typeof v === "string" && v.trim().length > 0;

/**
 * Who Margin's mail comes from.
 *
 * The Resend sandbox sender works out of the box for a dev deployment and is
 * refused for any recipient other than the account owner, which is the correct
 * failure: it makes "we never set AUTH_EMAIL_FROM to a verified domain" show
 * up on the first real invite rather than silently never arriving.
 */
function emailFrom(): string {
  return process.env.AUTH_EMAIL_FROM ?? "Margin <onboarding@resend.dev>";
}

/** Whether this deployment can send mail at all. */
export function emailIsConfigured(): boolean {
  return nonEmpty(process.env.RESEND_API_KEY);
}

/**
 * Whether this deployment holds a Google OAuth client.
 *
 * Both halves, and both non-empty. The emptiness is the part worth spelling
 * out: `npx convex env set AUTH_GOOGLE_ID ""` is how people un-set a variable
 * they are not ready to fill in, and a dashboard field saved blank reads the
 * same way. An existence check passes on both, so the provider registers with
 * an empty client id and the reader is handed Google's own `invalid_client`
 * page — the deep-inside-the-handshake failure the block comment at the top of
 * this file promises does not happen here. Same test the Resend key gets, for
 * the same reason: a key that is present but blank is not a key.
 */
export function googleIsConfigured(): boolean {
  return (
    nonEmpty(process.env.AUTH_GOOGLE_ID) &&
    nonEmpty(process.env.AUTH_GOOGLE_SECRET)
  );
}

/**
 * Where the one link in every message points, or `null` if nowhere.
 *
 * Every email Margin sends is an envelope around a single link — sign in here,
 * join this lab, open this margin — so an email with a dead link is not a
 * degraded email, it is a wasted one. `SITE_URL` is set by
 * `npx @convex-dev/auth` on a development deployment and by hand on a
 * production one, which means it is exactly the sort of variable a new
 * deployment has never heard of.
 *
 * The old spelling was `(process.env.SITE_URL ?? "")`, which turns a missing
 * origin into `href="/app/library/…"` — a relative URL, which is a real path
 * inside a mail client and a real 404 for the reader. Answering `null` instead
 * makes each caller decide out loud: the invitation refuses to be sent, and the
 * notification quietly stays in the app where it already is.
 *
 * A value that is not an absolute http(s) origin is treated as absent for the
 * same reason — `margin.example.edu` with no scheme is a relative path too.
 *
 * ## Why this rejects rather than normalizes
 *
 * `https://margin.example.edu?source=mail` and
 * `https://admin:hunter2@margin.example.edu` both used to pass, and every link
 * Margin sends is built by concatenation — `${site}/app?invite=…` — so the
 * first becomes `…edu?source=mail/app?invite=…`, which is a path on a query
 * string and resolves to nothing. Credentials in the authority are worse: they
 * would be mailed to everyone the lab invites.
 *
 * The obvious fix is to normalize — to `parsed.origin`, or by trimming — and
 * that is the wrong one. Convex Auth builds its own base as
 * `requireEnv("SITE_URL").replace(/\/$/, "")`: no trim, and exactly one
 * trailing slash removed. Anything this function cleans up that Convex Auth
 * does not leaves two bases that quietly disagree about where Margin lives —
 * which is precisely what `convex/invites.ts` states out loud cannot happen,
 * and it matters because the sign-in a link triggers has to land on the same
 * origin the link came from.
 *
 * So the rule is: byte-identical to Convex Auth's base, or nothing at all.
 * `" https://x.example"` and `"https://x.example//"` are both refused rather
 * than tidied, because tidying them here does not tidy them there. And so are
 * a path, a query, a fragment and credentials — none of which survive
 * concatenation into `${site}/app?invite=…` in any useful form.
 *
 * Refusing is not a worse outcome than guessing. It surfaces as an invitation
 * that declines to send and says why, and a notification that stays in the app
 * where it already is, rather than as real mail with a dead link in it.
 */
export function siteUrl(): string | null {
  const configured = process.env.SITE_URL;
  if (typeof configured !== "string") {
    return null;
  }
  // Convex Auth does not trim, so neither may we: a padded value would give
  // this function a usable origin and the library a broken one.
  if (configured !== configured.trim()) {
    return null;
  }
  // Convex Auth strips one trailing slash. A value ending in more than one
  // is a misconfiguration whichever way you read it, and the two readings
  // differ — so it is refused rather than picked between.
  if (configured.endsWith("//")) {
    return null;
  }
  const base = configured.replace(/\/$/, "");
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  if (parsed.hostname.length === 0) {
    return null;
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return null;
  }
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    return null;
  }
  return base;
}

/** Text is escaped into HTML in three places; one function so it cannot be forgotten in the fourth. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The invisible tail on the preview line.
 *
 * A mail client builds the grey line next to the subject by walking the
 * document for readable text and stopping when it has about a hundred
 * characters. Without this, it walks straight past the hidden preheader into
 * the wordmark and shows "Ana mentioned you on Attention Is All You Need
 * margin Ana mentioned you…" — the sentence, then the letterhead, then the
 * sentence again.
 *
 * So the preheader is followed by a run of characters that are text to the
 * scanner and nothing to the eye: a combining grapheme joiner, a zero-width
 * non-joiner, and a non-breaking space, repeated until the preview is full.
 * It is a silly trick, it is the only one that works in Gmail and Outlook
 * both, and it is the reason this constant exists.
 */
const PREVIEW_FILLER = "&#847;&zwnj;&nbsp;".repeat(50);

/**
 * Margin's mail, in the same voice as Margin's pages: a sheet of paper with a
 * rule down the left, serif for what you read, and one thing to click.
 *
 * Deliberately hand-written inline CSS with no images, no tracking pixel, and
 * no remote assets — not a webfont, not a logo, not a one-pixel GIF. Partly
 * because mail clients strip everything else, and partly because a product
 * that promises never to track what you read has no business knowing whether
 * you opened the envelope. `convex/email.guard.test.ts` asserts that
 * mechanically, the way `convex/privacy.guard.test.ts` asserts the schema's
 * half of the same promise.
 *
 * A whole document rather than a fragment, and that is not pedantry. Every
 * subject and every snippet Margin sends carries typographic quotes and an
 * ellipsis — “…” — and a fragment with no `<meta charset>` is decoded by
 * whatever the client guesses, which for Outlook is often Windows-1252 and
 * renders a lab's paper title as `â€œAttentionâ€`. `color-scheme: light only`
 * is here for the neighbouring reason: left to itself a dark-mode client
 * re-computes the palette, and the paper-and-ink page comes out as grey text
 * on a muddy brown card.
 */
export function renderEmail(options: {
  heading: string;
  paragraphs: string[];
  action: { label: string; url: string };
  footnotes?: string[];
}): string {
  const paragraphs = options.paragraphs
    .map(
      (text) =>
        `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#3b2f2a">${escapeHtml(text)}</p>`,
    )
    .join("");
  const footnotes = (options.footnotes ?? [])
    .map(
      (text) =>
        `<p style="margin:0 0 8px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:#736458">${escapeHtml(text)}</p>`,
    )
    .join("");

  return [
    `<!doctype html>`,
    `<html lang="en">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<meta name="color-scheme" content="light only">`,
    `<meta name="supported-color-schemes" content="light only">`,
    `<title>${escapeHtml(options.heading)}</title>`,
    `</head>`,
    `<body style="margin:0;padding:0;background:#f7f2e9;color-scheme:light only">`,
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0">${escapeHtml(options.heading)}${PREVIEW_FILLER}</div>`,
    `<div style="background:#f7f2e9;padding:32px 16px">`,
    `<div style="max-width:512px;margin:0 auto;background:#fdfaf4;border:1px solid #e2d5c1;border-radius:6px;padding:32px;font-family:Georgia,'Times New Roman',serif">`,
    `<p style="margin:0 0 24px;font-family:Georgia,serif;font-size:28px;line-height:1;color:#2a211d">margin</p>`,
    `<div style="border-left:1px solid #e2d5c1;padding-left:20px">`,
    `<p style="margin:0 0 16px;font-size:20px;line-height:1.4;color:#2a211d">${escapeHtml(options.heading)}</p>`,
    paragraphs,
    `<p style="margin:24px 0"><a href="${escapeHtml(options.action.url)}" style="display:inline-block;background:#4068a0;color:#fdfaf4;text-decoration:none;border-radius:3px;padding:10px 18px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px">${escapeHtml(options.action.label)}</a></p>`,
    footnotes,
    `</div>`,
    `</div>`,
    `</div>`,
    `</body>`,
    `</html>`,
  ].join("");
}

/**
 * How many times one message will ask Resend again before giving up.
 *
 * Three attempts covers the case this exists for — a burst that momentarily
 * outruns the account's requests-per-second — without turning a genuinely
 * broken deployment into a function that sits there retrying for a minute.
 */
const SEND_ATTEMPTS = 3;

/** The longest one attempt will wait before the next. */
const MAX_BACKOFF_MS = 8_000;

/** Sleeping in an action is legal and, for a rate limit, is the entire remedy. */
export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Doubling, for when the server said nothing about when to come back. */
function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS);
}

/**
 * One `retry-after`-shaped header value, in milliseconds, or `null`.
 *
 * Both spellings the RFC allows: a count of seconds, and an HTTP-date. The
 * date form is rarer but it is not exotic — a proxy in front of Resend is
 * entitled to emit it — and reading it as `NaN` used to mean the header was
 * quietly discarded and the caller waited an invented amount instead.
 */
function directedDelayMs(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? seconds * 1000 : null;
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) {
    return null;
  }
  // A date already in the past is a window that has already reopened.
  return Math.max(at - Date.now(), 0);
}

/**
 * How long to wait after a refusal that is worth asking again about, or `null`
 * for "do not wait, this attempt was the last one worth making".
 *
 * Resend answers a rate limit with the headers that say when the window
 * reopens, so the first choice is simply to believe it. `retry-after` is in
 * seconds; `ratelimit-reset` is Resend's own spelling of the same idea. Only
 * when neither is present or parseable does this fall back to doubling.
 *
 * Two things this gets wrong easily, and got wrong before:
 *
 *   - `headers.get()` answers `null` for a header that is not there, and
 *     `Number(null)` is `0`, which is finite and non-negative. So an absent
 *     `retry-after` used to be read as "come back immediately", the loop
 *     returned on its first pass, and neither `ratelimit-reset` nor the
 *     exponential fallback was reachable at all. A missing header has to be
 *     skipped before it is ever handed to `Number`.
 *   - Believing a *long* directed delay is worse than not retrying. `MAX_BACKOFF_MS`
 *     used to clamp `retry-after: 60` down to eight seconds, which guarantees
 *     the re-ask lands inside the window the server just told us to sit out —
 *     a wasted attempt, a wasted eight seconds, and the same refusal. If the
 *     server asks for longer than we are willing to wait, the honest answer is
 *     to stop now.
 */
export function retryAfterMs(
  response: Response,
  attempt: number,
): number | null {
  for (const header of ["retry-after", "ratelimit-reset"]) {
    const raw = response.headers.get(header);
    if (raw === null) {
      continue;
    }
    const directed = directedDelayMs(raw);
    if (directed === null) {
      continue;
    }
    if (directed > MAX_BACKOFF_MS) {
      return null;
    }
    // A little past the window rather than exactly on its edge: clocks
    // disagree, and arriving a moment early is arriving into the same 429.
    return directed + 250;
  }
  return backoffMs(attempt);
}

/**
 * Hand one message to Resend over its HTTP API.
 *
 * A `fetch` rather than the SDK: this is one POST with four fields, and the
 * Convex runtime is not somewhere to be dragging a Node client into. Resend's
 * own error body can quote the API key back, so it goes to the deployment log
 * and never into the ConvexError the browser sees.
 *
 * ## Why this retries
 *
 * Resend rate-limits per team — ten requests a second by default — and both of
 * Margin's fan-outs arrive as a burst. A note that names ten people schedules
 * ten actions at once, and each one is a POST. Without a retry the eleventh
 * request in a second comes back `429`, `deliverEmail` logs it and returns, and
 * a mention silently never arrives: the recipient sees it in the app and never
 * learns that the mail existed. That is the worst failure mode available here,
 * because nothing anywhere says it happened.
 *
 * So a `429`, and a `5xx` — Resend having a bad minute is the same shape of
 * problem — are waited out and asked again, up to `SEND_ATTEMPTS`. A `4xx` that
 * is not a rate limit is a bad address or a bad key, and asking twice is just
 * being told twice.
 *
 * Lives in `auth.ts` because this is where the Resend key is configured and
 * where the sign-in link is composed; `invites.ts` imports it rather than
 * standing up a second mail path with a second voice.
 */
export async function sendEmail(message: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new ConvexError(
      "Email isn't set up on this deployment, so nothing was sent.",
    );
  }

  const body = JSON.stringify({
    from: emailFrom(),
    to: [message.to],
    subject: message.subject,
    text: message.text,
    html: message.html,
  });

  // One key per *message*, minted outside the loop and sent on every attempt.
  //
  // This is what makes the retry above safe rather than merely hopeful. A
  // `502` or `504` from an edge in front of Resend does not mean the message
  // was refused — it means the answer was lost, and Resend may well have
  // accepted and queued it already. Re-asking without a key is how a labmate
  // gets mentioned once and mailed twice. With `Idempotency-Key` constant
  // across attempts, Resend replays the first outcome instead of sending
  // again, and a re-ask can only ever be a re-ask.
  const idempotencyKey = crypto.randomUUID();

  const failed = () =>
    new ConvexError(
      "We couldn't send that email. The address may be wrong, or mail delivery may be misconfigured.",
    );

  for (let attempt = 0; attempt < SEND_ATTEMPTS; attempt++) {
    const lastAttempt = attempt === SEND_ATTEMPTS - 1;

    let response: Response;
    try {
      response = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body,
      });
    } catch (caught) {
      // A `fetch` that throws is a network-level failure — DNS, a dropped
      // connection, a TLS handshake that went nowhere — and it is *more*
      // transient than any status code, not less. Retrying only HTTP statuses
      // meant the one failure mode that always deserves a second ask was the
      // one that never got it.
      if (!lastAttempt) {
        await pause(backoffMs(attempt));
        continue;
      }
      console.error(`Resend was unreachable: ${String(caught)}`);
      throw failed();
    }

    if (response.ok) {
      return;
    }

    const worthRetrying = response.status === 429 || response.status >= 500;
    if (worthRetrying && !lastAttempt) {
      const wait = retryAfterMs(response, attempt);
      // `null` is the server asking for longer than this action is willing to
      // wait. Falling through to the failure below is the point.
      if (wait !== null) {
        await pause(wait);
        continue;
      }
    }

    const detail = await response.text().catch(() => "");
    console.error(`Resend refused a message (${response.status}): ${detail}`);
    throw failed();
  }
}

/**
 * "Email me a sign-in link."
 *
 * Written out rather than built with the `Email` helper, which in 0.0.94 keeps
 * only `sendVerificationRequest` from the config it is handed — every other
 * field here would have been silently dropped.
 *
 * There is no `authorize`, and that is the point: the default one refuses a
 * token unless the same browser also re-states the email address, which turns
 * a link into a two-step form. Without it the token stands alone, so the link
 * works from the phone the mail was read on. The token Convex Auth mints is 32
 * characters over a 62-symbol alphabet — around 190 bits, well past the 24
 * characters the library asks for before a token may travel unaccompanied.
 */
/**
 * The sign-in link, as text and as HTML.
 *
 * Pure and exported so the shortest message Margin sends is also readable in a
 * test. It is the one that has to be plainest: somebody who asked for it three
 * seconds ago is looking for a link and nothing else, and somebody who did not
 * ask for it needs the second footnote to be the whole story.
 */
export function composeSignInEmail(url: string): {
  subject: string;
  text: string;
  html: string;
} {
  return {
    subject: "Your sign-in link for Margin",
    text: [
      "Open Margin",
      "",
      url,
      "",
      "The link signs you in and works for an hour. If you didn't ask for it, nothing has happened and you can ignore this.",
      "",
      "Margin",
    ].join("\n"),
    html: renderEmail({
      heading: "Open Margin",
      paragraphs: [
        "This link signs you in — no password to remember, nothing to type.",
      ],
      action: { label: "Sign in to Margin", url },
      footnotes: [
        "The link works for an hour, and only once.",
        "If you didn't ask for it, nothing has happened. You can ignore this.",
      ],
    }),
  };
}

const SignInLink: EmailConfig<DataModel> = {
  id: "sign-in-link",
  type: "email",
  name: "Sign-in link",
  from: emailFrom(),
  maxAge: SIGN_IN_LINK_TTL_S,
  async sendVerificationRequest({ identifier: email, url }) {
    // The same gate the invitation and the notification already pass through,
    // and the one path that was skipping it. `url` is built by Convex Auth
    // from its own base — `requireEnv("SITE_URL")` — which is satisfied by any
    // non-empty string, so a `SITE_URL` with no scheme produces a real message
    // whose only link is relative: nowhere at all from an inbox, and nothing
    // in the log to say so. Refuse out loud instead; the sign-in page shows
    // the error and the person can still use a password.
    if (siteUrl() === null) {
      throw new ConvexError(
        "This deployment's SITE_URL isn't a usable origin, so a sign-in link would point nowhere. Nothing was sent.",
      );
    }
    await sendEmail({ to: email, ...composeSignInEmail(url) });
  },
};

/**
 * Google, with the profile shaped the way the rest of the product reads it.
 *
 * `email_verified` is passed through honestly rather than assumed: Convex Auth
 * links a new sign-in to an existing user only when the address is verified,
 * and a Google account whose address is not verified is not evidence of
 * anything. `name` falls back to the local part of the address for the same
 * reason the password provider does — a member list and every annotation
 * byline read this field, and neither has anywhere to put a blank.
 */
const GoogleProvider = Google({
  clientId: process.env.AUTH_GOOGLE_ID?.trim(),
  clientSecret: process.env.AUTH_GOOGLE_SECRET?.trim(),
  profile(googleProfile) {
    const email =
      typeof googleProfile.email === "string"
        ? googleProfile.email.trim().toLowerCase()
        : undefined;
    const name =
      typeof googleProfile.name === "string" ? googleProfile.name.trim() : "";
    return {
      id: googleProfile.sub,
      email,
      name: name.length > 0 ? name : nameFromEmail(email),
      image:
        typeof googleProfile.picture === "string"
          ? googleProfile.picture
          : undefined,
      emailVerified: googleProfile.email_verified === true,
    };
  },
});

/** The byline of last resort: `ada@university.edu` reads as "ada". */
function nameFromEmail(email: string | undefined): string | undefined {
  if (email === undefined) {
    return undefined;
  }
  return email.split("@")[0] || email;
}

const providers: AuthProviderConfig[] = [
  Password<DataModel>({
    profile(params) {
      // `params` is whatever the sign-in form posted, so it is untrusted:
      // a request without an `email` field would otherwise throw a raw
      // TypeError on `.trim()` and surface as an opaque "Server Error".
      if (typeof params.email !== "string") {
        throw new ConvexError("Email is required");
      }
      const email = params.email.trim().toLowerCase();
      const name =
        typeof params.name === "string" ? params.name.trim() : undefined;
      return {
        email,
        // Fall back to the local part of the email so bylines are never blank.
        name: name && name.length > 0 ? name : email.split("@")[0] || email,
      };
    },
  }),
];

// `convex/auth.providers.test.ts` pins this registration predicate.
if (googleIsConfigured()) {
  providers.push(GoogleProvider);
}

if (emailIsConfigured()) {
  providers.push(SignInLink);
}

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers,
  callbacks: {
    /**
     * Give every new account a name.
     *
     * A sign-in link carries nothing but an address, so the user document it
     * creates has an `email` and no `name` — and the member list, the
     * presenter field and every annotation byline would render blank for the
     * one person who took the frictionless way in. Same fallback the password
     * and Google profiles use, applied once at the end so all three agree.
     *
     * Only ever fills a gap: a name that is already there is never rewritten.
     */
    async afterUserCreatedOrUpdated(ctx, { userId, existingUserId }) {
      const user = (await ctx.db.get(userId)) as Doc<"users"> | null;
      if (user === null) {
        return;
      }
      if (user.name === undefined || user.name.length === 0) {
        const name = nameFromEmail(user.email);
        if (name !== undefined) {
          await ctx.db.patch(userId, { name });
        }
      }

      // And give a *new* account somewhere to put a paper.
      //
      // Here rather than on the first render of `/app`, because this is the one
      // point all three doors pass through — password, Google, and the emailed
      // link — and because a provisioning the client asks for is a provisioning
      // a closed tab can interrupt. It shares the transaction that created the
      // account, so there is a person and a library or there is neither.
      //
      // `existingUserId` is the gate and it is not a nicety. This callback also
      // fires on every OAuth sign-in to an account that already exists, and
      // provisioning from there would hand a library — and a demo paper — to
      // people who have been using Margin for a year, on the next morning they
      // signed in. `null` means the account is being created right now, which
      // is the only moment a starting point is a starting point. Accounts made
      // before this shipped therefore have none, and giving them one is a
      // backfill somebody runs on purpose rather than something a sign-in does
      // behind their back.
      if (existingUserId === null) {
        await ensurePersonalLibrary(
          // The library types this callback against `AnyDataModel`; the ctx it
          // hands over is this deployment's own. Same cast, and the same
          // reason, as the `Doc<"users">` above.
          ctx as unknown as MutationCtx,
          userId,
        );
      }
    },
  },
});
