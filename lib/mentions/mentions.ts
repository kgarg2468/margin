/**
 * Mentions, as text and as structure.
 *
 * A mention in Margin is two things at once, and keeping them separate is the
 * whole design:
 *
 * 1. **What the reader sees** — plain prose. "@Sara Chen" is characters in the
 *    body, nothing more. No markup, no `<@user_1a2b>` sigil leaking into a
 *    quote, no parser standing between an author and their own sentence. A note
 *    exported, searched, or read in an email is the note as written.
 * 2. **Who it names** — a list of user ids the author *picked* from a menu of
 *    their labmates, carried alongside the body.
 *
 * The server never regex-parses names or addresses out of prose to decide who
 * to notify. Guessing is how a note about "@ the reviewer" pages a person
 * called Reviewer, and how an email address in a methods section becomes a
 * message to a stranger. The client sends what was chosen; the server checks
 * those ids are lab members and believes nothing else.
 *
 * Everything here is pure string work — no React, no Convex — so the behaviour
 * that decides who gets told about a note is testable without a database.
 */

/** Someone who can be named: a labmate, as the picker sees them. */
export type MentionCandidate<Id extends string = string> = {
  id: Id;
  /** The display text a mention writes into the body, minus the `@`. */
  name: string;
};

/**
 * How much can follow the `@` before we stop believing it is a name.
 *
 * A cap rather than a scan to end-of-line: without one, a paragraph containing
 * an `@` keeps the picker open over every character typed after it, which is a
 * menu flickering under someone's hands while they write an argument.
 */
export const MAX_MENTION_QUERY = 40;

/**
 * How many people one note may name.
 *
 * A margin note is addressed to a person or two. A note naming the whole lab is
 * an announcement, and Margin does not have announcements — the digest does
 * that job at a boundary, without a dozen emails.
 */
export const MAX_MENTIONS_PER_NOTE = 10;

/** How many rows the picker offers at once. Longer than this is a directory, not a suggestion. */
export const MENTION_SUGGESTION_LIMIT = 6;

/**
 * What may appear before the `@` for it to open a mention.
 *
 * The reason this exists is `ada@university.edu`. An address typed into a
 * methods note has an `@` in the middle of a word, and a trigger that ignored
 * its left-hand neighbour would open a member picker inside every email
 * anybody ever quotes.
 */
