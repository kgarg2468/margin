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
 * not the file. Only the opaque string.
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
  try {
    const store = storage();
    if (store === null) {
      return false;
    }
    store.setItem(PENDING_KEY, token);
    return true;
  } catch (error) {
    console.error(error);
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
 * A throw anywhere in here reads as "nothing pending", because the only
 * failure mode worth having is the one that imports nothing.
 */
export function consumeSharedPaper(
  storage: PendingImportStorageSource,
): string | null {
  try {
    const store = storage();
    if (store === null) {
      return null;
    }
    const token = store.getItem(PENDING_KEY);
    store.removeItem(PENDING_KEY);
    return token !== null && looksLikeShareToken(token) ? token : null;
  } catch (error) {
    console.error(error);
    return null;
  }
}
