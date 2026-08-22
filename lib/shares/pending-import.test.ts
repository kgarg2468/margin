import { describe, expect, it, vi } from "vitest";
import {
  consumeSharedPaper,
  rememberSharedPaper,
} from "./pending-import";
import { mintShareToken } from "./token";

/**
 * THE HAND-OFF THAT KEEPS A CAPABILITY OUT OF A URL.
 *
 * `docs/PLG.md` P7 carries a share token across a sign-up. The house rule it
 * exists to keep is that a capability credential is never forwarded through a
 * redirect chain, so the token goes into this tab and comes out on the far
 * side — and every property that makes that safe is checked here:
 *
 *   1. Only a token this codebase could have minted is ever stored or handed
 *      back. Anything else in that slot reads as nothing pending.
 *   2. Reading spends it. A token still sitting in the tab after it has been
 *      read is one the *next* arrival gets to spend.
 *   3. Every way storage can be unavailable or hostile fails closed — no
 *      throw reaches the caller, nothing is imported, and nothing that could
 *      not be cleared is ever believed.
 *   4. A hand-off that was never spent stops being one. A capability left in a
 *      tab is not allowed to sit there indefinitely waiting for whoever uses
 *      the machine next.
 */

/**
 * One tab's `sessionStorage`, near enough.
 *
 * The property that matters is the one the real thing gets from the browser
 * and this gets from being a plain object: it is reachable only from this
 * origin and only from this tab.
 */
function storage(entries: Record<string, string> = {}) {
  const items = new Map(Object.entries(entries));
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
    size: () => items.size,
    keys: () => [...items.keys()],
  };
}

/** A tab that hands over its store and then refuses one operation on it. */
function throwingOn(
  tab: ReturnType<typeof storage>,
  refused: "getItem" | "setItem" | "removeItem",
) {
  return {
    ...tab,
    [refused]: () => {
      throw new Error(`${refused} is not available in this tab`);
    },
  };
}

const TOKEN = mintShareToken();

describe("leaving the token behind", () => {
  it("stores a token the product could have minted", () => {
    const tab = storage();
    expect(rememberSharedPaper(() => tab, TOKEN)).toBe(true);
    expect(consumeSharedPaper(() => tab)).toBe(TOKEN);
  });

  it("refuses anything that is not shaped like one", () => {
    // Not a security boundary — `shares.importFromShare` resolves the token
    // against live rows and is the only thing that decides anything. This is so
    // a stray value can never be written under this key and then handed to a
    // mutation as though the product had put it there.
    const tab = storage();
    for (const candidate of ["", "not-a-token", `${TOKEN}x`, TOKEN.slice(1), "../../etc"]) {
      expect(rememberSharedPaper(() => tab, candidate), candidate).toBe(false);
    }
    expect(tab.keys()).toEqual([]);
  });

  it("says so when the tab has no storage at all", () => {
    // Private mode, an embedded webview, a profile with site data blocked. The
    // reader still gets where the link says they are going; they simply arrive
    // without the paper.
    expect(rememberSharedPaper(() => null, TOKEN)).toBe(false);
  });

  it("says so when the write itself throws", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const tab = storage();
    expect(rememberSharedPaper(() => throwingOn(tab, "setItem"), TOKEN)).toBe(
      false,
    );
    spy.mockRestore();
  });

  it("clears whatever was there when the write fails, rather than leaving it", () => {
    // A quota that filled between two presses leaves the *previous* press's
    // token standing, and that token names a different link. Whatever survives
    // a failed write is not what this press meant, so it goes.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const tab = storage();
    rememberSharedPaper(() => tab, TOKEN);
    const other = mintShareToken();

    expect(rememberSharedPaper(() => throwingOn(tab, "setItem"), other)).toBe(
      false,
    );
    expect(tab.keys()).toEqual([]);
    spy.mockRestore();
  });

  it("says so when reaching for the store is itself what throws", () => {
    // Reading `window.sessionStorage` throws in Safari's private mode, which is
    // why the store arrives as a thunk rather than a value.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      rememberSharedPaper(() => {
        throw new Error("access to storage is denied in this context");
      }, TOKEN),
    ).toBe(false);
    spy.mockRestore();
  });

  it("never puts the token in the console when it complains", () => {
    // A console line is not a place a capability may appear. The caught value
    // is deliberately dropped: an exception raised by a storage implementation
    // is one careless `toString` away from carrying the value that caused it.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const tab = storage();
    rememberSharedPaper(() => throwingOn(tab, "setItem"), TOKEN);
    consumeSharedPaper(() => throwingOn(tab, "getItem"));

    expect(spy).toHaveBeenCalled();
    expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN);
    for (const [...args] of spy.mock.calls) {
      expect(args.every((arg) => typeof arg === "string")).toBe(true);
    }
    spy.mockRestore();
  });
});

