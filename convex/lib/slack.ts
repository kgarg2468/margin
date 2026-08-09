/**
 * What counts as a Slack destination, and whether a lab has one.
 *
 * Two leaf functions with no imports, in `convex/lib/` for the same reason
 * `authz.ts` is: `convex/slack.ts` reads a brief and a write-up in order to
 * compose them, so the artifact modules cannot import it back without a cycle
 * — and the one thing they each need from it is the predicate that decides
 * whether to schedule anything at all. That predicate lives here, where both
 * ends can reach it.
 */

/**
 * The only host Margin will post to.
 *
 * Exact, and compared against a *parsed* hostname rather than matched against
 * the front of the string. `"https://hooks.slack.com/".startsWith` is the
 * obvious spelling and it is wrong in both directions that matter:
 * `https://hooks.slack.com.evil.example/x` passes it, and so does
 * `https://evil.example/#https://hooks.slack.com/`. A parsed URL has exactly
 * one hostname and there is nothing to be clever about.
 */
const SLACK_WEBHOOK_HOST = "hooks.slack.com";

/**
 * A pasted webhook URL, or `null` if it is not one.
 *
 * The value is a credential — anyone holding it can post into the lab's
 * channel as the lab — so the checks are the ones that keep it from being
 * something else wearing a URL's clothes:
 *
 *   - **https, and only https.** `http://` to a credential endpoint is the
 *     credential in plaintext on the wire.
 *   - **`hooks.slack.com`, exactly.** Not a subdomain of it, not a host that
 *     merely contains it. An incoming webhook is issued on this host and
 *     nowhere else, so anything else is either a typo or a redirector
 *     somebody would very much like a lab's write-ups to pass through.
 *   - **No credentials in the authority.** `https://user:pass@hooks.slack.com/`
 *     parses, posts, and puts a second secret into the field.
 *   - **A path with something in it.** The bare origin is not a webhook; it is
 *     what a half-copied paste looks like, and it would fail silently at
 *     delivery time — hours later, in a log nobody is reading — instead of in
 *     front of the person who pasted it.
 *
 * Whitespace is trimmed because a URL copied out of Slack's own UI arrives with
 * a newline on it more often than not, and refusing that would be pedantry
 * rather than safety: unlike `siteUrl()`, nothing else in the system re-reads
 * this string and has to agree about it byte for byte.
 *
 * Everything else is preserved exactly. The path is Slack's opaque secret and
 * normalizing any part of it — a case fold, a stripped trailing slash — is a
 * way to hand back a URL that no longer works.
 */
export function normalizeWebhookUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") {
    return null;
  }
  if (parsed.hostname !== SLACK_WEBHOOK_HOST) {
    return null;
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return null;
  }
  if (parsed.pathname.replace(/\//g, "").length === 0) {
    return null;
  }
  return trimmed;
}

/**
 * Whether this lab posts to Slack.
 *
 * Presence of the field is the whole answer — see the note on
 * `labs.slackWebhookUrl` in `convex/schema.ts` for why there is no separate
 * flag. Takes `null` because every caller has just done a `db.get` and the
 * alternative is the same null check written out at four call sites.
 */
export function slackIsConfigured(
  lab: { slackWebhookUrl?: string } | null,
): boolean {
  return (
    lab !== null &&
    lab.slackWebhookUrl !== undefined &&
    lab.slackWebhookUrl.length > 0
  );
}
