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
  navigate(SIGNIN_PATH);
}
