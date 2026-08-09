/**
 * What the command palette knows how to do with a typed string.
 *
 * Kept apart from the palette component on purpose: this is the only part of
 * ⌘K that can be wrong in a way a browser will not show you. A ranking that
 * quietly puts "Sign out" above "Go to Sessions" for `s` is not a rendering
 * bug, it is a bug you find by signing out. Nothing here imports React, so it
 * runs in the unit suite (`vitest.config.mts` explains the `.ts`-only rule).
 *
 * The matcher is a subsequence matcher rather than a full edit-distance one.
 * A palette is typed at speed and abandoned quickly — the query is a handful
 * of initials, not a misspelling — so what matters is that `gtl` finds
 * "Go to Library" and that nothing which is not in the string at all comes
 * back. Typo tolerance would cost the guarantee that every result visibly
 * contains what was typed, which is the property that makes a palette feel
 * predictable rather than clever.
 */

/**
 * How well `query` matches `target`, or `null` if it does not match at all.
 *
 * Case-insensitive; higher is better; the numbers themselves mean nothing
 * outside a comparison against another score for the same query.
 *
 * The two bonuses are the whole of the ranking, and both encode how people
 * actually type into a palette. A hit at the start of a word (+3 rather than
 * +1) is the initialism case — `gtl` is three word-starts and beats the same
 * three letters found scattered mid-word. A hit immediately after the previous
 * one (+2) is the prefix case: someone who typed `lib` meant a run of letters
 * they can see, not three separate landings.
 *
 * Greedy leftmost matching, which is what keeps this linear. It can miss the
 * best alignment in principle — for a target that repeats a letter, taking the
 * first occurrence may forfeit a consecutive run later — but backtracking to
 * find it costs more than a four-item list will ever repay.
 */
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  // An empty query is not "no match" — it is "no opinion", and every command
  // comes back at the same score so the list keeps its authored order.
  if (q.length === 0) return 0;
  let score = 0;
  let ti = 0;
  // Deliberately -2, not -1: at the first letter nothing can be "consecutive
  // with the previous hit", and -1 would make a match at index 0 look like one.
  let prevHit = -2;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    const wordStart = found === 0 || t[found - 1] === " ";
    score += wordStart ? 3 : 1;
    if (found === prevHit + 1) score += 2;
    prevHit = found;
    ti = found + 1;
  }
  return score;
}

/**
 * The commands that match `query`, best first; non-matches are dropped.
 *
 * `keywords` are matched but never shown — they are the words someone reaches
 * for that are not in the label ("logout" for "Sign out", "papers" for the
 * Library). A command scores as its best field rather than the sum of them, so
 * adding a synonym can only ever help a query that mentions it; it cannot
 * quietly float a command up the list for every other query too.
 *
 * Equal scores are broken by the shorter label, because the same number of
 * points spread over fewer characters is the closer match: `gtl` is three
 * word-start hits on both "Go to lab home" and "Go to Library" and scores 9 on
 * each, but it is the whole of "Go to Library"'s initials and only part of the
 * other's. Without this, an initialism that two commands share resolved by
 * declaration order, which is invisible to the person typing.
 *
 * The tiebreak is skipped when the query is empty, and that guard is the load-
 * bearing half of it. `fuzzyScore` returns 0 for every command in that case —
 * "no opinion", not "all equally good" — so sorting those by length would
 * reorder the list the palette shows the moment it opens, and the shortest
 * label in the app is "Sign out". Nobody's default first command is signing
 * out. With no query the authored order stands.
 *
 * `Array.prototype.sort` is stable, so anything still tied after both rules
 * keeps the order the caller declared.
 */
export function rankCommands<T extends { label: string; keywords?: string[] }>(
  query: string,
  items: T[],
): T[] {
  const tiebreak = query.length > 0;
  return items
    .map((item) => {
      const scores = [item.label, ...(item.keywords ?? [])]
        .map((s) => fuzzyScore(query, s))
        .filter((s): s is number => s !== null);
      return { item, score: scores.length ? Math.max(...scores) : null };
    })
    .filter((x): x is { item: T; score: number } => x.score !== null)
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return tiebreak ? a.item.label.length - b.item.label.length : 0;
    })
    .map((x) => x.item);
}

/**
 * How to write the palette's shortcut for a given `navigator.platform`.
 *
 * The palette itself listens for either modifier, so this only ever decides
 * what the hint chip *says* — and saying the wrong one is worse than saying
 * nothing: a Mac user who reads "Ctrl K" tries it, gets a kill-line in
 * whatever field they were in, and concludes the feature is broken.
 *
 * A pure function of the platform string rather than a `navigator` read, so
 * the branch is testable and so the caller is forced to do the read where it
 * belongs — inside an effect, after hydration. `navigator.platform` is
 * deprecated but is the only one of the three candidates that is not
 * Chromium-only (`userAgentData`) or a user-agent sniff, and the question
 * being asked of it — which glyph is on the modifier key — is one it still
 * answers correctly everywhere.
 */
export function shortcutLabel(platform: string): string {
  // Covers "MacIntel", "macOS", "iPhone", "iPad", "iPod" — every Apple
  // platform reports a string starting with one of these two.
  return /^(mac|i(phone|pad|pod))/i.test(platform) ? "⌘K" : "Ctrl K";
}
