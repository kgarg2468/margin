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
  selectClass,
} from "@/lib/ui";
import { awayProse, startWindow } from "@/lib/session-window";
import { useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { useCallback, useEffect, useState } from "react";
import { ConfirmAction } from "../../../_components/confirm-action";
import { readableError } from "../../../_components/errors";
import { useToast } from "../../../_components/toast";
import { runWithFeedback } from "../../../_components/use-feedback-mutation";

export type SessionDetail = NonNullable<
  FunctionReturnType<typeof api.sessions.getSession>
>;

/**
 * What the room reads after a move forward, with the way back on it.
 *
 * End is pressed in two places — this row and the projector header — and a lab
 * told "Session ended." on one screen and something else on the other is
 * looking at two apps. So the copy and the mutation behind `Undo` live here
 * once, and both sites call in.
 *
 * The undo cannot report its own failure through the surface that pushed it:
 * by the time the toast is up, that surface is gone (this component renders
 * nothing past `live`, and the projector view goes with it). So a refusal
 * comes back as an error toast, in the one layer that outlives the click — and
 * it is worth reading, because the server has real reasons to say no. The ten
 * minutes may have lapsed while the toast sat there, or the session may have
 * moved on to a write-up, and `reopenSession` will not walk that back. The
 * status is not re-checked here before asking: the server is the law, and a
 * client that guessed at the answer would only ever guess it stale.
 */
export function useUndoableMove() {
  const toast = useToast();
  const reopenSession = useMutation(api.sessions.reopenSession);
  const restoreSession = useMutation(api.sessions.restoreSession);

  return useCallback(
    (move: "ended" | "cancelled", sessionId: Id<"sessions">) => {
      const ended = move === "ended";
      const undo = ended ? reopenSession : restoreSession;
      toast({
        message: ended ? "Session ended." : "Session cancelled.",
        action: {
          label: "Undo",
          onAction: () =>
            void runWithFeedback(() => undo({ sessionId }), {
              errorMessage: ended
                ? "That session didn't reopen."
                : "That session didn't come back.",
              toast,
            }),
        },
      });
    },
    [toast, reopenSession, restoreSession],
  );
}

/**
 * Running the meeting: start it, move it, hand it over, call it off.
 *
 * Only rendered for the presenter, whoever scheduled it, or the PI — the
 * server decides that and hands it back as `canManage`, so this component
 * never re-derives the rule.
 *
 * Starting is the loud button; ending and calling off are quiet text, because
 * one of them is what somebody came here to do and the others are things you
 * should have to mean. Both of those now ask first and stay undoable for ten
 * minutes after they fire — a stray click on a projector, in front of the
 * whole lab, is exactly the wrong moment to find out a button was irreversible.
 * The question is there so the slip mostly never lands; the undo is there for
 * the slip that gets past a question nobody reads.
 */
export function ManageSession({ session }: { session: SessionDetail }) {
  const startSession = useMutation(api.sessions.startSession);
  const endSession = useMutation(api.sessions.endSession);
  const cancelSession = useMutation(api.sessions.cancelSession);
  const announceMove = useUndoableMove();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [moving, setMoving] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // A session scheduled more than a day out has a Start button that will unlock
  // on its own, so the clock has to move without a reload. It only ticks while
  // there is something to wait for: once the window opens — or the session goes
  // live — the interval is torn down rather than left running behind a meeting.
  const waitingForWindow =
    session.status === "scheduled" &&
    !startWindow(session.scheduledAt, now).canStart;

  useEffect(() => {
    if (!waitingForWindow) {
      return;
    }
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, [waitingForWindow]);

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

  // Only `scheduled` and `live` have anything left to run. A session that has
  // ended, been written up, or been called off would otherwise render a
  // "Running it" heading over an empty box — the presenter's remaining move is
  // the write-up, and that has its own section.
  if (session.status !== "scheduled" && session.status !== "live") {
    return null;
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className={eyebrowClass}>Running it</h2>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        {session.status === "scheduled" &&
          (() => {
            const window = startWindow(session.scheduledAt, now);
            return (
              <div className="flex flex-col gap-1.5">
                <button
                  type="button"
                  disabled={pending || !window.canStart}
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
                {!window.canStart && (
                  <p className="font-sans text-xs text-ink-faint">
                    Still {awayProse(session.scheduledAt - now)} — you can start
                    it up to a day early, or reschedule it if the meeting moved.
                  </p>
                )}
              </div>
            );
          })()}

        {session.status === "live" && (
          <ConfirmAction
            label="End session"
            confirmLabel="End it"
            cancelLabel="Keep going"
            tone="faint"
            size="sm"
            run={() =>
              run(async () => {
                await endSession({ sessionId: session._id });
                announceMove("ended", session._id);
              }, "That session didn't end.")
            }
          />
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
              cancelLabel="Keep it"
              tone="faint"
              size="sm"
              run={() =>
                run(async () => {
                  await cancelSession({ sessionId: session._id });
                  announceMove("cancelled", session._id);
                }, "That session didn't cancel.")
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
      className="pop-in flex flex-wrap items-end gap-4 rounded-md border border-rule bg-surface p-4 shadow-[var(--shadow-card)]"
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
        className={`${selectClass} max-w-xs`}
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
        <div className="pop-in flex flex-col gap-3">
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
            className="w-full resize-y rounded-sm border border-rule bg-surface px-3 py-2 font-serif text-base leading-relaxed text-ink placeholder:text-ink-faint transition-colors hover:border-ink-faint"
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
