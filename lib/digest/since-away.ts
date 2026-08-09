/**
 * "Since you were away": when there is one, and what window it covers.
 *
 * The other two boundaries are events on a calendar — a session is two hours
 * out, a session has started — so a scheduled job can decide them. This one is
 * a fact about a *person*: they were gone, and now they are back. Nothing on
 * the server knows that until they show up, and Margin is not allowed to find
 * out any other way. The privacy constitution forbids read and dwell tracking,
 * so there is no session log, no last-active stamp and no heartbeat to poll —
 * the only honest trigger is the member arriving, and the only honest measure
 * of "away" is the cursor they last moved themselves by pressing "I'm caught
 * up".
 *
 * That makes the decision lazy and re-entrant: it runs on every arrival, most
 * of which should do nothing at all. This module is that decision, as pure
 * functions — no ctx, no clock, no database — so the three ways it can be
 * wrong (building for someone who never left, stacking a second digest on an
 * unread one, and reaching back further than the member's own history) are
 * unit tests rather than a paragraph of intent in a mutation.
 *
 * The digest itself is still `digest_gold5` from `./engine`. Nothing here
 * decides what goes in one; it decides *whether*, and *from when*.
 */

/**
 * How long a member has to have been gone before "since you were away" is a
 * true sentence.
 *
 * Twenty hours, not twenty-four. The unit that matters is not a day but a
 * *return*: somebody who caught up yesterday evening and opens the lab this
 * morning has been away overnight and wants the overnight, while somebody who
 * caught up at breakfast and comes back after lunch has not been away at all.
 * A flat 24h gets the second case right and the first one wrong — a member
 * with a stable morning habit sits at 23 hours and 50 minutes forever and is
 * never told anything. Twenty hours clears an ordinary night's gap and still
 * refuses every same-day revisit, which is the only pair of cases this
 * threshold has to separate.
 */
export const AWAY_MS = 20 * 60 * 60 * 1000;

/**
 * How long a built-but-unacknowledged digest stands before an arrival rebuilds
 * it in place.
 *
 * A member who has one waiting and has not pressed "I'm caught up" is shown
 * that one again rather than a second one beside it — an inbox that grows a
 * card per page load is not an inbox. But the same rule left alone forever
 * means a member who ignored the button in the morning is reading a stale
 * digest in the evening, with the afternoon's writing invisible behind a card
 * that will not refresh until they clear it. So a waiting digest older than an
 * hour is rebuilt over the top of itself: same row, same place in the inbox,
 * current contents. It cannot stack, and it cannot rot.
 *
 * An hour, because rebuilding costs a pool scan and a dashboard is a page a
 * person may open a dozen times a day, while an hour of the lab's writing is
 * about the smallest amount worth redrawing a card for.
 */
export const REBUILD_AFTER_MS = 60 * 60 * 1000;

/** What an arrival should do. */
export type SinceAwayPlan =
  /**
   * They were here recently enough that "since you were away" would be a lie.
   * The most common outcome by far, and the reason this decision is cheap.
   */
  | { kind: "skip"; reason: "still-here" }
  /** One is already waiting and still current; show them that one. */
  | { kind: "reuse"; reason: "already-waiting" }
  /**
   * Build over the window `[since, now]`. `rebuild` means there is a stale
   * waiting digest to write over rather than a new row to insert.
   */
  | { kind: "build"; since: number; rebuild: boolean };

/**
 * How far back this member's digest may reach.
 *
 * The floor is their own cursor: the moment they last said they were caught
 * up. Without one — they have never acknowledged a digest in this lab — the
 * fallback is the moment they joined, because everything written before that
 * is the lab's history rather than their delta, capped at `lookbackMs` so a
 * member who joined a year ago and is only now looking gets the recent
 * conversation instead of a year of it. The cap can only ever shrink a window.
 *
 * `lookbackMs` is a parameter rather than a constant here because the session
 * boundaries already answer this question with their own number, and two
 * copies of a policy is how they drift apart.
 */
