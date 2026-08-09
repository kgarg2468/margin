/**
 * Where a claim stands, once the lab has said where it stands.
 *
 * A note's `type` is what its author meant by writing it — a hypothesis, a
 * critique, a question. This is the other axis, and it belongs to the lab
 * rather than to the author: the group's own verdict on a claim it can see.
 * Margin already answers "may I still show this?" (a withdrawn note takes its
 * paraphrases with it). It has not been able to answer "did we change our
 * mind?" — and until it can, a position the lab argued down and a note somebody
 * deleted disappear in exactly the same way, which is the difference between a
 * record and a filing cabinet.
 *
 * ## Human-authored, and that is the whole design
 *
 * Nothing in this module infers anything. There is no heuristic that reads
 * three critiques under a hypothesis and calls it disputed, and there will not
 * be one here: a status is a sentence somebody in the lab is prepared to sign,
 * and a machine that writes one has put words in their mouth. Suggestion —
 * a model proposing an edge a person then accepts — is a later and different
 * feature, and it has to arrive as a *proposal* pointing at this, never as a
 * writer of it.
 *
 * ## The four words, and the fifth state that is not a word
 *
 * `accepted`, `disputed`, `resolved`, `superseded`. Unmarked is the fifth
 * state and it is deliberately not spelled: almost every note in a margin is
 * unmarked, and a product that stamped "PROPOSED" on all of them would have
 * turned reading into filing. Absence means nobody has ruled, which is the
 * truth about most of what anyone writes.
 *
 * No state is terminal. A lab that accepts a claim in March and disputes it in
 * June has done the thing this feature exists to record, and refusing the
 * second transition because the first one happened would make the status a
 * decision about the past rather than a description of the present. What is
 * kept is not the states one at a time but the walk between them, and that
 * lives in the ledger (`annotation.status_set` / `annotation.status_cleared`),
 * where nothing can be rewritten.
 *
 * ## Why this is pure, and clock-free
 *
 * Same reason as `lib/digest/engine.ts` and `lib/annotation-history/history.ts`:
 * the interesting cases are the ones nobody can eyeball. "Superseded by a note
 * that has itself since been withdrawn" is a state that will exist in every
 * real lab and appears in no screenshot, so the rules that govern it are
 * written where they can be tested rather than inside a mutation that needs a
 * database to run. Ids arrive as plain strings here; this module has no opinion
 * about Convex and no way to read a row.
 */

/**
 * The four verdicts, in the order they are always offered.
 *
 * Ordered as an argument runs rather than alphabetically: a claim is taken up
 * (`accepted`) or contested (`disputed`), a contest ends (`resolved`), and a
 * claim is eventually replaced by a better one (`superseded`). A member
 * scanning the row reads the life of a claim left to right.
 */
export const EPISTEMIC_STATUSES = [
  "accepted",
  "disputed",
  "resolved",
  "superseded",
] as const;

export type EpistemicStatus = (typeof EPISTEMIC_STATUSES)[number];

export type StatusMark = {
  value: EpistemicStatus;
  /** The word-mark itself. Set in the margin's micro-caps, never in a coloured pill. */
  word: string;
  /** Said in full where there is room for it, so the closed set teaches itself. */
  meaning: string;
};

/**
 * The vocabulary, in one place because two places is where a vocabulary drifts.
 *
 * The meanings are deliberately about the *lab* rather than about the reader.
 * "I'm not convinced" is a reaction — one person, one tap, already shipped as
 * `doubt`. "The lab does not agree on this" is a status: a statement somebody
 * is making on behalf of the group, which is why not everyone may make it.
 */
export const STATUS_MARKS: readonly StatusMark[] = [
  {
    value: "accepted",
    word: "Accepted",
    meaning: "The lab takes this as settled",
  },
  {
    value: "disputed",
    word: "Disputed",
    meaning: "The lab does not agree on this",
  },
  {
    value: "resolved",
    word: "Resolved",
    meaning: "The question here has been answered",
  },
  {
    value: "superseded",
    word: "Superseded",
    meaning: "A later note replaces this one",
  },
];

/** The word-mark for one status. */
export function statusWord(value: EpistemicStatus): string {
  return STATUS_MARKS.find((mark) => mark.value === value)?.word ?? "Marked";
}

