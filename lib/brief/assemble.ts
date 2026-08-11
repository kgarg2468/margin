/**
 * The presenter's pre-session brief, as pure functions.
 *
 * Ctx-free in the same way `lib/digest/engine.ts` is, and for the same reason:
 * `convex/briefs.ts` does the reading, the authorization and the writing, and
 * this module decides what the brief says. The policy is unit-testable against
 * the shapes it was written for rather than against a deployment.
 *
 * ## There is no model in here
 *
 * A brief is **assembled, not generated**. Every line is a rearrangement of
 * annotations the lab already wrote, and every item carries the ids it was
 * built from. That is not a cost saving — it is what makes the artifact
 * checkable: a presenter who doubts a line can open the note behind it, and
 * nothing on the page can be a sentence nobody said. The synthesis has a model
 * in it and pays for that with a sanitizer that drops anything it cannot trace
 * (`sanitizeSections`); the brief simply never manufactures the problem.
 *
 * ## The four lenses
 *
 * A presenter preparing on a Sunday night is asking four questions, and the
 * sections are those questions rather than a dump of the margin:
 *
 * 1. **Where did the lab collide?** — the gold typed-pair collisions, straight
 *    from the shipped `digest_gold5` matrix. Two people who landed on the same
 *    passage with a hypothesis and a critique is the meeting's first ten
 *    minutes, already found.
 * 2. **What did nobody answer?** — open questions with no reply. An open
 *    question that already has a thread under it is being handled; one sitting
 *    alone is floor time.
 * 3. **What is still open from last time?** — the same, for prior sessions on
 *    this paper. This is the section that turns a prep tool into memory: week
 *    one it is empty, and by week six it is the reason the brief is opened.
 * 4. **What drew a crowd?** — critiques and method notes with the most replies.
 *    A thread the lab already argued in is a thread worth reopening out loud.
 *
 * ## What was deliberately not here, and now is
 *
 * Cross-paper collisions. `detectCollisions` still stops at the paper boundary
 * and always will — a collision inside one document is a *passage*, and a
 * passage has no meaning across two files. The second detector is the one that
 * crosses (`detectCrossPaperCollisions`, shipped for the digest in #56): same
 * claim, two papers, two members, gold type pair, and a sixty-character floor
 * so a methods boilerplate sentence cannot link two literatures. It arrives
 * here as an argument rather than as a call, because a pool spanning papers is
 * not on its own a request to pair across them — the same rule `assembleDigest`
 * follows.
 *
 * What is still deliberately not here: no per-item dedupe against the
 * collisions section — a "possible answer" collision is *definition ×
 * open-question*, so the open question inside it belongs in both places, and
 * hiding the second copy would cost the presenter the link between them. The
 * digest dedupes because five lines is a hard budget; a brief is a page someone
 * reads on purpose.
 */

import {
  detectCollisions,
  collisionLine,
  type AnnotationType,
  type Collision,
  type CrossPaperScan,
  type DigestAnnotation,
} from "../digest/engine";

/**
 * One annotation, flattened to what a brief reads.
 *
 * A superset of `DigestAnnotation` so the pool can be handed straight to
 * `detectCollisions` — the brief runs the *shipped* collision policy rather
 * than a second one that would drift from it.
 */
export type BriefAnnotation<
  PaperId extends string = string,
  AnnotationId extends string = string,
  UserId extends string = string,
  SessionId extends string = string,
> = DigestAnnotation<PaperId, AnnotationId, UserId> & {
  /** What the member wrote. Empty is normal — typing a passage is one tap. */
  body: string;
  /** Set when this is a reply; a reply is never itself a brief item. */
  parentId?: AnnotationId;
  /** The session it was written under, if it was written under one. */
  sessionId?: SessionId;
};

export type BriefSectionKey =
  | "collisions"
  | "open-questions"
  | "carried-over"
  | "floor";

export type BriefItem<
  AnnotationId extends string = string,
  SessionId extends string = string,
