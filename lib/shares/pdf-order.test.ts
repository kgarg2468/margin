import { describe, expect, it, vi } from "vitest";
import { decideSharedPdf, isWriteConflict } from "./pdf-order";

/**
 * The order the shared-PDF route asks its questions in.
 *
 * Tested here rather than through `admitShare` because the ordering is the
 * property, and driving the counter directly proves nothing about *when* the
 * route reaches it. Each test below is a state the live route can genuinely be
 * in — a file missing from storage, a revocation landing mid-request — and
 * asserts both what the stranger receives and whether the link paid for it.
 */

type Delivery = { storageId: string; title: string };

function steps(overrides: {
  delivery?: Delivery | null;
  exists?: boolean;
  admit?: "ok" | "busy" | "dead";
  blob?: string | null;
}) {
  const calls: string[] = [];
  const decide = {
    lookup: async (token: string) => {
      calls.push(`lookup:${token}`);
      return overrides.delivery === undefined
        ? { storageId: "st1", title: "A paper" }
        : overrides.delivery;
    },
    exists: async () => {
      calls.push("exists");
      return overrides.exists ?? true;
    },
    admit: async () => {
      calls.push("admit");
      return overrides.admit ?? ("ok" as const);
    },
    download: async () => {
      calls.push("download");
      return overrides.blob === undefined ? "bytes" : overrides.blob;
    },
  };
  return { decide, calls };
}

describe("what a stranger gets from the shared PDF route", () => {
  it("serves the bytes when every gate passes", async () => {
    const { decide, calls } = steps({});
    const outcome = await decideSharedPdf("tok", decide);

    expect(outcome).toEqual({ status: 200, blob: "bytes", title: "A paper" });
    expect(calls).toEqual(["lookup:tok", "exists", "admit", "download"]);
  });

  it("asks for a token before anything else", async () => {
    const { decide, calls } = steps({});
    expect(await decideSharedPdf(null, decide)).toEqual({ status: 400 });
    // A request with no token is malformed, not a missing paper, and it must
    // not reach a database at all.
    expect(calls).toEqual([]);
  });

  it("gives one answer to every way a link can be dead", async () => {
    const { decide, calls } = steps({ delivery: null });
    expect(await decideSharedPdf("tok", decide)).toEqual({ status: 404 });
    // Never minted, revoked, a write-up rather than a paper, a paper with no
    // file: a prober must not be able to tell them apart, and none of them
    // costs the link any of its ceiling.
    expect(calls).toEqual(["lookup:tok"]);
  });

  it("does not spend the ceiling on a file that is not there", async () => {
    const { decide, calls } = steps({ exists: false });
    expect(await decideSharedPdf("tok", decide)).toEqual({ status: 404 });

    // The existence question is asked before admission so a paper whose stored
    // file has gone missing 404s without taking an increment — and it is asked
    // of metadata, so asking is cheap.
    expect(calls).toEqual(["lookup:tok", "exists"]);
    expect(calls).not.toContain("admit");
    expect(calls).not.toContain("download");
  });

  it("never moves bytes for a request it is going to refuse", async () => {
    // The finding, as an assertion. Existence and download used to be one
    // step, so a throttled request had already pulled the whole PDF down
    // before anything asked whether to serve it: 244 refusals in a live load
    // test were 244 full downloads, and the guard spent exactly the bandwidth
    // it exists to protect.
    for (const admit of ["busy", "dead"] as const) {
      const { decide, calls } = steps({ admit });
      const outcome = await decideSharedPdf("tok", decide);

      expect(outcome.status).toBe(admit === "busy" ? 429 : 404);
      expect(calls).toEqual(["lookup:tok", "exists", "admit"]);
      expect(calls, `${admit} must not download`).not.toContain("download");
    }
  });

  it("answers a revocation that lands mid-request with 404, not 429", async () => {
    const { decide } = steps({ admit: "dead" });

    // The race: the lookup found a live link, and it was taken down before
    // admission. "Busy" would tell that reader to come back to something that
    // is gone — and it would distinguish "revoked a moment ago" from "never
    // existed", which is the oracle the single 404 exists to close.
    expect(await decideSharedPdf("tok", decide)).toEqual({ status: 404 });
  });

  it("404s rather than crashing if storage loses the file after admission", async () => {
    const { decide, calls } = steps({ blob: null });
    expect(await decideSharedPdf("tok", decide)).toEqual({ status: 404 });
    expect(calls).toEqual(["lookup:tok", "exists", "admit", "download"]);
  });

  it("lets a real fault out rather than dressing it as busy", async () => {
    const boom = new Error("storage is on fire");
    await expect(
      decideSharedPdf("tok", {
        lookup: async () => ({ storageId: "st1", title: "A paper" }),
        exists: async () => {
          throw boom;
        },
        admit: vi.fn(),
        download: vi.fn(),
      }),
    ).rejects.toThrow(boom);
  });
});

describe("telling contention apart from a fault", () => {
  /**
   * Verbatim from a deployment under load, and that is the point of pasting it
   * here. The first matcher this route shipped looked for
   * "OptimisticConcurrencyControlFailure" and "write conflict" — neither of
   * which appears below — so a load test that should have produced 429s
   * produced 239 HTTP 500s instead. A matcher for a string nobody checked is a
   * matcher that does not match.
   */
  const OCC_MESSAGE =
    'Documents read from or written to the "shareRateWindows" table changed ' +
    "while this mutation was being run and on every subsequent retry. Another " +
    'call to this mutation changed the document with ID "pd71m50r1". ' +
    "See https://docs.convex.dev/error#1";

  it("recognises the message a real deployment throws", () => {
    expect(isWriteConflict(new Error(OCC_MESSAGE))).toBe(true);
  });

  it("leaves every other failure alone", () => {
    for (const other of [
      new Error("storage is on fire"),
      new Error("Server Error"),
      new Error("Uncaught ConvexError: That link is already gone."),
      "a string nobody wrapped",
      null,
    ]) {
      expect(isWriteConflict(other), String(other)).toBe(false);
    }
  });
});
