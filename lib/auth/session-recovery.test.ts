import { describe, expect, it, vi } from "vitest";
import {
  SIGNIN_PATH,
  SIGNIN_RECOVERY_PATH,
  isRecoveryDestination,
  recoverSession,
} from "./session-recovery";

/** What the middleware sees when the browser asks for `destination`. */
function requested(destination: string): URL {
  return new URL(destination, "https://margin.test");
}

describe("session recovery", () => {
  it("navigates to the recovery destination only after sign-out settles", async () => {
    const order: string[] = [];
    let releaseSignOut = () => {};
    const signOut = () =>
      new Promise<void>((resolve) => {
        releaseSignOut = () => {
          order.push("signed out");
          resolve();
        };
      });
    const navigate = vi.fn(() => {
      order.push("navigated");
    });

    const recovered = recoverSession({ signOut, navigate });
    await Promise.resolve();
    // The whole point of the helper: navigating while sign-out is still in
    // flight loads the sign-in page against tokens the client is about to
    // clear, and the reader lands back in a session they asked to leave.
    expect(navigate).not.toHaveBeenCalled();

    releaseSignOut();
    await recovered;
    expect(order).toEqual(["signed out", "navigated"]);
    expect(navigate).toHaveBeenCalledWith(SIGNIN_RECOVERY_PATH);
  });

  it("asks for a page the stale cookie cannot bounce it off", () => {
    // The failure this destination exists for: `signOut()` swallows a failed
    // `auth:signOut` request and clears only browser token storage, so when
    // the request never reached `/api/auth` the proxy never answered with the
    // cookie-clearing `Set-Cookie` and the auth cookie is still on the wire.
    // Recovery navigates regardless — so the URL it navigates to has to be one
    // the middleware will not redirect back to `/app`.
    const url = requested(SIGNIN_RECOVERY_PATH);
    expect(url.pathname).toBe(SIGNIN_PATH);
    expect(isRecoveryDestination(url.searchParams)).toBe(true);
  });

  it("leaves every other way of reaching /signin alone", () => {
    // The bypass is a fail-safe for one destination, not a hole in the
    // authenticated-user redirect. Anything else that lands on `/signin` — the
    // front door, an invite bouncing through, the sign-up flow — still gets
    // sent to `/app` when a session is genuinely live.
    for (const destination of [
      "/signin",
      "/signin?invite=ABC12345",
      "/signin?flow=signup",
      "/signin?flow=signup&invite=ABC12345",
    ]) {
      expect(isRecoveryDestination(requested(destination).searchParams)).toBe(
        false,
      );
    }
  });

  it("does not accept a value that merely looks like the recovery flag", () => {
    for (const destination of [
      "/signin?reauth",
      "/signin?reauth=",
      "/signin?reauth=0",
      "/signin?reauth=11",
      "/signin?reauth=1x",
      "/signin?reauth=+1",
      "/signin?reauth=true",
      "/signin?reauth=yes",
      "/signin?Reauth=1",
      "/signin?xreauth=1",
      "/signin?reauth2=1",
    ]) {
      expect(isRecoveryDestination(requested(destination).searchParams)).toBe(
        false,
      );
    }
  });

  it("navigates even when the injected sign-out rejects", async () => {
    // Not a model of `@convex-dev/auth`'s `signOut`, which suppresses its own
    // request failures and resolves — this pins the helper's own contract for
    // any sign-out handed to it. Nothing above the boundary is left to catch a
    // rejection, and the reader is already on the error page: stopping here
    // would leave them pressing a button that does nothing.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const navigate = vi.fn();

    await recoverSession({
      signOut: async () => {
        throw new Error("network down");
      },
      navigate,
    });

    expect(navigate).toHaveBeenCalledWith(SIGNIN_RECOVERY_PATH);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
