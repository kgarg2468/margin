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
