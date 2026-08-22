/**
 * The secret in a share URL.
 *
 * A share link is a capability: holding the string *is* the permission, the
 * way an invite code is. That puts one requirement above every other — the
 * token has to be unguessable at internet scale, where "guessing" means a
 * script trying millions of them against a public endpoint that, by design,
 * answers without asking anyone to sign in.
 *
 * So it is drawn from `crypto.getRandomValues` and nowhere else, and it is
 * emphatically **not** a document id. An id is short, structured, printed in
 * the URL of every authed page, and copied into bug reports; a share address
 * built out of one would make the artifact's own name its credential, and
 * would be unrevocable without deleting the artifact.
 *
 * This lives in `lib/` rather than in `convex/` so the shape can be tested
 * without the deployment — and so the one place that decides how much
 * randomness a share carries is a file with the arithmetic written in it.
 */

/**
 * 32 unambiguous lowercase symbols: no `l`, `o`, `0` or `1`.
 *
 * The same reasoning as `convex/invites.ts`'s alphabet, for a different
 * medium. An invite code is read aloud in a lab meeting; this is pasted into
 * Slack and typed off a projector — and the characters that get confused when
 * spoken are the ones that get confused when read in a sans-serif chat font.
 *
 * Exactly 32 symbols is also what makes the draw unbiased: a random byte maps
 * to one with `& 31`, five bits at a time, with no modulo skew to argue about.
 */
export const SHARE_TOKEN_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/**
 * 26 symbols × 5 bits = 130 bits of entropy.
 *
 * The floor is 128, the usual bar for a bearer secret that has to survive
 * being on the open web indefinitely. 26 is the first length that clears it,
 * and the URL it produces is still a thing a person can put in a message.
 */
export const SHARE_TOKEN_LENGTH = 26;

/** Bits of randomness in one token, stated so a test can hold the file to it. */
export const SHARE_TOKEN_BITS = 130;

/** What a token is allowed to look like, anchored end to end. */
export const SHARE_TOKEN_PATTERN = new RegExp(
  `^[${SHARE_TOKEN_ALPHABET}]{${SHARE_TOKEN_LENGTH}}$`,
);

/**
 * A fresh token.
 *
 * One random byte per symbol rather than five bits carved out of a stream:
 * the bytes are free and the version that packs them is the version somebody
 * eventually gets wrong. `& 31` discards the top three bits of each, which is
 * why 26 bytes buy 130 bits and not 208.
 */
export function mintShareToken(): string {
  const bytes = new Uint8Array(SHARE_TOKEN_LENGTH);
  crypto.getRandomValues(bytes);
  let token = "";
  for (const byte of bytes) {
    token += SHARE_TOKEN_ALPHABET.charAt(byte & 31);
  }
  return token;
}

/**
 * Whether a string could be a token this codebase minted.
 *
 * The public read path runs this before it touches the database. Not for
 * safety — an index read is an index read, and a miss is a miss — but so that
 * the endpoint spends nothing at all on the overwhelming majority of hostile
 * traffic, which is crawlers and scanners sending paths that were never
 * tokens.
 */
export function looksLikeShareToken(candidate: string): boolean {
  return SHARE_TOKEN_PATTERN.test(candidate);
}

/** The address a share is read at, relative to the site's own origin. */
export function sharePath(token: string): string {
  return `/s/${token}`;
}
