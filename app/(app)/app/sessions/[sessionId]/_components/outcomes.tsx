"use client";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  groupOutcomes,
  settles,
  tally,
  KIND_COPY,
  MAX_OUTCOME_BODY,
  OUTCOME_KINDS,
  type OutcomeKind,
} from "@/lib/actions";
import { formatDate } from "@/lib/sessions-ui";
import {
  errorClass,
  eyebrowClass,
  labelClass,
  secondaryButtonClass,
  selectClass,
  textareaClass,
} from "@/lib/ui";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { ConfirmAction } from "../../../_components/confirm-action";
import { readableError } from "../../../_components/errors";
import type { AnnotationView } from "../../../library/[paperId]/read/_components/types";
import type { SessionDetail } from "./manage";

/**
 * What the room is carrying: the outcomes half of the ritual.
 *
 * A journal club that ends without this is an hour of good argument that
 * evaporates on the walk back to the bench. The panel records the three things
 * an hour can produce — something settled, something left open, something
 * somebody agreed to do — and, above them, whatever earlier meetings about this
 * same paper left open and nobody has closed since.
 *
 * That carried block is the point of the whole feature. Week one it is empty.
 * By week six it is the first thing on the page and the reason somebody opens
 * it: the lab's own unanswered question from March, at the top of April's
 * meeting, without anybody having to remember it was asked.
 *
 * ## Where the rules live
 *
 * Not here. Which kinds have an open state, what carries forward and in what
 * order is `lib/actions/outcomes.ts`, shared with `convex/actions.ts` so the
 * panel cannot disagree with the query about what "still open" means. Who may
 * settle or withdraw a given row is decided on the server and arrives as
 * `canSettle` / `canAssign` / `canWithdraw`, so nothing in this file re-derives
 * a permission.
 *
 * ## Ink
 *
 * Borrowed from the annotation ontology rather than invented: an open question
 * here is the same violet as an open question in the margin, because it is the
 * same kind of thing one step further along.
 */

const KIND_INK: Record<OutcomeKind, string> = {
  decision: "var(--note-method)",
  question: "var(--note-question)",
  task: "var(--note-definition)",
};

type Listing = FunctionReturnType<typeof api.actions.listForSession>;
type OutcomeRow = Listing["outcomes"][number];

/** Enough of a passage to recognise it in a menu; the card shows the rest. */
const PICKER_SNIPPET = 80;
/** A citation menu is for finding a note you remember, not for reading the paper. */
const MAX_CITABLE = 60;