export function sinceAwayWindow(input: {
  /** `lastSeenAt` of the member's lab-level cursor, or null if they have none. */
  cursorAt: number | null;
  /** When they joined this lab. */
  joinedAt: number;
  now: number;
  lookbackMs: number;
}): number {
  if (input.cursorAt !== null) {
    return input.cursorAt;
  }
  return Math.max(input.joinedAt, input.now - input.lookbackMs);
}

/**
 * The whole trigger decision, for one member arriving at one lab.
 *
 * Deliberately ordered cheapest-first, because the caller reads more of the
 * database for each step it survives: a waiting digest that is still current
 * answers the question without so much as looking at the ledger.
 *
 * Note what is *not* here: anything that writes. An arrival never moves a
 * cursor. The cursor is the member's own statement that they have read
 * something, and a cursor that moved because a page mounted would be exactly
 * the passive attention record the product promises not to keep — it would
 * also silently swallow the delta it claims to be reporting.
 */
export function planSinceAway(input: {
  now: number;
  joinedAt: number;
  cursorAt: number | null;
  /** Their unacknowledged since-away digest, if one is already waiting. */
  waiting: { generatedAt: number } | null;
  lookbackMs: number;
  awayMs?: number;
  rebuildAfterMs?: number;
}): SinceAwayPlan {
  const awayMs = input.awayMs ?? AWAY_MS;
  const rebuildAfterMs = input.rebuildAfterMs ?? REBUILD_AFTER_MS;

  if (
    input.waiting !== null &&
    input.now - input.waiting.generatedAt < rebuildAfterMs
  ) {
    return { kind: "reuse", reason: "already-waiting" };
  }

  const since = sinceAwayWindow({
    cursorAt: input.cursorAt,
    joinedAt: input.joinedAt,
    now: input.now,
    lookbackMs: input.lookbackMs,
  });

  // A window that reaches into the future is a cursor stamped ahead of the
  // clock; treat it as "no absence" rather than building a digest over an
  // empty span.
  if (input.now - since < awayMs) {
    return { kind: "skip", reason: "still-here" };
  }

  return { kind: "build", since, rebuild: input.waiting !== null };
}

/** The fields of a ledger row this module reads. */
export type LedgerBeat<PaperId extends string = string> = {
  type: string;
  at: number;
  paperId?: PaperId;
};

/**
 * The event types that mean somebody wrote something a digest could report.
 *
 * Creating a note and replying to one, and nothing else. An edit or a
 * visibility flip is a real fact about a paper, but the annotation underneath
 * it was written before the member's cursor and so cannot be in their delta —
 * counting it would spend one of the few paper slots below on a paper with
 * nothing new to say. A deletion is the same in reverse: there is less to
 * report, not more.
 */
const WRITING_EVENTS: ReadonlySet<string> = new Set([
  "annotation.created",
  "annotation.replied",
]);

/**
 * Which papers an arrival should actually read annotations for.
 *
 * A lab-wide digest cannot afford to scan the whole library — the pool it
 * builds is quadratic in collision detection and linear in database reads —
 * and it does not need to: a paper nobody has written on since the member's
 * cursor cannot contribute a line. So the ledger picks the field. The papers
 * come back most-recently-written-first and capped, which means an
 * over-the-limit lab contributes the papers its members are arguing about
 * right now rather than an arbitrary handful.
 *
 * Order is derived here rather than assumed from the caller's query, so the
 * same input always names the same papers in the same order.
 */
export function papersToScan<PaperId extends string>(
  beats: readonly LedgerBeat<PaperId>[],
  limit: number,
): PaperId[] {
  const newest = new Map<PaperId, number>();
  for (const beat of beats) {
    if (beat.paperId === undefined) continue;
    if (!WRITING_EVENTS.has(beat.type)) continue;
    const seen = newest.get(beat.paperId);
    if (seen === undefined || beat.at > seen) {
      newest.set(beat.paperId, beat.at);
    }
  }
  return [...newest.entries()]
    .sort((x, y) => (y[1] !== x[1] ? y[1] - x[1] : x[0] < y[0] ? -1 : 1))
    .slice(0, Math.max(0, limit))
    .map(([paperId]) => paperId);
}
