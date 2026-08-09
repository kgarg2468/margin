/**
 * Who has had a go at reading a paper's text layer, and who gets one next.
 *
 * This is bookkeeping that kept getting the same class of bug wrong, three
 * times, so it has been lifted out of the React hook that uses it and made a
 * plain function of its inputs. `useTextLayer` is now an adapter: it asks
 * `decide` what to do, does it, and reports back what happened. Every rule
 * about when extraction may start lives here, where it can be tested without
 * a browser.
 *
 * THE INVARIANT, which the three bugs were each a violation of:
 *
 *   An auth-failed attempt never blocks, and every auth recovery re-fires
 *   exactly one attempt.
 *
 * Read both halves. "Never blocks" is why a paper whose extraction died on a
 * missing or expired session is not left looking like a paper that has had
 * its turn — it has not, because a run that never reached the file formed no
 * opinion about the file. "Exactly one" is the other cliff: a rule that
 * retries whenever the last attempt failed on auth retries forever when the
 * session is genuinely broken, hammering the endpoint from a render loop.
 *
 * What makes both true at once is that a failed attempt records *which token
 * failed*. A different token is a recovery and gets its go; the same token is
 * the same failure and gets nothing. Neither branch needs to know how the
 * hook's effects are wired, which is precisely what went wrong before — the
 * previous fixes leaned on a dependency happening to change at the right
 * moment, and the third bug was a case where it didn't.
 */

/** `Id<"papers">` at the call site; a string here, so this module stays free of Convex. */
export type PaperId = string;

/** Where a paper's attempt at extraction has got to. */
export type Attempt =
  /** In flight right now. Nothing else may start one for this paper. */
  | { readonly kind: "running" }
  /**
   * Concluded with an opinion about the file — its text was extracted, or it
   * is genuinely unreadable. Either way the paper has had its turn.
   */
  | { readonly kind: "settled" }
  /**
   * Stopped by the session rather than by the file, while holding `token`.
   * Not a turn taken. Recorded only so that the *same* token does not
   * immediately try again and spin.
   */
  | { readonly kind: "auth-failed"; readonly token: string };

export type Attempts = ReadonlyMap<PaperId, Attempt>;

export const NO_ATTEMPTS: Attempts = new Map();

export type AttemptRequest = {
  readonly paperId: PaperId;
  /** `null` while Convex Auth is still settling, and after a sign-out. */
  readonly token: string | null;
  /** Somebody pressed the button, as opposed to a caller asking on its own. */
  readonly forced: boolean;
};

export type Decision =
  /** Go. Carries the token to go with, already narrowed out of `string | null`. */
  | { readonly kind: "fetch"; readonly token: string }
  /** Not yet, and record nothing — ask again when there is a session. */
  | { readonly kind: "wait"; readonly reason: "no-session" }
  /** No. */
  | {
      readonly kind: "skip";
      readonly reason: "running" | "settled" | "auth-unchanged";
    };

/**
 * The whole policy, as one total function.
 *
 * The caller re-asks whenever any input here changes — the token, or the
 * attempts map — which is what makes the answer trustworthy: there is no
 * state of the world in which extraction is owed and nobody asks again.
 */
export function decide(request: AttemptRequest, attempts: Attempts): Decision {
  const { paperId, token, forced } = request;

  // No session, no attempt, and — the first bug — nothing written down about
  // it. Fetching without a token gets a 401, and a 401 mistaken for a verdict
  // on the file marks a perfectly good PDF permanently unreadable.
  if (token === null) {
    return { kind: "wait", reason: "no-session" };
  }

  const attempt = attempts.get(paperId);
  if (attempt === undefined) {
    return { kind: "fetch", token };
  }

  // Ahead of the `forced` check on purpose: pressing the button twice should
  // not put two pdf.js runs over the same file, and this is also what stops a
  // token rotating mid-flight from starting a second one — the third bug.
  if (attempt.kind === "running") {
    return { kind: "skip", reason: "running" };
  }

  if (forced) {
    return { kind: "fetch", token };
  }

  if (attempt.kind === "auth-failed") {
    // Both halves of the invariant, in one comparison. A token that is not
    // the one that failed is a recovered session and is owed its attempt; the
    // token that failed is still failing and is owed nothing, or the retry
    // becomes a loop.
    return attempt.token === token
      ? { kind: "skip", reason: "auth-unchanged" }
      : { kind: "fetch", token };
  }

  return { kind: "skip", reason: "settled" };
}

/* -------------------------------------------------------------------------
 * Transitions
 *
 * Each returns a new map, because the caller holds these in React state and a
 * mutated map is a change nothing re-renders for. That is not an incidental
 * detail: a released attempt has to reach the effect that will retry it, and
 * it reaches it by being a new value.
 * ---------------------------------------------------------------------- */

/** An attempt is starting. Claim the paper so nothing else starts one. */
export function markRunning(attempts: Attempts, paperId: PaperId): Attempts {
  return new Map(attempts).set(paperId, { kind: "running" });
}

/** The attempt formed an opinion about the file, good or bad. The turn is over. */
export function markSettled(attempts: Attempts, paperId: PaperId): Attempts {
  return new Map(attempts).set(paperId, { kind: "settled" });
}

/**
 * The attempt was stopped by the session. The turn was never taken — record
 * the token that failed so a recovery is distinguishable from a repeat.
 */
export function markAuthFailed(
  attempts: Attempts,
  paperId: PaperId,
  token: string,
): Attempts {
  return new Map(attempts).set(paperId, { kind: "auth-failed", token });
}
