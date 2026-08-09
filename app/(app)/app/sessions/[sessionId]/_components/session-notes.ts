import type { Id } from "@/convex/_generated/dataModel";
import type { AnnotationType } from "../../../library/[paperId]/read/_components/ontology";
import { ANNOTATION_TYPES } from "../../../library/[paperId]/read/_components/ontology";
import type { AnnotationView } from "../../../library/[paperId]/read/_components/types";

/**
 * The collective view of a session, derived from the paper's margin.
 *
 * Everything on this screen comes from one live subscription —
 * `annotations.listForPaper` — because that query is already the reader's, is
 * already reactive, and already carries the privacy rule the constitution
 * needs. What it hands back is "the lab's notes, plus your own private ones",
 * and the first thing this module does is drop the second half.
 *
 * ## The one rule
 *
 * A collective surface shows lab-visible annotations and nothing else. A
 * private note is invisible to everyone but its author, and a projector view
 * that quietly included the viewer's own private notes would put them on a wall
 * in front of the lab. So `visibility === "lab"` is applied here, once, before
 * anything is grouped — not in each component.
 *
 * Nothing in here is ever keyed by member. Counts are per type and per passage;
 * there is no "who has annotated" shape anywhere in this file, because the
 * constitution forbids per-member reading dashboards and the cheapest way to
 * keep that promise is to never compute the number.
 */

export type PassageGroup = {
  key: string;
  pageIndex: number;
  quote: string;
  start: number;
  notes: AnnotationView[];
  /** How many notes of each type sit on this passage, richest type first. */
  marks: { type: AnnotationType; count: number }[];
};

export type SessionNotes = {
  /** Top-level, lab-visible, written in this session. */
  inSession: AnnotationView[];
  repliesByParent: Map<Id<"annotations">, AnnotationView[]>;
  passages: PassageGroup[];
  counts: { type: AnnotationType; count: number }[];
  total: number;
  /** Lab notes on this paper written outside this session — a count, only. */
  elsewhere: number;
};

/**
 * Two people reading different PDFs of the same paper land on the same sentence
 * at different offsets, so a passage is keyed by its page and its text rather
 * than by its numbers — the same identity rule `lib/digest/engine.ts` uses when
 * it decides whether two annotations collided.
 */
function passageKey(annotation: AnnotationView): string {
  const quote = annotation.anchor.quote.trim().toLowerCase().replace(/\s+/g, " ");
  return `${annotation.anchor.pageIndex}:${quote}`;
}

export function groupSessionNotes(
  rows: readonly AnnotationView[],
  sessionId: Id<"sessions">,
): SessionNotes {
  const shared = rows.filter(
    (row) => row.visibility === "lab" && !row.deleted,
  );

  const repliesByParent = new Map<Id<"annotations">, AnnotationView[]>();
  for (const row of shared) {
    if (row.parentId === undefined || row.sessionId !== sessionId) {
      continue;
    }
    const existing = repliesByParent.get(row.parentId);
    if (existing === undefined) {
      repliesByParent.set(row.parentId, [row]);
    } else {
      existing.push(row);
    }
  }

  const inSession = shared.filter(
    (row) => row.sessionId === sessionId && row.parentId === undefined,
  );
  const elsewhere = shared.filter(
    (row) => row.sessionId !== sessionId && row.parentId === undefined,
  ).length;

  const groups = new Map<string, PassageGroup>();
  for (const note of inSession) {
    const key = passageKey(note);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        key,
        pageIndex: note.anchor.pageIndex,
        quote: note.anchor.quote,
        start: note.anchor.start,
        notes: [note],
        marks: [],
      });
    } else {
      existing.notes.push(note);
    }
  }

  const passages = [...groups.values()].sort(
    (a, b) => a.pageIndex - b.pageIndex || a.start - b.start,
  );
  for (const passage of passages) {
    const tally = new Map<AnnotationType, number>();
    for (const note of passage.notes) {
      tally.set(note.type, (tally.get(note.type) ?? 0) + 1);
    }
    passage.marks = [...tally.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);
  }

  const tally = new Map<AnnotationType, number>();
  for (const note of inSession) {
    tally.set(note.type, (tally.get(note.type) ?? 0) + 1);
  }

  return {
    inSession,
    repliesByParent,
    passages,
    // Ontology order, and only the types anyone has actually used: a legend
    // listing seven types where three have marks is six words of noise.
    counts: ANNOTATION_TYPES.filter(
      (style) => (tally.get(style.value) ?? 0) > 0,
    ).map((style) => ({
      type: style.value,
      count: tally.get(style.value) ?? 0,
    })),
    total: inSession.length,
    elsewhere,
  };
}

