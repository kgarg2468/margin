/**
 * A note's history, as a projection over the states it has been in.
 *
 * Storage keeps the smallest honest thing: one row per state an annotation has
 * left behind, each stamped with the moment it stopped being current, plus a
 * count of how many states there have ever been. Everything a reader wants
 * from that — when each state took effect, what the edit actually changed, how
 * much of the history the retention cap has eaten — is derived, here, once.
 *
 * Pure and clock-free like `lib/digest/engine.ts`, and for the same reason:
 * the interesting cases are the ones nobody can eyeball. A note edited sixty
 * times has lost its first ten states, and the panel must say so rather than
 * present the surviving tail as the beginning. An interval whose left edge was
 * dropped is genuinely unknown, and the difference between "unknown" and "the
 * note was created then" is the difference between a history and a fiction.
 *
 * ## The one rule this module cannot enforce, and does not pretend to
 *
 * Nothing here knows who may read any of it. A version's audience is the
 * parent annotation's, checked in `convex/annotationVersions.ts` at read time,
 * and by the time rows reach this function that question has been settled. If
 * you find yourself wanting a `visibility` field on `StoredVersion`, the
 * answer is upstream: the parent decides, always, and a copy of the decision
 * down here would be a copy that can go stale.
 */

import type { AnnotationType } from "../digest/engine";

/**
 * How many prior states a note keeps, mirroring `MAX_VERSIONS_KEPT` in
 * `convex/annotationVersions.ts`.
 *
 * Not imported from there because this module is ctx-free by construction and
 * `convex/` is not; it is here so a caller with no database in hand can still
 * reason about what a truncated history means.
 */
export const MAX_VERSIONS_KEPT = 50;

/** One state a note has left, exactly as `annotationVersions` stores it. */
export type StoredVersion = {
  /** Counting from 1. Never reused, never renumbered. */
  version: number;
  body: string;
  type: AnnotationType;
  /** When this state stopped being the current one. */
  replacedAt: number;
};

/** The state the note is in now, from the annotation row itself. */
export type CurrentState = {
  body: string;
  type: AnnotationType;
  createdAt: number;
  /**
   * How many states this note has had, counting this one. `undefined` — the
   * shape an unedited annotation has on the wire — means one.
   */
  versionCount?: number;
};

export type HistoryEntry = {
  version: number;
  body: string;
  type: AnnotationType;
  /**
   * When this state took effect.
   *
   * `null` when the state before it is no longer kept, which makes its left
   * edge genuinely unknown — the drop took the timestamp with it. The panel
   * renders that as an open interval rather than guessing.
   */
  from: number | null;
  /** When it was replaced; `null` for the state the note is in now. */
  until: number | null;
  current: boolean;
  /**
   * What the edit that *produced* this state changed, relative to the state
   * before it.
   *
   * `null` for the original — nothing preceded it to differ from — and for any
   * state whose predecessor has been dropped, where the honest answer is that
   * we cannot say. A version panel that reported "type changed" because the
   * row it was comparing against had been swept would be inventing an edit.
   */
  changed: { body: boolean; type: boolean } | null;
};

export type History = {
  /**
   * Newest first, the current state at the head.
   *
   * Newest first because that is the order the question is asked in: a reader
   * opens the history to find out what a note used to say, working back from
   * what it says now.
   */
  entries: HistoryEntry[];
  /** Every state the note has ever been in, including the ones no longer kept. */
  total: number;
  /** Prior states that are no longer kept. */
  droppedCount: number;
  /** The cap has taken something: what is on screen is not the whole history. */
  truncated: boolean;
};

/**
 * Assemble the history of one note.
 *
 * `versions` may arrive in any order and need not be complete at the front —
 * the retention cap drops the oldest rows, so a long-lived note's history
 * starts partway through. It is assumed complete at the *back*: every state
 * from the lowest surviving ordinal up to the current one is present, which is
 * the property the cap's drop-exactly-one-per-insert rule maintains. Where a
 * gap appears anyway, adjacency is checked per pair rather than assumed, so a
 * missing row costs a `changed` verdict and nothing else.
 */
export function buildHistory(
  current: CurrentState,
  versions: readonly StoredVersion[],
): History {
  const prior = [...versions].sort((a, b) => a.version - b.version);

  // The stored count is authoritative — it is written in the same transaction
  // as the rows — but it is not *trusted* over evidence. A retained ordinal
  // higher than the count implies states the count does not know about, and
  // under-reporting the total would make the panel claim a complete history it
  // does not have. Take whichever says there is more.
  const claimed = Math.max(1, Math.trunc(current.versionCount ?? 1));
  const highest = prior.at(-1)?.version ?? 0;
  const total = Math.max(claimed, highest + 1);

  // Oldest first while the intervals are chained, then reversed at the end.
  // Each state's left edge is the previous state's right edge, and the very
  // first state's is the note's own creation — the one timestamp that is not
  // some other state's replacement.
  const states: HistoryEntry[] = [];
  const chain: (StoredVersion | null)[] = [...prior, null];

  for (const [index, state] of chain.entries()) {
    const version = state?.version ?? total;
    const body = state?.body ?? current.body;
    const type = state?.type ?? current.type;

    // The state immediately before this one, only if it is genuinely the one
    // immediately before: an ordinal that does not sit at `version - 1` is a
    // hole in the history, and a hole is not a predecessor.
    const candidate = index > 0 ? prior[index - 1] : undefined;
    const previous =
      candidate !== undefined && candidate.version === version - 1
        ? candidate
        : undefined;

    states.push({
      version,
      body,
      type,
      from:
        previous !== undefined
          ? previous.replacedAt
          : version === 1
            ? current.createdAt
            : null,
      until: state?.replacedAt ?? null,
      current: state === null,
      changed:
        previous === undefined
          ? null
          : { body: previous.body !== body, type: previous.type !== type },
    });
  }

  const droppedCount = Math.max(0, total - 1 - prior.length);

  return {
    entries: states.reverse(),
    total,
    droppedCount,
    truncated: droppedCount > 0,
  };
}

/**
 * The line the card wears next to the timestamp: "3 versions".
 *
 * A count rather than "edited 2 times", because the object a reader is about
 * to open is a list of versions and the label should name it. Singular is
 * handled but never shown — the card only offers the control once there are
 * two.
 */
export function versionSummary(total: number): string {
  return `${total} version${total === 1 ? "" : "s"}`;
}

/**
 * What an edit did, in the fewest words that are still true: "Rewritten",
 * "Retyped", "Rewritten and retyped" — or nothing at all when the predecessor
 * is gone and the honest answer is that we do not know.
 *
 * A save that changed neither is possible (the composer does not stop you
 * pressing Save twice) and is reported as an edit that changed nothing, rather
 * than hidden. The row exists; a panel that silently dropped it would leave a
 * gap in the ordinals with no explanation.
 */
export function changeSummary(
  changed: HistoryEntry["changed"],
): string | null {
  if (changed === null) {
    return null;
  }
  if (changed.body && changed.type) {
    return "Rewritten and retyped";
  }
  if (changed.body) {
    return "Rewritten";
  }
  if (changed.type) {
    return "Retyped";
  }
  return "Saved unchanged";
}
