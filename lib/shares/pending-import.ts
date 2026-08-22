import { looksLikeShareToken } from "./token";

/**
 * How a share token survives a sign-up without ever being in a URL.
 *
 * `docs/PLG.md` P7 is the join between rung 0 and rung 1: somebody reads a
 * lab's margin with no account, decides they want the paper, and comes out the
 * far side of a sign-up needing to name the link they arrived on. The link is
 * the only thing they have, and the token in it is a capability.
 *
 * So it does not travel the way the invite code does. An invite code rides
 * `/signin?invite=CODE` and back, which is safe because it is a one-shot code
 * for one lab that the server can refuse; a share token is a bearer credential
 * for a page anyone holding it can read, indefinitely, and forwarding one
 * through a sign-up writes it into the redirect chain, the `Referer` of every
 * hop, the OAuth provider's logs, and the browser history of a machine that
 * may not be the reader's. The house rule is simply that capability
 * credentials are not forwarded across redirects, and this is how that rule is
 * kept while the reader still ends up with their paper.
 *
 * Instead it is left in this tab, on this origin, and spent on the other side
 * — the same asymmetry `lib/auth/session-recovery.ts` relies on, and for a
 * related reason: `sessionStorage` is partitioned by origin and scoped to the
 * tab, so nothing linked, framed or redirected from anywhere else can plant a
 * value here or read one.
 *
 * **What it is not.** It is not a claim about anything. The redemption
 * (`shares.importFromShare`) re-resolves the token against live rows and
 * re-checks every gate the public page checks — revocation included — so the
 * worst a tampered value can do is name a link, which is what a link is for.
 * Nothing else about the paper is carried here: not the title, not the lab,
 * not the file. Only the opaque string, and the minute it was left — which is
 * there to take it away again, not to describe anything.
 *
 * **The one flow it does not cover, stated rather than hidden.** A sign-in
 * *link* arrives by email, and a mail client opens it in a new tab — a new
 * `sessionStorage`, with nothing in it. That reader signs in fine and simply
 * arrives without the paper, which is the right way for this to fail: no
 * error, no half-state, and the share page is still one press of Back away.
 * The alternative is `localStorage`, which would survive the new tab by
 * leaving a capability on the device until something spent it, and that is a
 * worse trade than losing the hand-off on one of three doors.
 */

/** Where the token waits. Namespaced like every other key this app writes. */
const PENDING_KEY = "margin.share.pending-import";

/**
 * How long a hand-off stays a hand-off.
 *
 * A token written here is meant to be spent on the far side of one sign-up,
 * which is a minute or two of typing. Everything past that is a value that got
 * stranded — the reader thought better of it and went to read something else,
 * the tab sat open over a weekend, a sign-up was abandoned halfway. A stranded
 * capability that never expires is one the *next* thing to reach `/app` in this
 * tab spends, which could be a completely different person at the same desk.
 *
 * Thirty minutes is long enough that no genuine sign-up is ever cut off by it —
 * including the slowest of the three doors, where somebody leaves to fetch a
 * password out of a manager — and short enough that a forgotten tab is not
 * carrying a live link by the afternoon.
 */
const PENDING_TTL_MS = 30 * 60 * 1000;

/**
 * What is actually written under the key: the token, and when it was left.
 *
 * A bare string would have been simpler and could not be aged. The stamp is
 * what turns "spent once" into "spent once, and soon" — see `PENDING_TTL_MS`.
 */
type PendingEnvelope = { token: string; at: number };

/**
 * The shape of `sessionStorage` this needs, and no more of it.
 *
 * Taken as a thunk rather than the store itself for the reason
 * `RecoveryStorage` is: reading `window.sessionStorage` is itself a throwing
 * operation — Safari's private mode, a profile with site data blocked, an
 * embedded webview — and the guard belongs here, once, rather than at each
 * call site. It also keeps the DOM out of this module, so the hand-off is
 * checkable without a browser.
 */
export interface PendingImportStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type PendingImportStorageSource = () => PendingImportStorage | null;

