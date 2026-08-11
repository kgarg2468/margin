/**
 * The two halves of the brief that are never stored.
 *
 * `lib/brief/assemble.ts` builds the cited sections that get written to a
 * `briefs` row, generated once and approved. These two are different in kind:
 * they are computed on every read, from the margin the session page is already
 * subscribed to, and nothing about them is ever persisted or sent anywhere.
 *
 * ## Why they live on the client
 *
 * **Your own notes.** A presenter's private notes on the paper are their prep,
 * and prep is exactly what a brief is for — but a brief row is read by the PI
 * as well. Any design where a private note reaches the server's brief pipeline
 * is one leaked field away from putting somebody's private note in front of
 * their PI. So it never enters the pipeline: `annotations.listForPaper` already
 * hands each caller "the lab's notes, plus your own private ones" and nothing
 * else, so filtering that subscription down to `mine && private` is a section
 * that is *structurally* incapable of showing anyone else's writing. There is
 * no query to get wrong.
 *
 * **Who has written.** A tally by member is the one shape in this product that
 * has to be argued for rather than assumed, because two other modules refuse to
 * compute it: `getSessionContext` in `convex/sessions.ts` and
 * `groupSessionNotes` in the session board both say, in as many words, that a
 * per-member breakdown is a reading dashboard and that the cheapest way to keep
 * the promise is to never compute the number. Both are right about themselves —
 * they are collective surfaces, and a per-member column on a projector is a
 * scoreboard.
 *
 * The line this side of it holds for three reasons, and all three have to be
 * true at once:
 *
 * 1. **It counts writing, never reading.** The privacy constitution bans read
 *    and dwell tracking; an authored annotation is the one signal it permits,
 *    and this counts nothing else. There is no clock in here.
 * 2. **It reveals nothing the same screen doesn't already print.** Every
 *    lab-visible note on the session page is already rendered with its author's
 *    name on it. Adding up names that are already on the page is a summary, not
 *    a new disclosure — and because it is computed here, in the browser, from
 *    rows already delivered, no Convex function gained the ability to answer
 *    "who has annotated". `getSessionContext`'s promise stays literally true.
 * 3. **Nobody appears with a zero.** This is the load-bearing one. The
 *    constitution protects the member who did not write, and a roster with an
 *    empty column beside a name is precisely the artifact it exists to prevent
 *    — a presenter's brief that lists who hasn't done the reading is a
 *    surveillance tool with a nice typeface. Only contributors are returned,
 *    the lab's membership is never consulted, and there is no argument that
 *    would make this function emit a name with a count of zero.
 *
 * What is left is a bibliography: who wrote what on this paper, so a presenter
 * can decide who to bring in on methods. That is the question the section
 * answers, and it is the only one it can.
 */

import type { AnnotationType } from "../digest/engine";

/**
 * One row of the paper's margin, as `annotations.listForPaper` hands it over.
 *
 * Declared structurally rather than imported from the app so this module stays
 * testable without a Convex client, and so `lib/` keeps not depending on
 * `app/`. Every field here is one the query already returns.
 */
export type MarginRow<
  AnnotationId extends string = string,
  UserId extends string = string,
> = {
  _id: AnnotationId;
  memberId: UserId;
  authorName: string;
  /** True when the caller wrote it. */
  mine: boolean;
  type: AnnotationType;
  visibility: "lab" | "private";
  /** Withdrawn: the body is gone, the thread it held up is not. */
  deleted: boolean;
  parentId?: AnnotationId;
  body: string;
  anchor: { pageIndex: number; quote: string };
};

export type Contributor<UserId extends string = string> = {
  memberId: UserId;
  name: string;
  mine: boolean;
  /** Lab-visible, non-withdrawn annotations on this paper, replies included. */
  total: number;
  /** Per type, richest first; types with nothing are absent, never zero. */
  counts: { type: AnnotationType; count: number }[];
};

/** Fixed ontology order, used only to break ties between equal counts. */
const TYPE_ORDER: readonly AnnotationType[] = [
  "hypothesis",
  "critique",
  "open-question",
  "connection-to-own-work",
  "method-note",
  "definition",
  "note",
];

