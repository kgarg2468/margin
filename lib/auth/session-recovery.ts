/**
 * The order the two halves of "sign in again" have to happen in.
 *
 * Recovery is two moves that look independent and are not: clear the session,
 * then throw the JS context away. Doing them in the wrong order, or in
 * parallel, is the bug — the document navigation tears down the page mid
 * sign-out, and whether the tokens were cleared before the unload comes down
 * to how fast a fetch came back.
 *
 * So the rule lives here, with no React and no DOM in it, and the boundary in
 * `app/(app)/error.tsx` is left with a button and a pending flag. `navigate`
 * is passed in rather than reaching for `window` for the same reason: the
 * ordering is the thing worth being sure of, and it should be checkable
 * without a browser.
 */

/** Where an unrecoverable session sends the reader. */
export const SIGNIN_PATH = "/signin";

/**
 * The flag that tells the *middleware* where this request is going.
 *
 * `signOut()` swallows a failed `auth:signOut` request and then clears only
 * the browser's token storage — the auth *cookie* is cleared by the response
 * the `/api/auth` proxy writes, which a network failure means never arrives.
 * Recovery navigates anyway, on purpose, so it can navigate into a request the
 * middleware still reads as authenticated: `/signin` would be redirected
 * straight back to `/app`, into the session the reader just asked to leave.
 *
 * So the destination carries a flag, and the middleware skips its
 * authenticated-user redirect for exactly this one value. Everything else that
 * reaches `/signin` — the front door, an invite bouncing through, the sign-up
 * flow — is untouched, which is why `isRecoveryDestination` is an equality
 * check and not a "looks like it" one. The pathname stays `/signin`: this is
 * the same page, entered knowing the session behind it may be a corpse.
 *
 * What the flag is *not* is permission to sign anybody out. It is a query
 * parameter on a public URL: any page anywhere can put a reader on it, and if
 * arriving were enough, somebody else's site could end a live session by
 * linking to one. The flag says where the reader is; `RECOVERY_INTENT_KEY`
 * below is what says they asked to be here.
 */
const RECOVERY_PARAM = "reauth";
const RECOVERY_VALUE = "1";

/** The full destination recovery navigates to. */
export const SIGNIN_RECOVERY_PATH = `${SIGNIN_PATH}?${RECOVERY_PARAM}=${RECOVERY_VALUE}`;

export function isRecoveryDestination(searchParams: URLSearchParams): boolean {
  return searchParams.get(RECOVERY_PARAM) === RECOVERY_VALUE;
}

/**
 * The half of the recovery handshake an outside page cannot write.
 *
 * A note left in this tab, on this origin, immediately before the document
 * navigation — and read back once on the other side of it. `sessionStorage` is
 * partitioned by origin and scoped to the tab, so a link, a redirect or an
 * iframe from anywhere else arrives at `/signin?reauth=1` with nothing here to
 * find. That asymmetry is the entire security property: the URL is public and
 * the marker is not, so the sign-out needs both.
 *
 * It says one thing and carries nothing. There is no token in it, no identity,
 * nothing worth reading if it lingers — which it should not, because it is
 * spent on the first read. A marker that survived being read would sit in the
 * tab waiting for whatever arrival came next to spend it, and the arrival
 * after the reader's own is the one somebody else can arrange.
 */
const RECOVERY_INTENT_KEY = "margin.auth.recovery-intent";
const RECOVERY_INTENT_VALUE = "1";

/**
 * The shape of `sessionStorage` this needs, and no more of it.
 *
 * Taken as a thunk rather than the store itself because reading
 * `window.sessionStorage` is itself a throwing operation — Safari's private
 * mode, a profile with site data blocked, an embedded webview — and the guard
 * belongs here, once, rather than at each call site. It also keeps the DOM out
 * of this module: a test hands over a Map and the ordering above stays
 * checkable without a browser.
 */
export interface RecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type RecoveryStorageSource = () => RecoveryStorage | null;

/**
 * Leave the marker. Reports whether it is actually there.
 *
 * `false` is not a reason to stop recovering: the reader still needs the
 * navigation, and the page they land on is still the one with the form. It
 * only means the far side will not sign out on arrival — which, for a tab
 * with no storage, is the right way to be wrong.
 */
