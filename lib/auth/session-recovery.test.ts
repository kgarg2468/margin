import { describe, expect, it, vi } from "vitest";
import { SIGNIN_PATH, recoverSession } from "./session-recovery";

describe("session recovery", () => {
  it("navigates to the sign-in page only after sign-out settles", async () => {
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
    expect(navigate).toHaveBeenCalledWith(SIGNIN_PATH);
  });

  it("navigates when the backend session was already invalid", async () => {
    // What an expired session actually looks like from here: `signOut()`
    // swallows the backend's `auth:signOut` failure and clears the local
    // tokens regardless, so the promise resolves normally with a dead session
    // behind it. Recovery must not treat that as the happy path's opposite.
    const navigate = vi.fn();
    await recoverSession({ signOut: async () => undefined, navigate });
    expect(navigate).toHaveBeenCalledWith(SIGNIN_PATH);
  });

  it("navigates even when sign-out itself rejects", async () => {
    // Nothing above the boundary is left to catch this, and the reader is
    // already on the error page: a rejection that stopped the navigation would
    // leave them pressing a button that does nothing.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const navigate = vi.fn();

    await recoverSession({
      signOut: async () => {
        throw new Error("network down");
      },
      navigate,
    });

    expect(navigate).toHaveBeenCalledWith(SIGNIN_PATH);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