/** Notes of one type, oldest first — the order the room said them in. */
export function ofType(
  notes: readonly AnnotationView[],
  type: AnnotationType,
): AnnotationView[] {
  return notes.filter((note) => note.type === type);
}

/**
 * Where a note is drawn, as two lists that partition the ontology.
 *
 * The board's one promise is that a note appears exactly once, and which place
 * is decided by its type: four of the seven are things the lab noticed *in the
 * paper*, so they sit beside the passage; the other three are what a journal
 * club talks *from*, so they stand in the floor's columns. `session-board.tsx`
 * renders from these; `anchoredIds` below reads them to answer where a
 * citation can actually land. They live here, with the grouping, because a
 * pure rule about the board should be testable without mounting it — and the
 * test asserts the partition, so a type added to the ontology and to neither
 * list cannot slip through as a note nobody can link to.
 *
 * The floor's columns are declared over in `session-board.tsx`, since they
 * carry headings and empty-state copy this file has no business holding. The
 * suite holds that list against `ON_THE_FLOOR` type for type: the partition
 * alone would survive a type moved between these two lists, and what that
 * moves is a column onto the board with no anchor behind it.
 */
export const AT_THE_PASSAGE: readonly AnnotationType[] = [
  "hypothesis",
  "method-note",
  "definition",
  "note",
];

export const ON_THE_FLOOR: readonly AnnotationType[] = [
  "open-question",
  "critique",
  "connection-to-own-work",
];

/** A projector should not try to paint four hundred passage cards. */
export const MAX_PASSAGE_CARDS = 40;

/** As much of a note as the anchoring question needs. */
type Drawn = { _id: string; type: AnnotationType };

/**
 * The notes this board actually puts an anchor on the page for.
 *
 * A synthesis or brief citation renders as a link to `note-<id>`, and a link
 * to an id that is not on the page is a promise the page cannot keep — the
 * reader clicks a number and nothing moves. Rather than emit anchors for
 * everything and hope, the pages ask this what is really on screen and draw
 * the rest of the citations as plain numbers.
 *
 * Three things get an anchor, and the reasons are the board's own layout:
 * passage notes whose card survived `MAX_PASSAGE_CARDS`, every floor note, and
 * the replies drawn underneath a floor note. Everything else — a note written
 * outside this session, a reply whose parent is elsewhere, the tail of a very
 * heavily marked paper — is cited by number and left unlinked.
 */
export function anchoredIds(notes: {
  inSession: readonly Drawn[];
  repliesByParent: ReadonlyMap<string, readonly Drawn[]>;
  passages: readonly { notes: readonly Drawn[] }[];
}): Set<string> {
  const anchored = new Set<string>();

  for (const passage of notes.passages.slice(0, MAX_PASSAGE_CARDS)) {
    for (const note of passage.notes) {
      if (AT_THE_PASSAGE.includes(note.type)) {
        anchored.add(note._id);
      }
    }
  }

  for (const note of notes.inSession) {
    if (!ON_THE_FLOOR.includes(note.type)) {
      continue;
    }
    anchored.add(note._id);
    for (const reply of notes.repliesByParent.get(note._id) ?? []) {
      anchored.add(reply._id);
    }
  }

  return anchored;
}
