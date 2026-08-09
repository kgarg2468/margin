import { describe, expect, it } from "vitest";
import type { Attempts } from "./text-layer-attempts";
import {
  NO_ATTEMPTS,
  decide,
  markAuthFailed,
  markRunning,
  markSettled,
} from "./text-layer-attempts";

/**
 * The three races that shipped, each as a walk through the machine.
 *
 * All three were the same bug wearing different hats: extraction stopped for
 * a reason that had nothing to do with the PDF, and the bookkeeping recorded
 * it as though the PDF had had its turn. They were found one at a time in
 * review because the logic lived inside a React hook, where the test suite
 * could not reach it. It lives here now, so these are regressions rather than
 * a description of the current behaviour.
 *
 * The invariant under test, from the module's own header:
 *
 *   An auth-failed attempt never blocks, and every auth recovery re-fires
 *   exactly one attempt.
 */

const PAPER = "paper_abc";
const OTHER = "paper_xyz";

/** The caller asking on its own, as `PdfPanel`'s effect does. */
function asks(token: string | null, attempts: Attempts, paperId = PAPER) {
  return decide({ paperId, token, forced: false }, attempts);
}

/** The caller asking because somebody pressed the button. */
function presses(token: string | null, attempts: Attempts, paperId = PAPER) {
  return decide({ paperId, token, forced: true }, attempts);
}

describe("race 1: the token has not arrived yet", () => {
  /**
   * Extraction starts from an effect the moment a paper with no text layer
   * comes on screen, and on a cold load that can be a beat before Convex Auth
   * has a token. The original code fetched anyway, got a 401, and called
   * `markIngestFailed` — condemning a readable PDF permanently, since nothing
   * retries a paper that has already failed.
   */
  it("waits instead of attempting, and writes nothing down", () => {
    expect(asks(null, NO_ATTEMPTS)).toEqual({
      kind: "wait",
      reason: "no-session",
    });
  });

  it("attempts as soon as a session exists", () => {
    // The crucial half: nothing was recorded while waiting, so the paper is
    // still a stranger to the map and gets a clean first go.
    expect(asks("t1", NO_ATTEMPTS)).toEqual({ kind: "fetch", token: "t1" });
  });

  it("waits even when somebody presses the button", () => {
    // No token means no possible attempt, forced or not. The hook says so on
    // screen; what it must not do is spend the paper's turn.
    expect(presses(null, NO_ATTEMPTS)).toEqual({
      kind: "wait",
      reason: "no-session",
    });
  });
});

describe("race 2: the token expires after the attempt started", () => {
  /**
   * The paper was already claimed when the session died, so the claim
   * outlived the attempt: every later ask hit the guard and returned early,
   * and the text layer waited for a remount or for somebody to find the
   * button.
   */
  it("does not leave the failed attempt blocking a recovered session", () => {
    let attempts = markRunning(NO_ATTEMPTS, PAPER);
    attempts = markAuthFailed(attempts, PAPER, "t1");

    expect(asks("t2", attempts)).toEqual({ kind: "fetch", token: "t2" });
  });

  it("does not retry on the very token that just failed", () => {
    // The other cliff. Retrying whenever the last attempt failed on auth is a
    // render loop against the endpoint when the session is genuinely broken.
    const attempts = markAuthFailed(NO_ATTEMPTS, PAPER, "t1");

    expect(asks("t1", attempts)).toEqual({
      kind: "skip",
      reason: "auth-unchanged",
    });
  });

  it("still lets somebody press the button on the same token", () => {
    const attempts = markAuthFailed(NO_ATTEMPTS, PAPER, "t1");

    expect(presses("t1", attempts)).toEqual({ kind: "fetch", token: "t1" });
  });
});