/**
 * The half of a `superseded` mark that is a citation, or `null` when the mark
 * is one of the three that are not.
 *
 * A citation has three possible truths — the note it names is there, the note
 * it names has gone, or the reader is looking at a margin that does not contain
 * it — and this says which. Never silently: a "Superseded" with the reference
 * quietly dropped would be the product asserting the lab replaced this claim
 * with something the reader is not allowed to ask about.
 *
 * `by` is a person's name rather than a link because the superseding note is a
 * card in the same rail: naming its author is what lets a reader find it, and a
 * hyperlink into a list that scrolls with the PDF is a promise this surface
 * cannot keep yet.
 *
 * Separate from the word so the margin can set them differently — the verdict
 * in the letterpress micro-caps the type badge uses, the citation in the faint
 * sans the timestamps use. One string would have forced both into one voice,
 * and the two are not the same kind of fact.
 */
export function supersessionLine(mark: {
  value: EpistemicStatus;
  /** The author of the note that replaced this one, when it is still readable. */
  by?: string | null;
  /** The named note exists but the reader may no longer see it. */
  redacted?: boolean;
}): string | null {
  if (mark.value !== "superseded") {
    return null;
  }
  if (mark.redacted === true) {
    return "by a note that is no longer shared";
  }
  if (mark.by !== undefined && mark.by !== null && mark.by.length > 0) {
    return `by ${mark.by}'s note`;
  }
  // The reference is real and simply not in front of us — a truncated margin,
  // or a note this reader's copy of the margin did not include. Saying nothing
  // further is honest; claiming it was withdrawn would not be.
  return null;
}

/**
 * The whole mark as one sentence: what a screen reader is told, and what a
 * tooltip carries where there is no room to set the two halves apart.
 */
export function statusLine(mark: {
  value: EpistemicStatus;
  by?: string | null;
  redacted?: boolean;
}): string {
  const word = statusWord(mark.value);
  const citation = supersessionLine(mark);
  return citation === null ? word : `${word} ${citation}`;
}

export type TransitionCheck =
  | {
      ok: true;
      /**
       * False when the request is the state the note is already in. The caller
       * writes nothing — no row, and no ledger fact. A member tapping the word
       * that is already lit has not changed the lab's mind, and a ledger that
       * recorded it would answer "when did we last discuss this" with the time
       * somebody double-clicked.
       */
      changed: boolean;
    }
  | { ok: false; reason: string };

/**
 * Whether one status transition is a legal move, and whether it is a move at
 * all.
 *
 * Deliberately not a matrix of allowed from→to pairs. Every pair is allowed,
 * including the ones that look like backsliding, because the lab is the
 * authority on its own mind and a rule table here would be this module
 * overruling it. What is checked instead is the three ways a transition can be
 * incoherent rather than merely surprising:
 *
 * 1. **`superseded` with nothing to point at.** The word is a reference. A
 *    note marked superseded by nothing in particular says "we replaced this"
 *    and refuses to say with what, which is the one thing a reader of a lab's
 *    memory cannot check.
 * 2. **A reference on any other word.** "Accepted, by Tom's note" is not a
 *    sentence. Allowing it would leave a dangling citation on the row for the
 *    next status to inherit.
 * 3. **A note superseding itself.** The rest of the product's referential rules
 *    are enforced against the database (same lab, same paper, still shared);
 *    this one needs no row to know it is wrong.
 */
export function checkTransition(request: {
  /** The note being marked. */
  self: string;
  /** What it is marked now; `null` when nobody has ruled. */
  current: EpistemicStatus | null;
  /** What it currently names as its replacement, if anything. */
  currentSupersededBy: string | null;
  /** What it is being marked; `null` takes the mark off. */
  next: EpistemicStatus | null;
  /** The note being named as its replacement, if any. */
  supersededBy: string | null;
}): TransitionCheck {
  const { self, current, currentSupersededBy, next, supersededBy } = request;

  if (next === "superseded" && supersededBy === null) {
    return {
      ok: false,
      reason: "Say which note supersedes this one.",
    };
  }
  if (next !== "superseded" && supersededBy !== null) {
    return {
      ok: false,
      reason: "Only a superseded note names the note that replaced it.",
    };
  }
  if (supersededBy !== null && supersededBy === self) {
    return { ok: false, reason: "A note can't supersede itself." };
  }

  return {
    ok: true,
    changed: next !== current || supersededBy !== currentSupersededBy,
  };
}
