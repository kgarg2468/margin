/**
 * What a discussion leaves behind, as pure functions.
 *
 * Ctx-free in the same way `lib/brief/assemble.ts` is, and for the same reason:
 * `convex/actions.ts` does the reading, the authorization and the writing, and
 * this module decides what an hour of argument amounts to and which parts of it
 * travel to the next meeting. The policy is unit-testable against the shapes it
 * was written for rather than against a deployment.
 *
 * ## Three kinds, and why exactly three
 *
 * A journal club ends in one of three states per thing it touched: the lab
 * settled it, the lab failed to settle it, or somebody agreed to go and find
 * out. Those are a **decision**, a **question**, and a **task**, and the
 * distinction is not cosmetic — it is what decides whether the thing comes back.
 *
 * A decision is closed by construction: recording one *is* the settling, and a
 * decision that could be marked done later would be a decision nobody had made.
 * A question and a task are open until somebody says otherwise, and while they
 * are open they are carried onto the next meeting about the same paper. That is
 * the whole loop the roadmap asks for — this week's outcomes make next week's
 * page better — and `settles()` is the one predicate the rest of it rests on.
 *
 * ## What is deliberately not here
 *
 * No due dates. A due date on a lab task is either the next journal club or
 * nothing, and the next journal club is a row in `sessions` rather than a field
 * somebody has to keep true. No priorities and no statuses beyond open/settled:
 * a list of five things a lab agreed to do does not need a workflow, and every
 * extra state is one more thing that goes stale in a margin.
 *
 * No cross-paper carry either. Carrying forward stops at the paper boundary,
 * exactly where `detectCollisions` does — lifting it is Phase 2's, and lifting
 * it here first would mean a session about one paper opening with an unanswered
 * question about another.
 */

/** The three shapes an hour of discussion can leave behind. */
export type OutcomeKind = "decision" | "question" | "task";

/**
 * Fixed order, and it is the order they are read in: what we settled, what we
 * didn't, what we're doing about it. A panel that reshuffled its sections by
 * how many items were in them would be a different page every week.
 */
export const OUTCOME_KINDS: readonly OutcomeKind[] = [
  "decision",
  "question",
  "task",
];

/**
 * Long enough for the sentence somebody says out loud when the room agrees;
 * short enough that nobody mistakes this for the write-up. The synthesis is
 * where prose goes.
 */
export const MAX_OUTCOME_BODY = 1_000;

/**
 * How many carried-forward items one session's panel shows.
 *
 * A ceiling on the page rather than on the lab: past eight open items dragged
 * in from earlier meetings, the honest reading is that this paper has a backlog
 * and the panel says how much of it it is holding back rather than becoming it.
 */
export const MAX_CARRIED_FORWARD = 8;

/**
 * One outcome, flattened to what this module reasons about.
 *
 * The body is deliberately absent: nothing in here reads it. Grouping, ordering
 * and carrying are decided by kind, by whether it was settled, and by when —
 * so the functions stay generic over the caller's row and hand back the very
 * objects they were given, prose and citations and all.
 */
export type Outcome<
  UserId extends string = string,
  SessionId extends string = string,
> = {
  kind: OutcomeKind;
  /** The meeting that produced it. */
  sessionId: SessionId;
  recordedAt: number;
  /** Tasks only: the member who took it on. */
  ownerId?: UserId;
  /** When somebody declared it carried no further. Absent means open. */
  settledAt?: number;
};

/**
 * Whether this kind of outcome has an open state at all.
 *
 * The single place the rule lives, because it is asked in four: the panel draws
 * a "mark it done" control from it, the carry-forward filter reads it, the
 * tally counts from it, and `convex/actions.ts` refuses to settle a decision
 * with it. A decision is settled by the act of recording it — offering to close
 * one would be offering to make a decision that had not yet been made.
 */
export function settles(kind: OutcomeKind): boolean {
  return kind !== "decision";
}

/** Still outstanding: a question nobody answered, or a task nobody finished. */
export function isOpen(outcome: Outcome): boolean {
  return settles(outcome.kind) && outcome.settledAt === undefined;
}

export type OutcomeGroup<O> = {
  kind: OutcomeKind;
  items: O[];
  /** How many of them are still outstanding — zero for decisions, always. */
  openCount: number;
};

/**
 * The session's own outcomes, cut into their three kinds.
 *
 * Every kind gets a group even when it is empty. A lab that settled nothing
 * this week is a fact about the meeting, and a heading that appears only once
 * there is something under it would move the rest of the page while somebody
 * was reading it — the same argument `FloorColumns` makes for drawing empty
 * columns.
 *
 * Within a group: open first, then newest first. Outstanding items are what a
 * reader came for, and among equals the recent one is the one the room still
 * remembers. Ties break on nothing further — two outcomes recorded in the same
 * millisecond are the same moment, and inventing an order for them would only
 * make the panel's sort unstable across reads.
 */