/**
 * Who has written on this paper, and what kind of thing they wrote.
 *
 * Replies count. A member whose whole contribution is four sharp replies under
 * somebody else's critique has done the reading and is worth calling on, and a
 * tally that ignored them would say the opposite.
 *
 * Private notes are excluded even when they are the caller's own. The count is
 * "what the lab can see", one number with one meaning; folding your own private
 * notes into your own row would make your line incomparable to everyone else's
 * and would quietly change what the number means depending on who is reading.
 */
export function tallyContributors<A extends string, U extends string>(
  rows: readonly MarginRow<A, U>[],
): Contributor<U>[] {
  const byMember = new Map<
    U,
    { name: string; mine: boolean; counts: Map<AnnotationType, number> }
  >();

  for (const row of rows) {
    if (row.visibility !== "lab" || row.deleted) continue;
    let entry = byMember.get(row.memberId);
    if (entry === undefined) {
      entry = { name: row.authorName, mine: row.mine, counts: new Map() };
      byMember.set(row.memberId, entry);
    }
    entry.counts.set(row.type, (entry.counts.get(row.type) ?? 0) + 1);
  }

  return [...byMember.entries()]
    .map(([memberId, entry]) => {
      const counts = [...entry.counts.entries()]
        .map(([type, count]) => ({ type, count }))
        .sort(
          (x, y) =>
            y.count - x.count ||
            TYPE_ORDER.indexOf(x.type) - TYPE_ORDER.indexOf(y.type),
        );
      return {
        memberId,
        name: entry.name,
        mine: entry.mine,
        total: counts.reduce((sum, one) => sum + one.count, 0),
        counts,
      };
    })
    .sort((x, y) => y.total - x.total || (x.name < y.name ? -1 : 1));
}

/**
 * The caller's own private notes on this paper, in reading order.
 *
 * Top-level only: a private reply is a contradiction in terms in this schema —
 * a thread is shared or it does not exist — and filtering for it here would
 * imply the product had such a thing.
 *
 * Sorted by page rather than by when they were written, because this is the
 * one section the presenter reads *while walking the paper*, and their own
 * notes are the outline they are about to speak from.
 */
export function ownPrivateNotes<A extends string, U extends string>(
  rows: readonly MarginRow<A, U>[],
): MarginRow<A, U>[] {
  return rows
    .filter(
      (row) =>
        row.mine &&
        row.visibility === "private" &&
        !row.deleted &&
        row.parentId === undefined,
    )
    .sort((x, y) => x.anchor.pageIndex - y.anchor.pageIndex);
}

/**
 * Which of a line's citations this page may judge, and what it concludes.
 *
 * The panel re-applies the server's redaction threshold against what *this*
 * reader can currently see, so one check is one place to be wrong. That works
 * because a brief line's citations are on the paper the page has subscribed
 * to — with one exception, which is why this function exists: a cross-paper
 * collision cites a note in another document, the subscription has no row for
 * it, and "no row" would otherwise be read as "withdrawn".
 *
 * So the test runs over the near citations only, and stays all-or-nothing over
 * them: a collision line names both members and quotes each, and there is no
 * version of it with one member removed that is still a true sentence. The far
 * citation is deferred to the server, which re-resolved it against the *lab*
 * rather than the paper (`stillSharedAmong`) — the check that was always the
 * one of record.
 */
export function lineCitations<A extends string>(
  item: { annotationIds: readonly A[]; crossPaperIds?: readonly A[] },
  visible: ReadonlySet<A>,
): { withdrawn: boolean; cited: A[] } {
  const far = new Set<A>(item.crossPaperIds ?? []);
  const withdrawn = item.annotationIds.some(
    (id) => !far.has(id) && !visible.has(id),
  );
  return {
    withdrawn,
    cited: withdrawn
      ? []
      : item.annotationIds.filter((id) => far.has(id) || visible.has(id)),
  };
}
