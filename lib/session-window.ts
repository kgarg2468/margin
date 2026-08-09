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
export function awayProse(msUntilSession: number): string {
  const hours = Math.round(msUntilSession / 3_600_000);
  if (hours < 48) {
    return `about ${hours} ${hours === 1 ? "hour" : "hours"} away`;
  }
  return `about ${Math.round(hours / 24)} days away`;
}
