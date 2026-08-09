/**
 * When a scheduled session may be started, shared by the button that offers
 * it and the mutation that enforces it. One-sided on purpose: labs run late
 * all the time and a session started after its hour is still that session,
 * so only absurdly-early (more than a day) is refused.
 */
export const MAX_EARLY_START_MS = 24 * 60 * 60 * 1000;

export function startWindow(scheduledAt: number, now: number) {
  const early = scheduledAt - now;
  return {
    canStart: early <= MAX_EARLY_START_MS,
    // How long until the *button* unlocks, not how long until the meeting —
    // the two differ by a day, and zero once the window is open. For prose
    // about the session itself, pass `scheduledAt - now` to `awayProse`.
    msUntilOpen: Math.max(0, early - MAX_EARLY_START_MS),
  };
}

/**
 * "about 25 hours away" — a distance, readable after "is still".
 *
 * Takes the time until the *session*, `scheduledAt - now`. Not `msUntilOpen`:
 * that is the time until the start button unlocks, a day less, and feeding it
 * here would tell someone a meeting 25 hours out is "about 1 hour away".
 */
/**
 * How long a forward move stays undoable.
 *
 * An undo is a toast-length regret, not a time machine. Ten minutes is the
 * wrong row clicked in a list, the End button pressed while the room is still
 * arguing, the cancellation of the meeting that was actually next week's — all
 * of them noticed in the same breath. It is deliberately far too short to be a
 * general "put the lifecycle back" power: a lab that wants last month's session
 * live again wants a new session, and a lifecycle that can be walked backwards
 * at will is one nothing downstream can trust.
 *
 * Shared, like `MAX_EARLY_START_MS`, because the promise has two halves that
 * have to agree. `reopenSession` and `restoreSession` enforce it; the session
 * page offers it, and an offer that outlived the enforcement would be a button
 * whose only outcome is a refusal. The server is still the law — the client
 * reads this to decide what to *show*, never to decide what is allowed.
 */
export const UNDO_WINDOW_MS = 10 * 60 * 1000;

export function awayProse(msUntilSession: number): string {
  const hours = Math.round(msUntilSession / 3_600_000);
  if (hours < 48) {
    return `about ${hours} ${hours === 1 ? "hour" : "hours"} away`;
  }
  return `about ${Math.round(hours / 24)} days away`;
}
