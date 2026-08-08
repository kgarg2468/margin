"use client";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import {
  fromLocalInputValue,
  toLocalInputValue,
} from "@/lib/sessions-ui";
import {
  errorClass,
  eyebrowClass,
  inputClass,
  labelClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/lib/ui";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { readableError } from "../../../_components/errors";

export type SessionDetail = NonNullable<
  FunctionReturnType<typeof api.sessions.getSession>
>;

/**
 * A two-step affordance for anything that can't be undone: the first click
 * arms it, the second commits.
 *
 * The same shape as the one in `_components/lab-overview.tsx`. Deliberately a
 * second copy rather than a shared control — hoisting it would mean editing the
 * lab overview, which this change has no other reason to touch. Flagged as a
 * duplicate worth collapsing the next time either one is edited.
 */
function ConfirmAction({
  label,
  confirmLabel,
  run,
}: {
  label: string;
  confirmLabel: string;
  run: () => Promise<void>;
}) {
  const [armed, setArmed] = useState(false);
  const [pending, setPending] = useState(false);

  if (!armed) {
    return (
      <button
        type="button"
        className="font-sans text-sm text-ink-faint underline-offset-4 hover:text-accent hover:underline"
        onClick={() => setArmed(true)}
      >
        {label}
      </button>
    );
  }

  return (
    <span className="flex items-baseline gap-3">
      <button
        type="button"
        disabled={pending}
        className="font-sans text-sm font-medium text-accent-strong underline underline-offset-4 disabled:cursor-not-allowed disabled:opacity-50"
        onClick={async () => {
          setPending(true);
          try {
            await run();
          } finally {
            setPending(false);
            setArmed(false);
          }
        }}
      >
        {pending ? "Working…" : confirmLabel}
      </button>
      <button
        type="button"
        disabled={pending}
        className="font-sans text-sm text-ink-faint underline-offset-4 hover:underline"
        onClick={() => setArmed(false)}
      >
        Keep it
      </button>
    </span>
  );
}

/**
 * Running the meeting: start it, move it, hand it over, call it off.
 *
 * Only rendered for the presenter, whoever scheduled it, or the PI — the
 * server decides that and hands it back as `canManage`, so this component
 * never re-derives the rule.
 *
 * Starting is the loud button and cancelling is quiet text, because one of them
 * is what somebody came here to do and the other is a thing you should have to
 * mean. Both are irreversible; only cancelling arms first, since a session
 * started by mistake can simply be ended.
 */
export function ManageSession({ session }: { session: SessionDetail }) {
  const startSession = useMutation(api.sessions.startSession);
  const endSession = useMutation(api.sessions.endSession);
  const cancelSession = useMutation(api.sessions.cancelSession);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [moving, setMoving] = useState(false);

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

  if (session.status === "cancelled" || session.status === "synthesized") {
    return null;
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className={eyebrowClass}>Running it</h2>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        {session.status === "scheduled" && (
          <button
            type="button"
            disabled={pending}
            className={primaryButtonClass}
            onClick={() =>
              void run(
                () => startSession({ sessionId: session._id }),
                "That session didn't start.",
              )
            }
          >
            {pending ? "Starting…" : "Start session"}
          </button>
        )}

        {session.status === "live" && (
          <button
            type="button"
            disabled={pending}
            className={secondaryButtonClass}
            onClick={() =>
              void run(
                () => endSession({ sessionId: session._id }),
                "That session didn't end.",
              )
            }
          >
            {pending ? "Ending…" : "End session"}
          </button>
        )}

        {session.status === "scheduled" && (
          <>
            <button
              type="button"
              aria-expanded={moving}
              onClick={() => setMoving((open) => !open)}
              className="font-sans text-sm text-accent underline-offset-4 hover:underline"
            >
              {moving ? "Never mind" : "Move it"}
            </button>
            <ConfirmAction
              label="Cancel session"
              confirmLabel="Call it off"
              run={() =>
                run(
                  () => cancelSession({ sessionId: session._id }),
                  "That session didn't cancel.",
                )
              }
            />
          </>
        )}
      </div>

      {moving && session.status === "scheduled" && (
        <Reschedule session={session} onDone={() => setMoving(false)} />
      )}

      {(session.status === "scheduled" || session.status === "live") && (
        <PresenterPicker session={session} />
      )}

      {error !== null && (
        <p role="alert" aria-live="polite" className={errorClass}>
          {error}
        </p>
      )}
    </section>
  );
}

function Reschedule({
  session,
  onDone,
}: {
  session: SessionDetail;
  onDone: () => void;
}) {
  const updateSession = useMutation(api.sessions.updateSession);
  const [when, setWhen] = useState(() =>
    toLocalInputValue(session.scheduledAt),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const scheduledAt = fromLocalInputValue(when);

  return (
    <form
      className="flex flex-wrap items-end gap-4 rounded-md border border-rule bg-surface p-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (scheduledAt === null) {
          setError("Pick a time first.");
          return;
        }
        setError(null);
        setPending(true);
        try {
          await updateSession({ sessionId: session._id, scheduledAt });
          onDone();
        } catch (caught) {
          setError(readableError(caught, "That time didn't take."));
        } finally {
          setPending(false);
        }
      }}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor="reschedule-when" className={labelClass}>
          New time
        </label>
        <input
          id="reschedule-when"
          type="datetime-local"
          required
          value={when}
          min={toLocalInputValue(Date.now())}
          onChange={(event) => setWhen(event.target.value)}
          className={inputClass}
        />
      </div>
      <button type="submit" disabled={pending} className={secondaryButtonClass}>
        {pending ? "Moving…" : "Move session"}
      </button>
      {error !== null && (
        <p role="alert" aria-live="polite" className={`${errorClass} w-full`}>
          {error}
        </p>
      )}
    </form>
  );
}

