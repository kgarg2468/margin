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
 * The flag that says "I am arriving here having just tried to sign out".
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
 */
const RECOVERY_PARAM = "reauth";
const RECOVERY_VALUE = "1";

/** The full destination recovery navigates to. */
export const SIGNIN_RECOVERY_PATH = `${SIGNIN_PATH}?${RECOVERY_PARAM}=${RECOVERY_VALUE}`;

export function isRecoveryDestination(searchParams: URLSearchParams): boolean {
  return searchParams.get(RECOVERY_PARAM) === RECOVERY_VALUE;
}

export async function recoverSession({
  signOut,
  navigate,
}: {
  signOut: () => Promise<unknown>;
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
  navigate(SIGNIN_RECOVERY_PATH);
}