export function SessionOutcomes({
  session,
  rows,
}: {
  session: SessionDetail;
  /**
   * The paper's margin, as the caller already has it. The citation picker is
   * built from this rather than from a second query: it is the same
   * subscription the board renders, so the menu cannot offer a note the page
   * has stopped showing.
   */
  rows: readonly AnnotationView[];
}) {
  const listing = useQuery(api.actions.listForSession, {
    sessionId: session._id,
  });
  const [recording, setRecording] = useState(false);

  if (listing === undefined) {
    return null;
  }

  const counts = tally(listing.outcomes);
  const groups = groupOutcomes(listing.outcomes);
  const nothingYet = listing.outcomes.length === 0;

  return (
    <section className="flex flex-col gap-6 border-t border-rule pt-8">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h2 className={eyebrowClass}>What the room is carrying</h2>
        {!nothingYet && (
          <p className="font-sans text-xs text-ink-faint tabular-nums">
            {summarize(counts)}
          </p>
        )}
      </div>

      {listing.carried.length > 0 && (
        <CarriedForward
          carried={listing.carried}
          dropped={listing.carriedDroppedCount}
          labId={session.labId}
        />
      )}

      {nothingYet ? (
        // Three different silences, and saying which one it is matters. A
        // meeting still on the calendar has produced nothing *yet* and cannot
        // be made to; one that was called off produced nothing and never will;
        // one that was held and left no record is the only one where the
        // absence is a gap somebody could fill.
        <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
          {session.status === "scheduled"
            ? "This meeting hasn’t happened yet, so there is nothing to carry out of it. What the room settles — and what it leaves open — gets written down here once the session starts."
            : session.status === "cancelled"
              ? "This meeting was called off, so there was no discussion for it to have produced anything."
              : "Nothing recorded from this meeting yet. A decision, a question the lab couldn’t settle, or a task somebody took on — the open ones travel to the next session about this paper."}
        </p>
      ) : (
        <div className="grid items-start gap-x-8 gap-y-8 md:grid-cols-3">
          {groups.map((group) => (
            <section key={group.kind} className="flex flex-col gap-3">
              <h3 className="flex items-baseline gap-2">
                <span
                  style={{ color: KIND_INK[group.kind] }}
                  className={eyebrowClass}
                >
                  {KIND_COPY[group.kind].heading}
                </span>
                {group.items.length > 0 && (
                  <span className="font-sans text-[11px] text-ink-faint tabular-nums">
                    {group.items.length}
                    {group.openCount > 0 ? ` · ${group.openCount} open` : ""}
                  </span>
                )}
              </h3>
              {group.items.length === 0 ? (
                <p className="font-serif text-sm leading-relaxed text-ink-faint">
                  {KIND_COPY[group.kind].empty}
                </p>
              ) : (
                <ul className="flex flex-col gap-4">
                  {group.items.map((outcome) => (
                    <OutcomeCard
                      key={outcome._id}
                      outcome={outcome}
                      labId={session.labId}
                    />
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}

      {listing.canRecord &&
        (recording ? (
          <RecordOutcome
            session={session}
            rows={rows}
            onDone={() => setRecording(false)}
          />
        ) : (
          <button
            type="button"
            onClick={() => setRecording(true)}
            className={`${secondaryButtonClass} self-start`}
          >
            Record an outcome
          </button>
        ))}
    </section>
  );
}

/** "2 decisions · 3 open" — counts of outcomes, never of people. */
function summarize(counts: ReturnType<typeof tally>): string {
  const parts: string[] = [];
  for (const kind of OUTCOME_KINDS) {
    const n =
      kind === "decision"
        ? counts.decisions
        : kind === "question"
          ? counts.questions
          : counts.tasks;
    if (n > 0) {
      parts.push(`${n} ${n === 1 ? KIND_COPY[kind].one : KIND_COPY[kind].many}`);
    }
  }
  if (counts.open > 0) {
    parts.push(`${counts.open} still open`);
  }
  return parts.join(" · ");
}

/**
 * What earlier meetings on this paper left open.
 *
 * Above the session's own outcomes, and drawn as arriving from somewhere else —
 * a rule down the left and the date of the meeting that left it. These rows are
 * live: settling one here settles it where it was recorded, because it is the
 * same row and there is only ever one of it.
 */
function CarriedForward({
  carried,
  dropped,
  labId,
}: {
  carried: Listing["carried"];
  dropped: number;
  labId: Id<"labs">;
}) {
  return (
    <div className="flex flex-col gap-3 border-l-2 border-rule pl-4">
      <h3 className={eyebrowClass}>Still open from earlier meetings</h3>
      <ul className="flex flex-col gap-4">
        {carried.map((item) => (
          <li key={item.outcome._id} className="flex flex-col gap-1">
            <OutcomeBody outcome={item.outcome} />
            <p className="font-sans text-[11px] text-ink-faint tabular-nums">
              Left open{" "}
              {item.fromSessionTitle !== undefined
                ? `at ${item.fromSessionTitle}, `
                : ""}
              {formatDate(item.fromSessionAt)}
            </p>
            <OutcomeControls outcome={item.outcome} labId={labId} />
          </li>
        ))}
      </ul>
      {dropped > 0 && (
        <p className="font-sans text-xs text-ink-faint tabular-nums">
          and {dropped} more still open on this paper.
        </p>
      )}
    </div>
  );
}

function OutcomeCard({
  outcome,
  labId,
}: {
  outcome: OutcomeRow;
  labId: Id<"labs">;
}) {
  return (
    <li
      style={{ borderLeftColor: KIND_INK[outcome.kind] }}
      className="flex flex-col gap-1 border-l-2 pl-3"
    >
      <OutcomeBody outcome={outcome} />
      <OutcomeControls outcome={outcome} labId={labId} />
    </li>
  );
}

/**
 * The sentence somebody wrote, its owner, and the note it came out of.
 *
 * The citation is re-checked on the server on every read, so a note that has
 * since been withdrawn or made private arrives here with no quote at all. The
 * card says so rather than dropping the line: an outcome that cited something
 * did cite something, and pretending otherwise would make the record thinner
 * than the meeting was.
 */
function OutcomeBody({ outcome }: { outcome: OutcomeRow }) {
  const settled = outcome.settledAt !== undefined;

  return (
    <>
      <p
        className={
          "whitespace-pre-wrap font-serif text-[15px] leading-relaxed " +
          (settled ? "text-ink-muted line-through decoration-1" : "text-ink")
        }
      >
        {outcome.body}
      </p>

      <p className="font-sans text-[11px] text-ink-faint">
        {outcome.mine ? "You" : outcome.recordedByName}
        {outcome.ownerName !== undefined ? ` · with ${outcome.ownerName}` : ""}
        {settled
          ? ` · ${outcome.kind === "task" ? "done" : "settled"}${
              outcome.settledByName === undefined
                ? ""
                : ` by ${outcome.settledByName}`
            }`
          : ""}
      </p>

      {outcome.citation !== undefined &&
        (outcome.citation.withdrawn ? (
          <p className="font-serif text-[13px] italic leading-snug text-ink-faint">
            The note this came out of is no longer shared with the lab.
          </p>
        ) : (
          <blockquote className="font-serif text-[13px] italic leading-snug text-ink-faint">
            <span className="line-clamp-2">{outcome.citation.quote}</span>
            <span className="not-italic tabular-nums">
              {outcome.citation.authorName !== undefined
                ? ` — ${outcome.citation.authorName}`
                : ""}
              {outcome.citation.pageIndex !== undefined
                ? `, p. ${outcome.citation.pageIndex + 1}`
                : ""}
            </span>
          </blockquote>
        ))}
    </>
  );
}

/** Settle it, hand it on, or take it back — whichever of those the server allowed. */
function OutcomeControls({
  outcome,
  labId,
}: {
  outcome: OutcomeRow;
  labId: Id<"labs">;
}) {
  const setSettled = useMutation(api.actions.setSettled);
  const remove = useMutation(api.actions.remove);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [assigning, setAssigning] = useState(false);

  const settled = outcome.settledAt !== undefined;
  const anything = outcome.canSettle || outcome.canWithdraw || outcome.canAssign;
  if (!anything) {
    return null;
  }

  async function run(action: () => Promise<unknown>, fallback: string) {
    setError(null);
    setPending(true);
    try {
      await action();
    } catch (caught) {
      setError(readableError(caught, fallback));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        {outcome.canSettle && (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              void run(
                () =>
                  setSettled({ actionId: outcome._id, settled: !settled }),
                "That didn't take.",
              )
            }
            className="font-sans text-xs text-accent underline-offset-4 hover:underline disabled:opacity-50 tap-target"
          >
            {settled
              ? "Reopen"
              : outcome.kind === "task"
                ? "Mark it done"
                : "Mark it answered"}
          </button>
        )}

        {outcome.canAssign && (
          <button
            type="button"
            aria-expanded={assigning}
            onClick={() => setAssigning((open) => !open)}
            className="font-sans text-xs text-ink-faint underline-offset-4 hover:text-accent hover:underline tap-target"
          >
            {assigning
              ? "Never mind"
              : outcome.ownerName === undefined
                ? "Give it to someone"
                : "Hand it on"}
          </button>
        )}

        {outcome.canWithdraw && (
          <ConfirmAction
            label="Withdraw"
            confirmLabel="Take it off the record"
            cancelLabel="Keep it"
            tone="faint"
            run={() =>
              run(
                () => remove({ actionId: outcome._id }),
                "That didn't come off.",
              )
            }
          />
        )}
      </div>

      {assigning && (
        <OwnerPicker
          outcome={outcome}
          labId={labId}
          onDone={() => setAssigning(false)}
        />
      )}

      {error !== null && (
        <p role="alert" aria-live="polite" className={errorClass}>
          {error}
        </p>
      )}
    </div>
  );
}

function OwnerPicker({
  outcome,
  labId,
  onDone,
}: {
  outcome: OutcomeRow;
  labId: Id<"labs">;
  onDone: () => void;
}) {
  const members = useQuery(api.labs.listMembers, { labId });
  const setOwner = useMutation(api.actions.setOwner);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (members === undefined) {
    return null;
  }

  return (
    <div className="pop-in flex flex-col gap-1">
      <label htmlFor={`owner-${outcome._id}`} className="sr-only">
        Who is doing this
      </label>
      <select
        id={`owner-${outcome._id}`}
        defaultValue={outcome.ownerId ?? ""}
        disabled={pending}
        className={`${selectClass} max-w-xs`}
        onChange={async (event) => {
          const ownerId = event.target.value as Id<"users">;
          if (ownerId.length === 0) {
            return;
          }
          setError(null);
          setPending(true);
          try {
            await setOwner({ actionId: outcome._id, ownerId });
            onDone();
          } catch (caught) {
            setError(readableError(caught, "That didn't stick."));
          } finally {
            setPending(false);
          }
        }}
      >
        <option value="">Who is doing this?</option>
        {members.map((member) => (
          <option key={member.userId} value={member.userId}>
            {member.isYou ? "You" : (member.name ?? member.email ?? "A lab member")}
          </option>
        ))}
      </select>
      {error !== null && (
        <p role="alert" aria-live="polite" className={errorClass}>
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Writing one down, in the shape of the sentence somebody is about to say.
 *
 * Kind first, because it is the decision that changes what the rest of the form
 * means: an owner only exists on a task, and only a question or a task will
 * come back next week. The note it came out of is optional and offered from the
 * margin the page is already showing — which is how an annotation becomes an
 * outcome without the board needing a control on every card.
 */
function RecordOutcome({
  session,
  rows,
  onDone,
}: {
  session: SessionDetail;
  rows: readonly AnnotationView[];
  onDone: () => void;
}) {
  const record = useMutation(api.actions.record);
  const members = useQuery(api.labs.listMembers, { labId: session.labId });
  const [kind, setKind] = useState<OutcomeKind>("decision");
  const [body, setBody] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [citedAnnotationId, setCited] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Only notes the lab can actually see: citing a private note would publish
  // its existence through the side door of a decision, and the server refuses
  // it anyway. Top-level only — a reply is part of a thread, and the thread's
  // note is the thing an outcome came out of.
  const citable = rows
    .filter(
      (row) =>
        row.visibility === "lab" &&
        !row.deleted &&
        row.parentId === undefined,
    )
    .slice(0, MAX_CITABLE);

  return (
    <form
      className="pop-in flex max-w-xl flex-col gap-4 rounded-md border border-rule bg-surface p-4 shadow-[var(--shadow-card)]"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        setPending(true);
        try {
          await record({
            sessionId: session._id,
            kind,
            body,
            ...(citedAnnotationId.length === 0
              ? {}
              : { citedAnnotationId: citedAnnotationId as Id<"annotations"> }),
            ...(kind === "task" && ownerId.length > 0
              ? { ownerId: ownerId as Id<"users"> }
              : {}),
          });
          setBody("");
          setOwnerId("");
          setCited("");
          onDone();
        } catch (caught) {
          setError(readableError(caught, "That outcome didn't save."));
        } finally {
          setPending(false);
        }
      }}
    >
      <fieldset className="flex flex-col gap-2">
        <legend className={labelClass}>What kind of outcome</legend>
        <div className="flex flex-wrap gap-2">
          {OUTCOME_KINDS.map((one) => {
            const active = kind === one;
            return (
              <button
                key={one}
                type="button"
                aria-pressed={active}
                onClick={() => setKind(one)}
                style={active ? { color: KIND_INK[one], borderColor: KIND_INK[one] } : undefined}
                className={
                  "rounded-sm border px-2 py-1 font-sans text-[11px] uppercase tracking-[0.12em] " +
                  "motion-safe:transition-colors motion-safe:duration-200 " +
                  (active
                    ? "font-medium"
                    : "border-rule text-ink-faint hover:border-ink-faint")
                }
              >
                {KIND_COPY[one].one}
              </button>
            );
          })}
        </div>
        <p className="font-sans text-[11px] text-ink-faint">
          {settles(kind)
            ? "This travels to the next session on this paper until somebody settles it."
            : "A decision is settled by being recorded — it holds rather than travels."}
        </p>
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="outcome-body" className={labelClass}>
          What was it
        </label>
        <textarea
          id="outcome-body"
          rows={3}
          required
          value={body}
          maxLength={MAX_OUTCOME_BODY}
          onChange={(event) => setBody(event.target.value)}
          placeholder={
            kind === "decision"
              ? "We're going with the 4°C protocol…"
              : kind === "question"
                ? "Nobody could say why the effect only shows at n > 30…"
                : "Re-run the assay and bring the numbers…"
          }
          className={`${textareaClass} resize-y`}
        />
      </div>

      {kind === "task" && members !== undefined && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="outcome-owner" className={labelClass}>
            Who is doing it
          </label>
          <select
            id="outcome-owner"
            value={ownerId}
            onChange={(event) => setOwnerId(event.target.value)}
            className={selectClass}
          >
            <option value="">Nobody yet</option>
            {members.map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.isYou
                  ? "You"
                  : (member.name ?? member.email ?? "A lab member")}
              </option>
            ))}
          </select>
        </div>
      )}

      {citable.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="outcome-citation" className={labelClass}>
            Out of a note (optional)
          </label>
          <select
            id="outcome-citation"
            value={citedAnnotationId}
            onChange={(event) => setCited(event.target.value)}
            className={selectClass}
          >
            <option value="">No note</option>
            {citable.map((row) => (
              <option key={row._id} value={row._id}>
                {pickerLabel(row)}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={pending || body.trim().length === 0}
          className={secondaryButtonClass}
        >
          {pending ? "Recording…" : "Record it"}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="font-sans text-sm text-ink-faint underline-offset-4 hover:text-accent hover:underline"
        >
          Never mind
        </button>
      </div>

      {error !== null && (
        <p role="alert" aria-live="polite" className={errorClass}>
          {error}
        </p>
      )}
    </form>
  );
}

/** A note in a menu: whose it is, and enough of it to recognise. */
function pickerLabel(row: AnnotationView): string {
  const who = row.mine ? "You" : row.authorName;
  // A bare highlight has no body — the passage is what it said.
  const said = row.body.trim().length > 0 ? row.body.trim() : row.anchor.quote;
  const flat = said.replace(/\s+/g, " ");
  const text =
    flat.length > PICKER_SNIPPET
      ? `${flat.slice(0, PICKER_SNIPPET).trimEnd()}…`
      : flat;
  return `${who}, p. ${row.anchor.pageIndex + 1} — ${text}`;
}