> = {
  /** The line as it will be read. Every one of them is traceable to `annotationIds`. */
  text: string;
  /**
   * The annotations this line was built from.
   *
   * The whole provenance contract in one field: `convex/briefs.ts` re-resolves
   * every id on read and redacts a line whose notes have all been withdrawn,
   * exactly as `getForSession` does for a synthesis. A line that cited nothing
   * could not be checked and is never produced.
   */
  annotationIds: AnnotationId[];
  /** The gold matrix cell, on collision items only — e.g. `"critique x hypothesis"`. */
  pairType?: string;
  /**
   * The citations on this line that live on a *different* paper.
   *
   * On cross-paper collision items only, and the whole reason the field
   * exists: the panel re-checks a line against the margin it has subscribed
   * to, which is this paper's. A far citation is not in that margin and never
   * will be, so without this the client's "is every note behind this line
   * still shared?" test reads a perfectly live note as a withdrawn one and
   * holds the line back — silently deleting exactly the lines this boundary
   * lift exists to draw. The server's check is lab-wide and stands
   * (`convex/briefs.ts`); this says which citations the browser must leave
   * to it.
   */
  crossPaperIds?: AnnotationId[];
  /**
   * Which earlier session left this open, on carried-over items only, and when
   * that meeting was.
   *
   * An id and an epoch number rather than a rendered "from the March 12
   * session": a date has a timezone and a reader, and neither of them is here.
   * The client has both and already formats sessions. The date is carried at
   * all — rather than left for the reader to go and look up — because "still
   * open from March 12" is the whole point of the section, and "raised in an
   * earlier session" is the same sentence with the memory taken out of it.
   */
  fromSessionId?: SessionId;
  fromSessionAt?: number;
};

export type BriefSection<
  AnnotationId extends string = string,
  SessionId extends string = string,
> = {
  key: BriefSectionKey;
  heading: string;
  items: BriefItem<AnnotationId, SessionId>[];
  /** Candidates the cap kept out, so the panel can say so instead of pretending. */
  droppedCount: number;
  /**
   * True when the cross-paper scan behind this section stopped at its
   * comparison budget instead of at the end of its candidates.
   *
   * The collisions section only, and it is `droppedCount`'s other half rather
   * than a detail: that number counts lines this function *saw* and had no
   * room for, and it is silent about lines the search never reached. A capped
   * scan and a complete one otherwise produce the same shaped section, so
   * without this a section fed by a truncated search reads as a finished one —
   * which is the failure `CrossPaperScan.capped` exists to prevent
   * (`lib/digest/engine.ts`), carried the last step to a reader.
   *
   * Set only when true. Absent and `false` mean the same thing, the stored
   * field has to be optional anyway (rows written before this have no opinion
   * on it), and one representation of one fact is what keeps the panel's test
   * a single comparison.
   */
  crossPaperCapped?: boolean;
};

/**
 * How many items a section may carry.
 *
 * Not the digest's five. That cap is a budget for an interruption — a
 * notification someone did not ask for, where the sim measured what could be
 * dropped without losing gold. A brief is a page a presenter opened on purpose
 * with an hour to plan, so the constraint is legibility rather than attention,
 * and six per lens is about what fits on a screen before scanning turns into
 * reading.
 */
export const MAX_SECTION_ITEMS = 6;

/** Longest run of a member's own words a line will carry before eliding. */
const MAX_BODY_CHARS = 160;

/** Longest passage quote a line will carry. Shorter than the body: it is the address, not the point. */
const MAX_QUOTE_CHARS = 110;

const HEADINGS: Readonly<Record<BriefSectionKey, string>> = {
  collisions: "Where the lab collided",
  "open-questions": "Open questions nobody has answered",
  "carried-over": "Still open from earlier sessions",
  floor: "Threads that drew a crowd",
};

/** The types a brief will put on the floor, and how each reads in a line. */
const FLOOR_TYPES: Readonly<Partial<Record<AnnotationType, string>>> = {
  critique: "critique",
  "method-note": "method note",
};

