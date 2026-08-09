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
    msUntilOpen: Math.max(0, early - MAX_EARLY_START_MS),
  };
}

/** "about 25 hours away" — a distance, readable after "is still". */
export function awayProse(ms: number): string {
  const hours = Math.round(ms / 3_600_000);
  return hours < 48
    ? `about ${hours} hours away`
    : `about ${Math.round(hours / 24)} days away`;
}