const OPENER = /[\s([{"'‘“–—-]/;

/** What may appear *after* the `@` and still be part of a name being typed. */
const NAME_CHAR = /[\p{L}\p{M}\p{N}'’.\-]/u;

/** A mention being typed: where it starts, where the caret is, and what is between. */
export type MentionQuery = {
  /** Index of the `@` in the text. */
  start: number;
  /** Index just past the last typed character — i.e. the caret. */
  end: number;
  /** Everything between the `@` and the caret, verbatim. */
  query: string;
};

/**
 * The mention the caret is currently inside, if it is inside one.
 *
 * Scans backwards from the caret rather than forwards from each `@`, because
 * the question being asked is about *this* caret: a body may hold four
 * finished mentions and the picker is only ever about the one being typed.
 *
 * One space is allowed, so "@Sara C" still finds Sara Chen. Two closes the
 * mention — by then the author has moved on to the sentence, and a picker that
 * stayed open across a clause is a picker that steals the next Enter key.
 */
export function findMentionQuery(
  text: string,
  caret: number,
): MentionQuery | null {
  if (caret < 0 || caret > text.length) {
    return null;
  }

  let spaces = 0;
  for (let i = caret - 1; i >= 0 && caret - i <= MAX_MENTION_QUERY + 1; i--) {
    const character = text[i];
    if (character === undefined) {
      return null;
    }
    if (character === "@") {
      const before = i === 0 ? undefined : text[i - 1];
      if (before !== undefined && !OPENER.test(before)) {
        return null;
      }
      return { start: i, end: caret, query: text.slice(i + 1, caret) };
    }
    if (character === "\n" || character === "\r") {
      return null;
    }
    if (character === " ") {
      spaces += 1;
      if (spaces > 1) {
        return null;
      }
      continue;
    }
    if (!NAME_CHAR.test(character)) {
      return null;
    }
  }
  return null;
}

/**
 * Casefolded and stripped of accents, for matching only.
 *
 * "Zoë" must be findable by typing "zoe" — the name keeps its diaeresis
 * everywhere it is *shown*, and loses it only inside the comparison.
 */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

/**
 * The labmates a half-typed name could mean, best guess first.
 *
 * Three tiers, and the order is the point: someone typing "ch" almost always
 * means the person whose name *starts* that way, so a surname match beats a
 * match buried mid-word, and both beat an incidental substring. Ties keep the
 * order they arrived in, which is the roster's own (PI first, then longest
 * standing) — a stable list is one you can learn the muscle memory of.
 *
 * An empty query lists everyone: pressing `@` and looking is how you use this
 * the first few times.
 */
export function rankCandidates<T extends MentionCandidate>(
  candidates: readonly T[],
  query: string,
  limit: number = MENTION_SUGGESTION_LIMIT,
): T[] {
  const needle = fold(query.trim());
  if (needle.length === 0) {
    return candidates.slice(0, limit);
  }

  const scored: { candidate: T; score: number; index: number }[] = [];
  candidates.forEach((candidate, index) => {
    const name = fold(candidate.name);
    let score: number;
    if (name.startsWith(needle)) {
      score = 0;
    } else if (name.split(/\s+/).some((word) => word.startsWith(needle))) {
      score = 1;
    } else if (name.includes(needle)) {
      score = 2;
    } else {
      return;
    }
    scored.push({ candidate, score, index });
  });

  scored.sort((a, b) => a.score - b.score || a.index - b.index);
  return scored.slice(0, limit).map((entry) => entry.candidate);
}

/** The exact characters a mention of `name` puts in the body. */
export function mentionToken(name: string): string {
  return `@${name}`;
}

/**
 * Put a chosen name where the half-typed one was.
 *
 * Returns the caret as well as the text: after picking, the caret belongs after
 * the trailing space, ready for the rest of the sentence. Leaving it where the
 * browser would put it — at the end of the whole body — is how an insertion in
 * the middle of a paragraph throws the writer to the bottom of it.
 */
export function insertMention(
  text: string,
  range: MentionQuery,
  name: string,
): { text: string; caret: number } {
  const token = mentionToken(name);
  const tail = text.slice(range.end);
  // Don't stack a second space on one that is already there.
  const spacer = tail.startsWith(" ") ? "" : " ";
  return {
    text: `${text.slice(0, range.start)}${token}${spacer}${tail}`,
    caret: range.start + token.length + spacer.length,
  };
}

/** Is the token at `index` a mention, rather than a name embedded in a word? */
function isTokenAt(body: string, index: number, token: string): boolean {
  const before = index === 0 ? undefined : body[index - 1];
  if (before !== undefined && !OPENER.test(before)) {
    return false;
  }
  const after = body[index + token.length];
  // "@Sara" must not match inside "@Sarah": the character after a mention has
  // to be something that could not have been part of the name.
  return after === undefined || !NAME_CHAR.test(after);
}

/** Every index in `body` where `@name` stands as a mention. */
function tokenIndices(body: string, name: string): number[] {
  const token = mentionToken(name);
  const found: number[] = [];
  let from = 0;
  for (;;) {
    const index = body.indexOf(token, from);
    if (index === -1) {
      return found;
    }
    if (isTokenAt(body, index, token)) {
      found.push(index);
    }
    from = index + 1;
  }
}

/**
 * Which of the picked people the body still actually names.
 *
 * The picker records an id when a name is chosen, but writing is editing: a
 * name gets typed, thought better of, and deleted again, and the id would
 * otherwise survive the words and page somebody about a sentence that no
 * longer mentions them. So the two are reconciled at save time against the
 * body as it finally stands — the text is the authority for *whether*, the
 * picked ids remain the authority for *who*.
 *
 * Ordered by where each name first appears, deduplicated, and capped.
 */
export function collectMentionedIds<T extends MentionCandidate>(
  body: string,
  picked: readonly T[],
): T["id"][] {
  const seen = new Set<string>();
  const positioned: { id: T["id"]; at: number }[] = [];

  for (const candidate of picked) {
    if (seen.has(candidate.id)) {
      continue;
    }
    const [first] = tokenIndices(body, candidate.name);
    if (first === undefined) {
      continue;
    }
    seen.add(candidate.id);
    positioned.push({ id: candidate.id, at: first });
  }

  return positioned
    .sort((a, b) => a.at - b.at)
    .slice(0, MAX_MENTIONS_PER_NOTE)
    .map((entry) => entry.id);
}

/** A run of body text, flagged for whether it is a name the note is addressing. */
export type MentionSegment = { text: string; mention: boolean };

/**
 * Break a body into plain runs and mention runs, so a card can set the names in
 * the accent ink without storing a second, marked-up copy of the prose.
 *
 * Longest names first: with a Jo and a Joanna in one lab, matching "@Jo" first
 * would leave "anna" stranded outside the mention it belongs to.
 */
export function mentionSegments(
  body: string,
  names: readonly string[],
): MentionSegment[] {
  const spans: { start: number; end: number }[] = [];
  const ordered = [...new Set(names)].sort((a, b) => b.length - a.length);

  for (const name of ordered) {
    const token = mentionToken(name);
    for (const index of tokenIndices(body, name)) {
      const end = index + token.length;
      // A name inside an already-claimed span is the shorter of two overlapping
      // names, and the longer one has already had it.
      if (spans.some((span) => index < span.end && end > span.start)) {
        continue;
      }
      spans.push({ start: index, end });
    }
  }

  if (spans.length === 0) {
    return body.length === 0 ? [] : [{ text: body, mention: false }];
  }

  spans.sort((a, b) => a.start - b.start);
  const segments: MentionSegment[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) {
      segments.push({ text: body.slice(cursor, span.start), mention: false });
    }
    segments.push({ text: body.slice(span.start, span.end), mention: true });
    cursor = span.end;
  }
  if (cursor < body.length) {
    segments.push({ text: body.slice(cursor), mention: false });
  }
  return segments;
}

/**
 * Give every candidate a name that means one person.
 *
 * Two people called Sara Chen is not a hypothetical in a university, and a
 * mention is stored as an id but *read* as text — so if the picker offers the
 * same string twice, the author cannot see which one they addressed and the
 * reconciliation above cannot tell the two tokens apart. Colliding names get
 * their address's local part; everyone else is left exactly as they are, since
 * "Sara Chen (s.chen)" for a lab with one Sara is noise.
 */
export function disambiguate<T extends { name: string; email?: string }>(
  people: readonly T[],
): (T & { name: string })[] {
  const counts = new Map<string, number>();
  for (const person of people) {
    counts.set(person.name, (counts.get(person.name) ?? 0) + 1);
  }
  return people.map((person) => {
    if ((counts.get(person.name) ?? 0) < 2) {
      return { ...person };
    }
    const local = person.email?.split("@")[0];
    return {
      ...person,
      name:
        local === undefined || local.length === 0
          ? person.name
          : `${person.name} (${local})`,
    };
  });
}