/**
 * Handing the session to somebody else — the thing that happens when the
 * presenter is off sick on the morning of, which is why it stays available
 * right through the meeting.
 */
function PresenterPicker({ session }: { session: SessionDetail }) {
  const members = useQuery(api.labs.listMembers, { labId: session.labId });
  const updateSession = useMutation(api.sessions.updateSession);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (members === undefined) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="session-presenter-change" className={labelClass}>
        Presenter
      </label>
      <select
        id="session-presenter-change"
        value={session.presenterId}
        disabled={pending}
        className={`${inputClass} max-w-xs`}
        onChange={async (event) => {
          const presenterId = event.target.value as Id<"users">;
          setError(null);
          setPending(true);
          try {
            await updateSession({ sessionId: session._id, presenterId });
          } catch (caught) {
            setError(readableError(caught, "That presenter didn't stick."));
          } finally {
            setPending(false);
          }
        }}
      >
        {members.map((member) => (
          <option key={member.userId} value={member.userId}>
            {member.isYou
              ? "You"
              : (member.name ?? member.email ?? "A lab member")}
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
 * The presenter's outline.
 *
 * Prose in a textarea rather than a structured agenda: what a presenter writes
 * the night before is a list of things to raise, and every structure we could
 * impose on that is one the next presenter would fight. It stays editable right
 * through `ended`, because the useful edit is the one made after the meeting —
 * and it closes once a synthesis exists, since the write-up was made from a
 * particular set of notes.
 */
export function PresenterNotes({ session }: { session: SessionDetail }) {
  const updateSession = useMutation(api.sessions.updateSession);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.presenterNotes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const closed = session.status === "synthesized";
  const notes = session.presenterNotes;

  if (!session.canManage && (notes === undefined || notes.length === 0)) {
    return null;
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className={eyebrowClass}>Presenter&rsquo;s notes</h2>

      {editing ? (
        <div className="flex flex-col gap-3">
          <label htmlFor="presenter-notes" className="sr-only">
            Presenter&rsquo;s notes
          </label>
          <textarea
            id="presenter-notes"
            rows={8}
            value={draft}
            maxLength={20_000}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="What you want to take the lab through…"
            className="w-full resize-y rounded-sm border border-rule bg-surface px-3 py-2 font-serif text-base leading-relaxed text-ink placeholder:text-ink-faint"
          />
          <div className="flex flex-wrap items-center gap-4">
            <button
              type="button"
              disabled={pending}
              className={secondaryButtonClass}
              onClick={async () => {
                setError(null);
                setPending(true);
                try {
                  await updateSession({
                    sessionId: session._id,
                    presenterNotes: draft,
                  });
                  setEditing(false);
                } catch (caught) {
                  setError(readableError(caught, "Those notes didn't save."));
                } finally {
                  setPending(false);
                }
              }}
            >
              {pending ? "Saving…" : "Save notes"}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(notes ?? "");
                setEditing(false);
              }}
              className="font-sans text-sm text-ink-faint underline-offset-4 hover:text-accent hover:underline"
            >
              Discard changes
            </button>
          </div>
        </div>
      ) : (
        <>
          {notes === undefined || notes.length === 0 ? (
            <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
              No outline yet. What you write here sits beside the lab&rsquo;s
              margin during the meeting, and it is what the write-up reads
              afterwards.
            </p>
          ) : (
            <p className="max-w-prose whitespace-pre-wrap font-serif text-base leading-relaxed text-ink">
              {notes}
            </p>
          )}
          {session.canManage && !closed && (
            <button
              type="button"
              onClick={() => {
                setDraft(notes ?? "");
                setEditing(true);
              }}
              className="self-start font-sans text-sm text-accent underline-offset-4 hover:underline"
            >
              {notes === undefined || notes.length === 0
                ? "Write an outline"
                : "Edit notes"}
            </button>
          )}
        </>
      )}

      {error !== null && (
        <p role="alert" aria-live="polite" className={errorClass}>
          {error}
        </p>
      )}
    </section>
  );
}