describe("spending it on the far side", () => {
  it("hands the token back exactly once", () => {
    // The whole discipline. A token left in the tab is one the arrival *after*
    // the reader's own spends — and that arrival is the one somebody else can
    // arrange.
    const tab = storage();
    rememberSharedPaper(() => tab, TOKEN);

    expect(consumeSharedPaper(() => tab)).toBe(TOKEN);
    expect(consumeSharedPaper(() => tab)).toBeNull();
    expect(tab.keys()).toEqual([]);
  });

  it("answers nothing for a tab that was never marked", () => {
    expect(consumeSharedPaper(() => storage())).toBeNull();
  });

  it("clears a value that fails the shape check, rather than leaving it", () => {
    // Removed before it is judged, so anything sitting under this key is either
    // a token or something with no business being mistaken for one — and either
    // way it is gone after one read.
    const tab = storage();
    rememberSharedPaper(() => tab, TOKEN);
    const [key] = tab.keys();
    tab.setItem(key ?? "", "https://evil.example/steal");

    expect(consumeSharedPaper(() => tab)).toBeNull();
    expect(tab.keys()).toEqual([]);
  });

  it("imports nothing when the tab has no storage", () => {
    expect(consumeSharedPaper(() => null)).toBeNull();
  });

  it("imports nothing when the read throws", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const tab = storage();
    rememberSharedPaper(() => tab, TOKEN);
    expect(consumeSharedPaper(() => throwingOn(tab, "getItem"))).toBeNull();
    spy.mockRestore();
  });

  it("imports nothing when the clearing throws", () => {
    // The delete sits between the read and the answer, so a store that refuses
    // it is a store that could hand the same token back forever. It gets
    // nothing instead — a value that could not be cleared is never judged.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const tab = storage();
    rememberSharedPaper(() => tab, TOKEN);
    expect(consumeSharedPaper(() => throwingOn(tab, "removeItem"))).toBeNull();
    spy.mockRestore();
  });

  it("clears the key even on the paths that answer nothing", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const tab = storage();
    rememberSharedPaper(() => tab, TOKEN);
    consumeSharedPaper(() => throwingOn(tab, "getItem"));
    // The read failed, so nothing was imported — and the token is gone anyway,
    // rather than waiting in the tab for the next arrival to try again.
    expect(tab.keys()).toEqual([]);
    spy.mockRestore();
  });

  it("imports nothing when reaching for the store throws", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      consumeSharedPaper(() => {
        throw new Error("access to storage is denied in this context");
      }),
    ).toBeNull();
    spy.mockRestore();
  });
});

describe("a hand-off that was never spent", () => {
  /** The envelope, as a tab that has been sitting open would hold it. */
  function marked(tab: ReturnType<typeof storage>, at: number) {
    rememberSharedPaper(() => tab, TOKEN);
    const key = tab.keys()[0] ?? "";
    tab.setItem(key, JSON.stringify({ token: TOKEN, at }));
    return key;
  }

  it("stops being a hand-off after half an hour", () => {
    // A tab left open over a weekend is not a sign-up in progress. Honouring an
    // unbounded hand-off means the next person at this machine spends it.
    const tab = storage();
    marked(tab, Date.now() - 31 * 60 * 1000);
    expect(consumeSharedPaper(() => tab)).toBeNull();
    expect(tab.keys()).toEqual([]);
  });

  it("still works inside the window", () => {
    const tab = storage();
    marked(tab, Date.now() - 5 * 60 * 1000);
    expect(consumeSharedPaper(() => tab)).toBe(TOKEN);
  });

  it("refuses a stamp from the future", () => {
    // A clock that moved backwards makes a fresh stamp look like a future one.
    // Losing a hand-off costs a press of Back; honouring an unbounded one costs
    // a capability, so the ambiguity is resolved the safe way.
    const tab = storage();
    marked(tab, Date.now() + 60 * 60 * 1000);
    expect(consumeSharedPaper(() => tab)).toBeNull();
  });

  it("refuses an envelope that is not one", () => {
    const tab = storage();
    const key = marked(tab, Date.now());
    for (const written of [
      TOKEN,
      "{",
      "null",
      "[]",
      JSON.stringify({ token: TOKEN }),
      JSON.stringify({ token: TOKEN, at: "now" }),
      JSON.stringify({ token: TOKEN, at: Number.NaN }),
      JSON.stringify({ token: "not-a-token", at: Date.now() }),
      JSON.stringify({ at: Date.now() }),
    ]) {
      tab.setItem(key, written);
      expect(consumeSharedPaper(() => tab), written).toBeNull();
      expect(tab.keys()).toEqual([]);
    }
  });
});

describe("what is kept, and what is not", () => {
  it("holds the opaque token and nothing else about the paper", () => {
    // Not the title, not the lab, not whether the file travelled. Everything
    // the redemption needs to know it asks the database for, at redemption
    // time, so there is nothing cached here that could be believed after it
    // stopped being true. The stamp beside it is there to take the token away
    // again, not to describe anything.
    const tab = storage();
    rememberSharedPaper(() => tab, TOKEN);
    expect(tab.keys()).toHaveLength(1);
    const written: unknown = JSON.parse(tab.getItem(tab.keys()[0] ?? "") ?? "");
    expect(Object.keys(written as object).sort()).toEqual(["at", "token"]);
    expect((written as { token: string }).token).toBe(TOKEN);
  });

  it("writes under a key namespaced to this product", () => {
    const tab = storage();
    rememberSharedPaper(() => tab, TOKEN);
    expect(tab.keys()[0]).toMatch(/^margin\./);
  });
});