export function markRecoveryIntent(storage: RecoveryStorageSource): boolean {
  try {
    const store = storage();
    if (store === null) {
      return false;
    }
    store.setItem(RECOVERY_INTENT_KEY, RECOVERY_INTENT_VALUE);
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}

/**
 * Spend the marker, and say whether there was one to spend.
 *
 * Removed before it is judged, so a value that fails the check is gone too —
 * anything sitting under this key is either the marker or something that has
 * no business being mistaken for it. A throw anywhere in here reads as "no
 * intent", because the only failure mode worth having is the one that declines
 * to sign somebody out.
 */
export function consumeRecoveryIntent(storage: RecoveryStorageSource): boolean {
  try {
    const store = storage();
    if (store === null) {
      return false;
    }
    const marker = store.getItem(RECOVERY_INTENT_KEY);
    store.removeItem(RECOVERY_INTENT_KEY);
    return marker === RECOVERY_INTENT_VALUE;
  } catch (error) {
    console.error(error);
    return false;
  }
}

export async function recoverSession({
  signOut,
  storage,
  navigate,
}: {
  signOut: () => Promise<unknown>;
  storage: RecoveryStorageSource;
  navigate: (destination: string) => void;
}): Promise<void> {
  try {
    // `signOut()` already absorbs a failing `auth:signOut` and clears the
    // local tokens anyway — which is precisely the case that lands here, since
    // the session this is recovering from is usually the one the backend has
    // already stopped trusting. A resolved promise is not a promise the server
    // agreed with, and it does not need to be: the navigation below destroys
    // the client the stale tokens live in.
    await signOut();
  } catch (error) {
    // A rejection here is the transport failing, not the session refusing.
    // Nothing above this catches it — the reader is already inside the error
    // boundary — and stopping would leave them on a page whose only remaining
    // button does nothing. Log it and leave anyway.
    console.error(error);
  }
  // Last thing before the document goes away, and after the `await` rather
  // than before it: the marker is what the next page reads as "this reader
  // pressed the button", and it should not be sitting in the tab any longer
  // than the navigation it authorizes. Marked even when sign-out threw —
  // that is the case the far side exists to clean up.
  markRecoveryIntent(storage);
  navigate(SIGNIN_RECOVERY_PATH);
}

/**
 * The other half of the same failure, on the far side of the navigation.
 *
 * `recoverSession` clears the client it is leaving; this clears the one that
 * arrives. They are not redundant, because the thing that survives between
 * them is the cookie: when the `auth:signOut` request never reached
 * `/api/auth`, nothing wrote the clearing `Set-Cookie`, so the browser asks
 * for `/signin?reauth=1` still carrying it. `ConvexAuthNextjsServerProvider`
 * reads that cookie on the server and hands the token down as `serverState`,
 * and `AuthProvider`'s mount effect writes it straight back into
 * `localStorage`. The reader's fresh page comes up holding the dead session
 * they just asked to leave.
 *
 * Two things have to agree before that happens, and the flag is only one of
 * them. `/signin?reauth=1` is a public URL the middleware deliberately admits,
 * so any page anywhere can send a reader to it; on the flag alone, an outside
 * site could end a live session by linking to one. The other half is the
 * marker `recoverSession` left in this tab on this origin a moment ago, which
 * nothing cross-origin can write. So: the right destination *and* a marker
 * spent to reach it. Every other way into `/signin` — the front door, an
 * invite, the sign-up flow, Google's callback — has neither, and tokens that
 * are either absent or good, and clearing those would be a way of signing
 * people out of the session they came here to make.
 *
 * The marker is spent on every arrival rather than only the recovery one. It
 * is one-shot, and one left behind by a recovery the reader abandoned is one a
 * later link could spend for them.
 *
 * There is no `navigate` in this signature on purpose. The reader is already
 * where they were being sent; leaving again would be a loop, and the form on
 * this page is the thing they need. For the same reason a rejection stops
 * here — the sign-in they are about to attempt mints a new token whatever the
 * old one's fate, and an unhandled rejection would take the form down with it.
 *
 * The caller is expected to run this once per mount. Awaiting `signOut` is
 * also what keeps this from racing `AuthProvider`: React flushes a child's
 * effect before its parent's, so this starts first — and the `await` hands
 * control back before the provider's rehydration runs, which means the clear
 * lands after the write rather than under it.
 */
export async function clearRehydratedSession({
  searchParams,
  storage,
  signOut,
}: {
  searchParams: URLSearchParams;
  storage: RecoveryStorageSource;
  signOut: () => Promise<unknown>;
}): Promise<void> {
  const intended = consumeRecoveryIntent(storage);
  if (!intended || !isRecoveryDestination(searchParams)) {
    return;
  }
  try {
    await signOut();
  } catch (error) {
    console.error(error);
  }
}
