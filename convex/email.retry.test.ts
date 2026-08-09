import { afterEach, describe, expect, it, vi } from "vitest";
import { retryAfterMs, sendEmail } from "./auth";

/**
 * THE RETRY, PINNED.
 *
 * `convex/email.guard.test.ts` asserts what a message *is*. This file asserts
 * what happens when Resend says no, which is the half nobody sees: the whole
 * apparatus runs inside a scheduled action, its only trace is a line in a
 * deployment log, and every one of the bugs below shipped looking exactly like
 * working code.
 *
 * The one that matters most is the first. `headers.get()` answers `null` for a
 * header that is not there, `Number(null)` is `0`, and `0` is finite and
 * non-negative — so a `429` with no `retry-after` used to be read as "come
 * back immediately", and both the `ratelimit-reset` branch and the exponential
 * fallback were unreachable code for the whole life of the function. Nothing
 * about that is visible from the outside; the sends just fail slightly more
 * often than they should. Hence the assertions.
 */

const MESSAGE = {
  to: "ada@example.edu",
  subject: "Subject",
  text: "Text",
  html: "<!doctype html><html></html>",
};

/** A refusal with exactly the headers under test and nothing else. */
function refusal(status: number, headers: Record<string, string> = {}): Response {
  return new Response("nope", { status, headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// --- 1. What the server said, when it said anything ------------------------

describe("retryAfterMs", () => {
  it("falls back to doubling when no header directs it", () => {
    // The regression this file exists for: with no `retry-after` at all, the
    // answer must grow with the attempt rather than being a flat 250 ms.
    const bare = refusal(429);
    expect(retryAfterMs(bare, 0)).toBe(500);
    expect(retryAfterMs(bare, 1)).toBe(1_000);
    expect(retryAfterMs(bare, 2)).toBe(2_000);
    // And it stops growing at the ceiling.
    expect(retryAfterMs(bare, 10)).toBe(8_000);
  });

  it("believes retry-after in seconds", () => {
    expect(retryAfterMs(refusal(429, { "retry-after": "2" }), 0)).toBe(2_250);
    // Zero is a real answer — "the window has already reopened" — and is not
    // the same thing as an absent header.
    expect(retryAfterMs(refusal(429, { "retry-after": "0" }), 3)).toBe(250);
  });

  it("reads ratelimit-reset when retry-after is absent", () => {
    // Unreachable before: the absent `retry-after` returned first.
    expect(retryAfterMs(refusal(429, { "ratelimit-reset": "3" }), 0)).toBe(
      3_250,
    );
  });

  it("parses the HTTP-date form rather than discarding it", () => {
    const when = new Date(Date.now() + 4_000).toUTCString();
    const waited = retryAfterMs(refusal(429, { "retry-after": when }), 0);
    expect(waited).not.toBeNull();
    // Second-resolution date, so allow the rounding either way.
    expect(waited).toBeGreaterThan(3_000);
    expect(waited).toBeLessThan(5_500);
  });

  it("treats a date already past as no wait at all", () => {
    const when = new Date(Date.now() - 60_000).toUTCString();
    expect(retryAfterMs(refusal(429, { "retry-after": when }), 0)).toBe(250);
  });

  it("ignores an unparseable value and keeps looking", () => {
    expect(
      retryAfterMs(
        refusal(429, { "retry-after": "soon", "ratelimit-reset": "1" }),
        0,
      ),
    ).toBe(1_250);
    // Nothing usable anywhere: doubling, not a made-up small number.
    expect(retryAfterMs(refusal(429, { "retry-after": "soon" }), 1)).toBe(1_000);
  });

  it("refuses a wait longer than it is willing to serve", () => {
    // Clamping this to 8 s would put the re-ask back inside the window the
    // server just asked us to sit out: a guaranteed second refusal.
    expect(retryAfterMs(refusal(429, { "retry-after": "60" }), 0)).toBeNull();
    expect(
      retryAfterMs(refusal(429, { "ratelimit-reset": "30" }), 0),
    ).toBeNull();
  });
});

// --- 2. What the loop does with it -----------------------------------------

describe("sendEmail", () => {
  /** Stub `fetch` with a scripted sequence of outcomes, one per attempt. */
  function scriptFetch(steps: Array<Response | Error>) {
    const calls: RequestInit[] = [];
    let index = 0;
    const stub = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(init);
      const step = steps[Math.min(index, steps.length - 1)];
      index += 1;
      if (step instanceof Error) {
        throw step;
      }
      return step;
    });
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubGlobal("fetch", stub);
    return { calls, stub };
  }

  function headerOf(init: RequestInit, name: string): string | undefined {
    return (init.headers as Record<string, string>)[name];
  }

  it("sends one Idempotency-Key and repeats it on every attempt", async () => {
    // The blocker this pins: a 502 from an edge can arrive *after* Resend
    // accepted the message, so a retry without a shared key is a second
    // delivery. One key per message, not per attempt.
    const { calls } = scriptFetch([
      refusal(502, { "retry-after": "0" }),
      refusal(502, { "retry-after": "0" }),
      new Response(null, { status: 200 }),
    ]);

    await sendEmail(MESSAGE);

    expect(calls).toHaveLength(3);
    const keys = calls.map((init) => headerOf(init, "Idempotency-Key"));
    expect(keys[0]).toEqual(expect.any(String));
    expect(keys[0]?.length).toBeGreaterThan(8);
    expect(new Set(keys).size).toBe(1);
  });

  it("mints a different key for a different message", async () => {
    const { calls } = scriptFetch([new Response(null, { status: 200 })]);
    await sendEmail(MESSAGE);
    await sendEmail({ ...MESSAGE, to: "grace@example.edu" });
    expect(headerOf(calls[0], "Idempotency-Key")).not.toBe(
      headerOf(calls[1], "Idempotency-Key"),
    );
  });

  it("retries a fetch that throws", async () => {
    // A dropped connection is more transient than any status code, and used to
    // be the one failure that got no second ask.
    const { calls } = scriptFetch([
      new TypeError("fetch failed"),
      new Response(null, { status: 200 }),
    ]);
    await expect(sendEmail(MESSAGE)).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it("gives up on a fetch that keeps throwing", async () => {
    const { calls } = scriptFetch([new TypeError("fetch failed")]);
    await expect(sendEmail(MESSAGE)).rejects.toThrow(/couldn't send/);
    expect(calls).toHaveLength(3);
  });

  it("stops immediately when told to come back much later", async () => {
    // One attempt, no sleep, no doomed re-ask.
    const { calls } = scriptFetch([refusal(429, { "retry-after": "60" })]);
    await expect(sendEmail(MESSAGE)).rejects.toThrow(/couldn't send/);
    expect(calls).toHaveLength(1);
  });

  it("does not retry a plain 4xx", async () => {
    const { calls } = scriptFetch([refusal(422)]);
    await expect(sendEmail(MESSAGE)).rejects.toThrow(/couldn't send/);
    expect(calls).toHaveLength(1);
  });

  it("refuses to send at all without a key", async () => {
    const { calls } = scriptFetch([new Response(null, { status: 200 })]);
    vi.stubEnv("RESEND_API_KEY", "");
    await expect(sendEmail(MESSAGE)).rejects.toThrow(/isn't set up/);
    expect(calls).toHaveLength(0);
  });
});
