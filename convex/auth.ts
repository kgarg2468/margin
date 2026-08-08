import Google from "@auth/core/providers/google";
import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";
import type { AuthProviderConfig, EmailConfig } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { DataModel, Doc } from "./_generated/dataModel";

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
 */

/** An hour is long enough to walk to a laptop, short enough that a forwarded mail is stale. */
const SIGN_IN_LINK_TTL_S = 60 * 60;

const RESEND_ENDPOINT = "https://api.resend.com/emails";

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
  const key = process.env.RESEND_API_KEY;
  return typeof key === "string" && key.length > 0;
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
 * Margin's mail, in the same voice as Margin's pages: a sheet of paper with a
 * rule down the left, serif for what you read, and one thing to click.
 *
 * Deliberately hand-written inline CSS with no images, no tracking pixel, and
 * no remote assets. Partly because mail clients strip everything else, and
 * partly because a product that promises never to track what you read has no
 * business knowing whether you opened the envelope.
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
  ].join("");
}

/**
 * Hand one message to Resend over its HTTP API.
 *
 * A `fetch` rather than the SDK: this is one POST with four fields, and the
 * Convex runtime is not somewhere to be dragging a Node client into. Resend's
 * own error body can quote the API key back, so it goes to the deployment log
 * and never into the ConvexError the browser sees.
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

  const response = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: emailFrom(),
      to: [message.to],
      subject: message.subject,
      text: message.text,
      html: message.html,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error(`Resend refused a message (${response.status}): ${detail}`);
    throw new ConvexError(
      "We couldn't send that email. The address may be wrong, or mail delivery may be misconfigured.",
    );
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
const SignInLink: EmailConfig<DataModel> = {
  id: "sign-in-link",
  type: "email",
  name: "Sign-in link",
  from: emailFrom(),
  maxAge: SIGN_IN_LINK_TTL_S,
  async sendVerificationRequest({ identifier: email, url }) {
    await sendEmail({
      to: email,
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
    });
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

if (
  process.env.AUTH_GOOGLE_ID !== undefined &&
  process.env.AUTH_GOOGLE_SECRET !== undefined
) {
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
    async afterUserCreatedOrUpdated(ctx, { userId }) {
      const user = (await ctx.db.get(userId)) as Doc<"users"> | null;
      if (user === null || (user.name !== undefined && user.name.length > 0)) {
        return;
      }
      const name = nameFromEmail(user.email);
      if (name !== undefined) {
        await ctx.db.patch(userId, { name });
      }
    },
  },
});
