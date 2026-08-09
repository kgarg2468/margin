import { describe, expect, it, vi } from "vitest";
import {
  SIGNIN_PATH,
  SIGNIN_RECOVERY_PATH,
  clearRehydratedSession,
  consumeRecoveryIntent,
  isRecoveryDestination,
  markRecoveryIntent,
  recoverSession,
} from "./session-recovery";

/** What the middleware sees when the browser asks for `destination`. */
function requested(destination: string): URL {
  return new URL(destination, "https://margin.test");
}

/**
 * One tab's `sessionStorage`, near enough.
 *
 * The property that matters is the one the real thing gets from the browser
 * and this gets from being a plain object: it is reachable only from this
 * origin. Nothing a foreign page can do writes into it.
 */
function storage(entries: Record<string, string> = {}) {
  const items = new Map(Object.entries(entries));
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
    size: () => items.size,
  };
}

/**
 * A tab the error boundary's recovery has just left, marker and all.
 *
 * Marked through the production helper rather than by writing a key here: a
 * test that spelled the marker out itself would keep passing if the two halves
 * of the handshake stopped agreeing on what it is.
 */
function recoveringTab() {
  const tab = storage();
  markRecoveryIntent(() => tab);
  return tab;
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
    const tab = storage();
    const navigate = vi.fn(() => {
      order.push("navigated");
    });

    const recovered = recoverSession({ signOut, storage: () => tab, navigate });
    await Promise.resolve();
    // The whole point of the helper: navigating while sign-out is still in
    // flight loads the sign-in page against tokens the client is about to
    // clear, and the reader lands back in a session they asked to leave.
    expect(navigate).not.toHaveBeenCalled();

    releaseSignOut();
    await recovered;
    expect(order).toEqual(["signed out", "navigated"]);
    expect(navigate).toHaveBeenCalledWith(SIGNIN_RECOVERY_PATH);
    // And the tab is carrying the one thing the far side will accept as proof
    // the reader asked for this. Written before the navigation, because after
    // it there is no `this` left to write from.
    expect(consumeRecoveryIntent(() => tab)).toBe(true);
  });

  it("marks the tab even when the injected sign-out rejects", async () => {
    // The failing sign-out is the case the far side exists for: the cookie
    // survives, the page rehydrates the dead session from it, and the arrival
    // has to clear it again. Skipping the marker here would leave that arrival
    // unauthorized and the reader holding the corpse.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const tab = storage();

    await recoverSession({
      signOut: async () => {
        throw new Error("network down");
      },
      storage: () => tab,
      navigate: vi.fn(),
    });

    expect(consumeRecoveryIntent(() => tab)).toBe(true);
    logged.mockRestore();
  });

  it("navigates even when the tab has no storage to mark", async () => {
    // A tab that cannot hold the marker still has to get out of the error
    // boundary — the navigation is what throws the poisoned query store away,
    // and that half works regardless. The far side simply will not sign out,
    // which is the right way to be wrong about a session.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const navigate = vi.fn();

    await recoverSession({
      signOut: async () => {},
      storage: () => {
        throw new Error("storage disabled");
      },
      navigate,
    });

    expect(navigate).toHaveBeenCalledWith(SIGNIN_RECOVERY_PATH);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
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
      storage: () => storage(),
      navigate,
    });

    expect(navigate).toHaveBeenCalledWith(SIGNIN_RECOVERY_PATH);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});

describe("the recovery intent the marker is", () => {
  it("is spendable once and then gone", async () => {
    // One-time on purpose. The marker is the whole authorization, so a marker
    // that survived being read would sit in the tab waiting for any later
    // arrival at `/signin?reauth=1` to spend it — and the arrival after the
    // reader's own is the one somebody else can arrange.
    const marked = storage();
    expect(markRecoveryIntent(() => marked)).toBe(true);

    expect(consumeRecoveryIntent(() => marked)).toBe(true);
    expect(consumeRecoveryIntent(() => marked)).toBe(false);
    expect(marked.size()).toBe(0);
  });

  it("is not something an unmarked or forged tab can spend", () => {
    expect(consumeRecoveryIntent(() => storage())).toBe(false);
    // A guessed key or a stale value is not the marker. Only the exact pair
    // `markRecoveryIntent` writes counts, so a leftover from something else
    // cannot stand in for a reader pressing the button.
    expect(consumeRecoveryIntent(() => storage({ reauth: "1" }))).toBe(false);
    expect(
      consumeRecoveryIntent(() =>
        storage({ "margin.auth.recovery-intent": "0" }),
      ),
    ).toBe(false);
  });

  it("reports failure rather than throwing when the tab has no storage", () => {
    // Safari in private browsing, a locked-down profile, an embedded webview:
    // reading `sessionStorage` can throw on access. Neither page has anything
    // above it to catch that, and both have to keep rendering — so the marker
    // is reported unwritable and unspent, never assumed.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const denied = () => {
      throw new Error("storage disabled");
    };

    expect(markRecoveryIntent(denied)).toBe(false);
    expect(consumeRecoveryIntent(denied)).toBe(false);
    expect(logged).toHaveBeenCalledTimes(2);
    logged.mockRestore();
  });
});