/**
 * Leave the token for the far side of the sign-up. Says whether it is there.
 *
 * `false` is not a reason to stop: the reader is still going to `/app` and the
 * link they pressed still works. It only means they will arrive without the
 * paper, which for a tab with no storage is the right way to be wrong.
 *
 * Refuses anything that is not shaped like a token this codebase mints. Not as
 * a security boundary — the server's own resolution is that — but so a stray
 * value can never be written under this key and then handed to a mutation as
 * though the product had put it there.
 */
export function rememberSharedPaper(
  storage: PendingImportStorageSource,
  token: string,
): boolean {
  if (!looksLikeShareToken(token)) {
    return false;
  }
  const store = openStorage(storage);
  if (store === null) {
    return false;
  }
  const envelope: PendingEnvelope = { token, at: Date.now() };
  try {
    store.setItem(PENDING_KEY, JSON.stringify(envelope));
    return true;
  } catch {
    // A write that failed — a full quota, a store that turned read-only
    // mid-session — may have left the *previous* value standing, and that
    // value is a token for a different link. Whatever is under this key now is
    // not what this press meant, so it goes.
    forget(store);
    complain();
    return false;
  }
}

/**
 * Take the token, and leave nothing behind.
 *
 * Removed before it is judged, so a value that fails the shape check is gone
 * too — anything sitting under this key is either a token or something with no
 * business being mistaken for one.
 *
 * One-shot, and that is the whole discipline. A token left in the tab after it
 * has been read is one the *next* arrival spends, and the arrival after the
 * reader's own is the one somebody else can arrange. It also means a
 * redemption that fails on the wire loses the hand-off rather than retrying it
 * forever — the same trade, and the recovery is a press of Back to a page that
 * still has the link on it.
 *
 * Every failure converges on the same answer — nothing pending — and, where it
 * can, on the same *state*: a store that would not give the value up is asked
 * to drop it anyway. **A value that could not be cleared is never judged**,
 * because judging it favourably would hand a capability to a tab that has just
 * demonstrated it cannot be made to forget one.
 */
export function consumeSharedPaper(
  storage: PendingImportStorageSource,
): string | null {
  const store = openStorage(storage);
  if (store === null) {
    return null;
  }

  let raw: string | null;
  try {
    raw = store.getItem(PENDING_KEY);
  } catch {
    forget(store);
    complain();
    return null;
  }

  try {
    store.removeItem(PENDING_KEY);
  } catch {
    forget(store);
    complain();
    return null;
  }

  return openEnvelope(raw);
}

/**
 * The stored string, if it is still a live hand-off this module wrote.
 *
 * Three ways to be absent and one to be present, and they are deliberately
 * indistinguishable to the caller: nothing there, something there that is not
 * an envelope, and an envelope past its life. The last of those is the one
 * worth naming — a clock that moved backwards makes a fresh stamp look like a
 * future one, and a future stamp is treated as stale rather than trusted,
 * because losing a hand-off costs a press of Back and honouring an unbounded
 * one costs a capability.
 */
function openEnvelope(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const { token, at } = parsed as Partial<PendingEnvelope>;
  if (typeof token !== "string" || !looksLikeShareToken(token)) {
    return null;
  }
  if (typeof at !== "number" || !Number.isFinite(at)) {
    return null;
  }
  const age = Date.now() - at;
  return age >= 0 && age <= PENDING_TTL_MS ? token : null;
}

/** The store, or `null` — reaching for one is itself a throwing operation. */
function openStorage(
  storage: PendingImportStorageSource,
): PendingImportStorage | null {
  try {
    return storage();
  } catch {
    complain();
    return null;
  }
}

/** Drop whatever is under the key, and never mind whether it worked. */
function forget(store: PendingImportStorage): void {
  try {
    store.removeItem(PENDING_KEY);
  } catch {
    // Nothing left to try. The caller has already decided to import nothing,
    // which is the outcome this was protecting.
  }
}

/**
 * Say that the hand-off broke, and say *only* that.
 *
 * The caught value is deliberately not logged. What is being handled here is a
 * failure to read or write a share token, and an exception raised by a storage
 * implementation is one careless `toString` away from carrying the value that
 * caused it. A console line is not a place a capability may appear, so this
 * one carries no value at all — the message names the module, which is
 * everything a person debugging it needs and nothing an onlooker can use.
 */
function complain(): void {
  console.error("margin: the share hand-off could not use session storage.");
}