describe("race 3: the token rotates while a fetch is in flight", () => {
  /**
   * The one that survived the second fix. A refreshed token re-fires the
   * caller's effect while the previous attempt is still running; that ask is
   * correctly skipped, and the stale request then fails. The fix at the time
   * released the paper — but the release happened after the last thing any
   * dependency was going to do, so nothing asked again.
   */
  it("does not start a second run over the same file", () => {
    const attempts = markRunning(NO_ATTEMPTS, PAPER);

    expect(asks("t2", attempts)).toEqual({ kind: "skip", reason: "running" });
    // Not even on a press: two concurrent pdf.js runs over one paper is the
    // thing being prevented, and who asked does not change that.
    expect(presses("t2", attempts)).toEqual({
      kind: "skip",
      reason: "running",
    });
  });

  it("attempts again once the stale request reports its auth failure", () => {
    let attempts = markRunning(NO_ATTEMPTS, PAPER);
    // The in-flight request was holding t1; the current session is t2.
    attempts = markAuthFailed(attempts, PAPER, "t1");

    // The release is itself the state change that re-fires the effect, so no
    // dependency has to happen to change at the right moment.
    expect(asks("t2", attempts)).toEqual({ kind: "fetch", token: "t2" });
  });

  it("re-fires exactly one attempt, not a stream of them", () => {
    let attempts = markRunning(NO_ATTEMPTS, PAPER);
    attempts = markAuthFailed(attempts, PAPER, "t1");

    const retry = asks("t2", attempts);
    expect(retry).toEqual({ kind: "fetch", token: "t2" });

    // Acting on it claims the paper, so every ask that follows — and there is
    // one per render while the fetch runs — is refused.
    attempts = markRunning(attempts, PAPER);
    expect(asks("t2", attempts)).toEqual({ kind: "skip", reason: "running" });
    expect(asks("t3", attempts)).toEqual({ kind: "skip", reason: "running" });
  });

  it("bounds a session that keeps failing", () => {
    // t1 fails, t2 arrives and is tried, t2 fails too. There is nothing left
    // to try until a third token exists, and the machine says so rather than
    // spinning.
    let attempts = markAuthFailed(NO_ATTEMPTS, PAPER, "t1");
    expect(asks("t2", attempts)).toEqual({ kind: "fetch", token: "t2" });

    attempts = markAuthFailed(markRunning(attempts, PAPER), PAPER, "t2");
    expect(asks("t2", attempts)).toEqual({
      kind: "skip",
      reason: "auth-unchanged",
    });
  });
});

describe("a paper that has genuinely had its turn", () => {
  it("is not read again by a caller asking on its own", () => {
    const attempts = markSettled(NO_ATTEMPTS, PAPER);

    // Extraction is idempotent but not cheap, and the callers are reactive.
    expect(asks("t1", attempts)).toEqual({ kind: "skip", reason: "settled" });
    // Not even on a new session: the file was read, or it was unreadable, and
    // neither verdict changes because a token did.
    expect(asks("t2", attempts)).toEqual({ kind: "skip", reason: "settled" });
  });

  it("is read again when somebody presses the button", () => {
    const attempts = markSettled(NO_ATTEMPTS, PAPER);

    expect(presses("t1", attempts)).toEqual({ kind: "fetch", token: "t1" });
  });
});

describe("papers are bookkept independently", () => {
  it("does not let one paper's attempt speak for another's", () => {
    let attempts = markRunning(NO_ATTEMPTS, PAPER);
    attempts = markAuthFailed(attempts, PAPER, "t1");

    expect(asks("t1", attempts, OTHER)).toEqual({
      kind: "fetch",
      token: "t1",
    });
    expect(asks("t1", attempts, PAPER)).toEqual({
      kind: "skip",
      reason: "auth-unchanged",
    });
  });
});

describe("transitions", () => {
  it("leave the map they were given alone", () => {
    // The caller holds these in React state, where mutating in place is a
    // change nothing re-renders for — and a release that nothing re-renders
    // for is race 3 all over again.
    const before = markRunning(NO_ATTEMPTS, PAPER);
    const after = markSettled(before, PAPER);

    expect(before.get(PAPER)).toEqual({ kind: "running" });
    expect(after.get(PAPER)).toEqual({ kind: "settled" });
    expect(after).not.toBe(before);
  });
});