describe("clearing the session the recovery page was rehydrated with", () => {
  it("does not sign out an arrival no recovery on this origin marked", async () => {
    // The forced-logout break: `/signin?reauth=1` is a public URL, and the
    // middleware admits it. Any outside page can put a reader on it — a link,
    // a redirect, an iframe — so if the flag alone authorized the sign-out,
    // someone else's site could end a live session on demand. The flag says
    // where the reader is; only the marker says they asked to be here.
    const signOut = vi.fn(async () => {});
    const unmarked = storage();

    await clearRehydratedSession({
      searchParams: requested(SIGNIN_RECOVERY_PATH).searchParams,
      storage: () => unmarked,
      signOut,
    });

    expect(signOut).not.toHaveBeenCalled();
  });

  it("keeps the form usable when the tab has no storage to read", async () => {
    // Nothing above this to catch a throwing `sessionStorage`, and the form is
    // the only thing on screen that still works. So it resolves, and it
    // resolves without signing anyone out: an unreadable marker is not a
    // spent one.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const signOut = vi.fn(async () => {});

    await expect(
      clearRehydratedSession({
        searchParams: requested(SIGNIN_RECOVERY_PATH).searchParams,
        storage: () => {
          throw new Error("storage disabled");
        },
        signOut,
      }),
    ).resolves.toBeUndefined();

    expect(signOut).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("does not settle before the recovery sign-out settles", async () => {
    let releaseSignOut = () => {};
    let cleanupSettled = false;
    const signOut = () =>
      new Promise<void>((resolve) => {
        releaseSignOut = resolve;
      });

    const tab = recoveringTab();
    const clearing = clearRehydratedSession({
      searchParams: requested(SIGNIN_RECOVERY_PATH).searchParams,
      storage: () => tab,
      signOut,
    });
    void clearing.then(() => {
      cleanupSettled = true;
    });

    await Promise.resolve();
    expect(cleanupSettled).toBe(false);

    releaseSignOut();
    await clearing;
    expect(cleanupSettled).toBe(true);
  });

  it("signs out once when the sign-in page was reached by recovery", async () => {
    // The half the navigation cannot do. `/signin?reauth=1` is a fresh
    // document, so `ConvexAuthNextjsServerProvider` reads the cookie a failed
    // `auth:signOut` left on the wire and hands the token to `AuthProvider`,
    // which writes it back into storage on mount. The client the recovery
    // navigation was supposed to have emptied comes up holding the same dead
    // session — so arriving at the recovery destination has to clear it again,
    // this time from a page that is not being torn down mid-request.
    const signOut = vi.fn(async () => {});
    const tab = recoveringTab();
    const arrive = () =>
      clearRehydratedSession({
        searchParams: requested(SIGNIN_RECOVERY_PATH).searchParams,
        storage: () => tab,
        signOut,
      });

    await arrive();
    expect(signOut).toHaveBeenCalledTimes(1);

    // And once only. The marker went with the first arrival, so a reader who
    // stays on this page and reloads it — or is sent back to the same URL by
    // anything else — gets the form, not another sign-out.
    await arrive();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(tab.size()).toBe(0);
  });

  it("leaves every other way of reaching /signin signed in", async () => {
    // Mount cleanup is scoped to the one destination that admits its session
    // may be a corpse. The front door, an invite bouncing through, the sign-up
    // flow and the Google round trip all reach this page with tokens that are
    // either absent or good, and signing those out would be a way of logging
    // people out of the session they just created.
    for (const destination of [
      "/signin",
      "/signin?invite=ABC12345",
      "/signin?flow=signup",
      "/signin?flow=signup&invite=ABC12345",
      "/signin?reauth=0",
      "/signin?reauth=true",
    ]) {
      const signOut = vi.fn(async () => {});
      // Marked, deliberately: the marker alone is not permission either. A
      // reader who started a recovery and then navigated somewhere else on
      // this page is not asking to be signed out by whatever brought them
      // back — both halves have to agree, or neither counts.
      const tab = recoveringTab();

      await clearRehydratedSession({
        searchParams: requested(destination).searchParams,
        storage: () => tab,
        signOut,
      });

      expect(signOut, destination).not.toHaveBeenCalled();
      // Spent anyway, so it cannot be waiting for the next arrival.
      expect(tab.size(), destination).toBe(0);
    }
  });

  it("keeps the form usable when the clearing sign-out rejects", async () => {
    // There is no boundary above this one to catch it and nowhere left to
    // navigate to — the reader is already on the page they were sent to. An
    // unhandled rejection here would take out the sign-in form itself, which
    // is the one thing on screen that still works. Log it and leave the reader
    // their form; the credentials they type next mint a new token regardless.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const tab = recoveringTab();

    await expect(
      clearRehydratedSession({
        searchParams: requested(SIGNIN_RECOVERY_PATH).searchParams,
        storage: () => tab,
        signOut: async () => {
          throw new Error("network still down");
        },
      }),
    ).resolves.toBeUndefined();

    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