function elide(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * A line for one annotation: who, where, and the sharpest text available.
 *
 * The body is preferred over the passage because the body is what the member
 * *said* and the passage is only where they said it. A typed passage with no
 * body is a real and common object — typing is one tap and an empty body is
 * allowed on purpose — so it falls back to the quote and says which it is
 * showing, rather than quoting the paper as though the member had written it.
 */
export function noteLine(
  annotation: Pick<
    BriefAnnotation,
    "memberName" | "body" | "quote" | "pageIndex"
  >,
  lead?: string,
): string {
  const where = `p. ${annotation.pageIndex + 1}`;
  const opening =
    lead === undefined
      ? `${annotation.memberName}, ${where}`
      : `${annotation.memberName}’s ${lead} on ${where}`;

  const body = elide(annotation.body, MAX_BODY_CHARS);
  if (body.length > 0) {
    return `${opening}: “${body}”`;
  }
  const quote = elide(annotation.quote, MAX_QUOTE_CHARS);
  if (quote.length > 0) {
    return `${opening}, marked without a comment, on: “${quote}”`;
  }
  return `${opening}, marked without a comment`;
}

/** How many replies each annotation is carrying, from the pool itself. */
function replyCounts<A extends string>(
  pool: readonly { id: A; parentId?: A }[],
): Map<A, number> {
  const counts = new Map<A, number>();
  for (const annotation of pool) {
    const parentId = annotation.parentId;
    if (parentId === undefined) continue;
    counts.set(parentId, (counts.get(parentId) ?? 0) + 1);
  }
  return counts;
}

function section<A extends string, S extends string>(
  key: BriefSectionKey,
  candidates: readonly BriefItem<A, S>[],
  cap: number,
): BriefSection<A, S> {
  return {
    key,
    heading: HEADINGS[key],
    items: candidates.slice(0, cap),
    droppedCount: Math.max(0, candidates.length - cap),
  };
}

/**
 * Nobody, as a recipient id.
 *
 * `collisionLine` is written from a recipient's side — it says "you" when the
 * reader is one of the two authors. A brief has two readers (the presenter and
 * the PI) and outlives both, so it takes the third-person path the engine
 * already documents for a collision the recipient had no part in: both members
 * named, and the page taken from the later anchor. An id that belongs to
 * nobody is how that path is selected, and it is stable no matter who opens
 * the brief.
 */
const NOBODY = "";

export type AssembledBrief<
  AnnotationId extends string = string,
  SessionId extends string = string,
> = {
  sections: BriefSection<AnnotationId, SessionId>[];
  /** Distinct annotations the brief rests on — the size of its citation surface. */
  citationCount: number;
};

/**
 * Assemble one session's brief from one paper's margin.
 *
 * - `pool` is every lab-visible, non-withdrawn annotation on the paper,
 *   replies included. Replies are never items themselves — they are what makes
 *   a thread a thread — but they are in the pool because the floor section is
 *   ranked by how many of them a note drew, and because collision detection
 *   runs over exactly the pool `convex/digests.ts` gives it.
 * - `priorSessions` maps each session on this same paper that already happened
 *   to when it was held. An open question written under one of those and never
 *   replied to is the carried-over section; the same question written under
 *   this session, or under none, is ordinary prep. Carrying a question over
 *   from a *different* paper is a different feature and not this one.
 * - `collisions`, when supplied, is a precomputed `detectCollisions(pool)`.
 *
 * A private annotation must never appear in `pool`. The brief is stored and
 * read by the PI as well as the presenter, so the one place a private note is
 * shown — the presenter's own, to the presenter — is assembled from the
 * caller's own subscription and never travels through here. See
 * `lib/brief/prep.ts`.
 */
export function assembleBrief<
  P extends string,
  A extends string,
  U extends string,
  S extends string,
>(input: {
  pool: readonly BriefAnnotation<P, A, U, S>[];
  /** The paper this meeting is about. The near side of every line below. */
  paperId: P;
  paperTitle: string;
  /** Sessions on this paper that are already behind the lab, and when each was held. */
  priorSessions: ReadonlyMap<S, number>;
  collisions?: readonly Collision<P, A, U>[];
  /**
   * A cross-paper scan, and the titles to print it with.
   *
   * One field rather than two, because a scan without titles is not a weaker
   * version of this — it is a line that names one document and cites two, and
   * a reader sent to the wrong paper for half the evidence reads it as the
   * product being wrong about its own record. The type makes the pair
   * inseparable.
   */
  crossPaper?: {
    scan: CrossPaperScan<P, A, U>;
    paperTitles: ReadonlyMap<P, string>;
  };
  cap?: number;
}): AssembledBrief<A, S> {
  const cap = input.cap ?? MAX_SECTION_ITEMS;
  const replies = replyCounts(input.pool);
  const topLevel = input.pool.filter((a) => a.parentId === undefined);

  // --- 1. Collisions ------------------------------------------------------
  // `detectCollisions` already sorts newest-collision-first and skips pairs by
  // the same author. Re-sorting is not needed and would be a second ranking.
  const collisions = input.collisions ?? detectCollisions(input.pool);
  const collisionItems: BriefItem<A, S>[] = collisions.map((collision) => ({
    text: collisionLine(collision, NOBODY, input.paperTitle),
    annotationIds: [collision.a.id, collision.b.id],
    pairType: collision.pairType,
  }));

  // --- 1b. Collisions that cross a paper ----------------------------------
  // Ranked strictly below every same-paper line, which is `byPairRank`'s rule
  // in `lib/digest/engine.ts` — copied as an ordering here rather than
  // imported, because this concatenates two already-sorted lists instead of
  // re-sorting one. Scope outranks recency on purpose: the six lines a
  // presenter reads must never fill up with quote matches while two people's
  // notes on the same passage of *this* paper go unmentioned.
  const titleOf = (paperId: P): string | undefined =>
    paperId === input.paperId
      ? input.paperTitle
      : input.crossPaper?.paperTitles.get(paperId);

  const crossItems: BriefItem<A, S>[] = (
    input.crossPaper?.scan.collisions ?? []
  ).flatMap((collision) => {
    // `a` and `b`, not near and far: this pair of titles is only ever handed
    // to `collisionLine`, which prints them in the collision's own order.
    const aTitle = titleOf(collision.a.paperId);
    const bTitle = titleOf(collision.b.paperId);
    // Exactly one side on this meeting's paper. A pair between two *other*
    // papers is a real fact and belongs in a digest, not on the agenda for a
    // meeting about neither of them.
    const touches =
      (collision.a.paperId === input.paperId) !==
      (collision.b.paperId === input.paperId);
    if (!touches || aTitle === undefined || bTitle === undefined) {
      return [];
    }
    const far =
      collision.a.paperId === input.paperId ? collision.b : collision.a;
    return [
      {
        text: collisionLine(collision, NOBODY, aTitle, bTitle),
        annotationIds: [collision.a.id, collision.b.id],
        pairType: collision.pairType,
        crossPaperIds: [far.id],
      },
    ];
  });

  // --- 2 & 3. Open questions, split by whether the lab has already met on them
  const unanswered = topLevel.filter(
    (a) => a.type === "open-question" && (replies.get(a.id) ?? 0) === 0,
  );

  // Oldest first: a question that has outlasted three meetings is the one the
  // presenter most needs to see, and recency ordering would bury it under
  // whatever was typed on Sunday.
  const carried = unanswered
    .filter(
      (a) => a.sessionId !== undefined && input.priorSessions.has(a.sessionId),
    )
    .sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : 1));

  const carriedIds = new Set<A>(carried.map((a) => a.id));

  // Newest first: this is what the lab has been writing while preparing, and
  // the presenter read the older half last time.
  const fresh = unanswered
    .filter((a) => !carriedIds.has(a.id))
    .sort((x, y) => y.createdAt - x.createdAt || (x.id < y.id ? -1 : 1));

  // --- 4. The floor -------------------------------------------------------
  // Replies are the only evidence of engagement Margin has — there is no read
  // count to rank by and there never will be — so "what drew a crowd" is
  // literally how many people wrote something back.
  const floor = topLevel
    .filter(
      (a) => FLOOR_TYPES[a.type] !== undefined && (replies.get(a.id) ?? 0) > 0,
    )
    .sort((x, y) => {
      const diff = (replies.get(y.id) ?? 0) - (replies.get(x.id) ?? 0);
      if (diff !== 0) return diff;
      if (y.createdAt !== x.createdAt) return y.createdAt - x.createdAt;
      return x.id < y.id ? -1 : 1;
    });

  const sections: BriefSection<A, S>[] = [
    {
      ...section<A, S>("collisions", [...collisionItems, ...crossItems], cap),
      // Carried on the section rather than on the brief, which is where the
      // digest keeps the same flag (`AssembledDigest.crossPaperCapped`): a
      // digest is one flat list, and a brief has four sections of which
      // exactly one was fed by the scan. A brief-level flag would be a claim
      // the floor and the open questions have no part in.
      ...(input.crossPaper?.scan.capped === true
        ? { crossPaperCapped: true }
        : {}),
    },
    section<A, S>(
      "open-questions",
      fresh.map((a) => ({ text: noteLine(a), annotationIds: [a.id] })),
      cap,
    ),
    section<A, S>(
      "carried-over",
      carried.map((a) => {
        const at =
          a.sessionId === undefined
            ? undefined
            : input.priorSessions.get(a.sessionId);
        return {
          text: noteLine(a),
          annotationIds: [a.id],
          ...(a.sessionId === undefined ? {} : { fromSessionId: a.sessionId }),
          ...(at === undefined ? {} : { fromSessionAt: at }),
        };
      }),
      cap,
    ),
    section<A, S>(
      "floor",
      floor.map((a) => {
        const count = replies.get(a.id) ?? 0;
        const noun = count === 1 ? "reply" : "replies";
        return {
          text: `${noteLine(a, FLOOR_TYPES[a.type])} — ${count} ${noun}`,
          annotationIds: [a.id],
        };
      }),
      cap,
    ),
  ];

  const cited = new Set<A>();
  for (const one of sections) {
    for (const item of one.items) {
      for (const id of item.annotationIds) cited.add(id);
    }
  }

  return { sections, citationCount: cited.size };
}