export function groupOutcomes<O extends Outcome>(
  outcomes: readonly O[],
): OutcomeGroup<O>[] {
  return OUTCOME_KINDS.map((kind) => {
    const items = outcomes
      .filter((outcome) => outcome.kind === kind)
      .sort((a, b) => {
        const openness = Number(isOpen(b)) - Number(isOpen(a));
        return openness !== 0 ? openness : b.recordedAt - a.recordedAt;
      });
    return { kind, items, openCount: items.filter(isOpen).length };
  });
}

/** An outcome from an earlier meeting, with the meeting it came from. */
export type CarriedOutcome<O> = {
  outcome: O;
  /** When the meeting that left it open was held. */
  fromSessionAt: number;
};

export type CarryForward<O> = {
  items: CarriedOutcome<O>[];
  /** How many the cap held back, so the panel can say so rather than pretend. */
  droppedCount: number;
};

/**
 * What earlier meetings on this paper left open, for the meeting in front of us.
 *
 * The carried-forward affordance, and the reason this feature is worth building
 * twice over: week one it is empty, and by week six it is why somebody opens the
 * page. A question the lab failed to answer in March is not a fact about March —
 * it is the first item of the next hour, and a product that makes the room
 * re-derive it every time is a product the room stops trusting to remember.
 *
 * `priorSessions` maps an earlier session to when it was held, and it is the
 * *only* gate on which sessions qualify. The caller builds it — see
 * `convex/actions.ts`, which mirrors `briefs.priorSessions` — so the rules about
 * which meetings count (held, not cancelled, not this one, capped) live where
 * the query does, and this module cannot silently disagree with the brief about
 * what a prior session is.
 *
 * Ordering is newest meeting first, then newest outcome, on the same reasoning
 * the brief's carried-over section uses: the further back a question was left
 * open, the less of it the room still has. Settled outcomes and decisions never
 * appear — a decision does not carry, it *holds*, and re-raising one at the next
 * meeting would be the panel asking the lab to settle something twice.
 */
export function carryForward<O extends Outcome>({
  outcomes,
  priorSessions,
  cap = MAX_CARRIED_FORWARD,
}: {
  outcomes: readonly O[];
  /** Earlier meeting → when it was held. Branded id keys are strings and fit. */
  priorSessions: ReadonlyMap<string, number>;
  cap?: number;
}): CarryForward<O> {
  const carried: CarriedOutcome<O>[] = [];
  for (const outcome of outcomes) {
    const fromSessionAt = priorSessions.get(outcome.sessionId);
    if (fromSessionAt === undefined || !isOpen(outcome)) {
      continue;
    }
    carried.push({ outcome, fromSessionAt });
  }

  carried.sort((a, b) => {
    const when = b.fromSessionAt - a.fromSessionAt;
    return when !== 0 ? when : b.outcome.recordedAt - a.outcome.recordedAt;
  });

  return {
    items: carried.slice(0, cap),
    droppedCount: Math.max(0, carried.length - cap),
  };
}

export type Tally = {
  decisions: number;
  questions: number;
  tasks: number;
  /** Questions and tasks still outstanding, across both. */
  open: number;
};

/**
 * The one line above the panel: what this meeting came to.
 *
 * Counts of outcomes, never of people. There is no per-member breakdown here
 * and there is not going to be one — "who recorded the most decisions" is a
 * leaderboard, and a lab that can be ranked by it is a lab that starts
 * performing for it.
 */
export function tally(outcomes: readonly Outcome[]): Tally {
  const counts: Tally = { decisions: 0, questions: 0, tasks: 0, open: 0 };
  for (const outcome of outcomes) {
    if (outcome.kind === "decision") counts.decisions += 1;
    if (outcome.kind === "question") counts.questions += 1;
    if (outcome.kind === "task") counts.tasks += 1;
    if (isOpen(outcome)) counts.open += 1;
  }
  return counts;
}

/**
 * Tidy what somebody typed in a hurry.
 *
 * Trailing whitespace only, exactly as `annotations.cleanBody` does it: leading
 * indentation can be deliberate in an outcome that quotes a condition, and an
 * outcome typed while a meeting is still talking arrives with a stray newline
 * more often than not. Length is checked by the caller rather than trimmed
 * here — a silent `slice` hands a member a success for a sentence whose second
 * half is gone.
 */
export function normalizeBody(input: string): string {
  return input.replace(/\s+$/, "");
}

/** How each kind reads: as a heading, and as a thing in a sentence. */
export const KIND_COPY: Record<
  OutcomeKind,
  { heading: string; one: string; many: string; empty: string }
> = {
  decision: {
    heading: "Decided",
    one: "decision",
    many: "decisions",
    empty: "Nothing settled here yet.",
  },
  question: {
    heading: "Left open",
    one: "open question",
    many: "open questions",
    empty: "No question was left hanging.",
  },
  task: {
    heading: "Someone's doing",
    one: "task",
    many: "tasks",
    empty: "Nobody took anything on.",
  },
};
