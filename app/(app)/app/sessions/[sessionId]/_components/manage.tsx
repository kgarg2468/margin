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
import { UNDO_WINDOW_MS, awayProse, startWindow } from "@/lib/session-window";
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

/** Which forward move was just made, and therefore which way back is on offer. */
type Move = "ended" | "cancelled";

/**
 * How long the undo toast stays up: fifteen seconds, three times the default.
 *
 * A toast is glanced at, and five seconds is the right length for one that
 * only says a thing happened. This one is also the fastest way to take that
 * thing back, and five seconds is not long enough to read a sentence, decide
 * you didn't mean it, and move a hand. It is still nowhere near the ten
 * minutes the window is actually worth — that is the page's job, not a
 * notice's, and a toast that sat in the corner for ten minutes would be a
 * banner.
 */
const UNDO_TOAST_MS = 15_000;

/**
 * Which sessions have an undo already on its way to the server.
 *
 * The two entrances are open at the same time — for fifteen seconds the
 * toast's Undo and the row on the session page are both on screen, and
 * pressing both is one flustered second's work. Unguarded, the second call
 * reaches a server that has already granted the first and comes back refused,
 * so the move succeeds *and* the corner of the screen says it failed.
 * Whichever press lands second does nothing instead.
 *
 * Module-level rather than a ref inside the hook, and that is the point: after
 * an End the two doors are not in the same component. The toast was pushed by
 * the projector view and the row is rendered by `ManageSession`, so two hook
 * instances — two refs — would each believe they were the only caller. What
 * has to be shared is the fact of the call, not any component's state. Keyed
 * by session because it is a claim about that session, and never read during
 * render, so a module-scoped mutable set is safe on the server too: nothing
 * puts anything in it except a click.
 *
 * It only covers the in-flight span. Once the call resolves the page has
 * re-rendered without the row, and a call that resolved *unhappily* should
 * leave both doors open to try again.
 */
const undoInFlight = new Set<Id<"sessions">>();

/**
 * The way back from a forward move: the toast that offers it, and the call
 * that takes it.
 *
 * One hook because there are two entrances to the same undo and they must not
 * drift — the toast right after the press, and the row this page keeps on
 * offer for the rest of the ten minutes. End is pressed on the projector and
 * cancelling is pressed here, so the copy would otherwise be written twice in
 * two files by two people.
 *
 * A refusal comes back as an error toast rather than into a caller's error
 * line, and that routing is deliberate on both paths. After an End, the
 * surface that pushed the toast is gone — the page swaps the projector view
 * for the record. After a cancel this component stays mounted, but it renders
 * the undo row instead of the row that has the error paragraph in it, so a
 * message written to local state would be state nothing displays. The toast
 * layer is the only surface that outlives either. It is worth reading, too:
 * the server has real reasons to say no — the ten minutes lapsed while the
 * notice sat there, or the session moved on to a write-up, and
 * `reopenSession` will not walk that back.
 *
 * Nothing re-checks the status before asking. The window this page reads
 * decides what to *show*; whether the move is allowed is the server's, and a
 * client that answered that itself would only ever answer it stale.
 */
export function useUndoableMove() {
  const toast = useToast();
  const reopenSession = useMutation(api.sessions.reopenSession);
  const restoreSession = useMutation(api.sessions.restoreSession);

  const undoMove = useCallback(
    async (move: Move, sessionId: Id<"sessions">) => {
      // See `undoInFlight`: the second of two presses does nothing rather
      // than collecting a refusal for work the first one already did.
      if (undoInFlight.has(sessionId)) {
        return undefined;
      }
      undoInFlight.add(sessionId);
      try {
        return await runWithFeedback(
          () =>
            move === "ended"
              ? reopenSession({ sessionId })
              : restoreSession({ sessionId }),
          {
            errorMessage:
              move === "ended"
                ? "That session didn't reopen."
                : "That session didn't come back.",
            toast,
          },
        );
      } finally {
        undoInFlight.delete(sessionId);
      }
    },
    [toast, reopenSession, restoreSession],
  );

  const announceMove = useCallback(
    (move: Move, sessionId: Id<"sessions">) => {
      toast({
        message: move === "ended" ? "Session ended." : "Session cancelled.",
        durationMs: UNDO_TOAST_MS,
        action: {
          label: "Undo",
          onAction: () => void undoMove(move, sessionId),
        },
      });
    },
    [toast, undoMove],
  );

  return { announceMove, undoMove };
}

/**
 * Which move this session can still take back, or `null`.
 *
 * The absence of a timestamp reads as lapsed rather than as fresh, matching
 * the rule the mutations apply: the field is written by the move itself, so a
 * row without one got to this status some other way, and "I cannot tell when
 * this happened" is not a reason to offer an undo.
 */
function undoableMove(session: SessionDetail, now: number): Move | null {
  if (session.status === "ended" && fresh(session.endedAt, now)) {
    return "ended";
  }
  if (session.status === "cancelled" && fresh(session.cancelledAt, now)) {
    return "cancelled";
  }
  return null;
}

function fresh(at: number | undefined, now: number): boolean {
  return at !== undefined && now - at <= UNDO_WINDOW_MS;
}

/**
 * Running the meeting: start it, move it, hand it over, call it off — and,
 * for ten minutes, take back the last of those.
 *
 * Only rendered for the presenter, whoever scheduled it, or the PI — the
 * server decides that and hands it back as `canManage`, so this component
 * never re-derives the rule.
 *
 * Starting is the loud button and calling off is quiet text, because one of
 * them is what somebody came here to do and the other is a thing you should
 * have to mean. Calling off asks first, and so does the End on the projector,
 * because a stray click in front of the whole lab is exactly the wrong moment
 * to find out a button was irreversible. The question is there so the slip
 * mostly never lands.
 *
 * The undo is there for the slip that gets past a question nobody reads, and
 * it is worth ten minutes rather than the length of a notice. The toast is the
 * quick path — press Undo before it fades and the thing is simply back. This
 * page keeps the same offer open for the rest of the window, as a row on the
 * ended or cancelled session itself, because the regret usually arrives after
 * the toast: the room is still arguing, or somebody says "wait, that was next
 * week's". A promise of ten minutes with a five-second door is not a promise.
 */
export function ManageSession({ session }: { session: SessionDetail }) {
  const startSession = useMutation(api.sessions.startSession);
  const cancelSession = useMutation(api.sessions.cancelSession);
  const { announceMove, undoMove } = useUndoableMove();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [moving, setMoving] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const undoable = undoableMove(session, now);

  // Two things here expire on their own, and both would otherwise need a
  // reload to notice: a Start button that unlocks a day before the meeting,
  // and an undo that stops being on offer ten minutes after the move. So the
  // clock ticks while either is pending and is torn down the moment neither
  // is — no interval left running behind a live meeting, or behind a session
  // that has been over since last week.
  //
  // Half a minute of slack at the far end: the row can survive its own window
  // by up to one tick. That is the honest trade for not re-rendering a page
  // every second, and it costs nothing, because the button was never what
  // decided the answer — a press that races the lapse gets the server's
  // refusal, which says in words that the ten minutes are gone.
  const waitingForWindow =
    session.status === "scheduled" &&
    !startWindow(session.scheduledAt, now).canStart;
  const ticking = waitingForWindow || undoable !== null;

  useEffect(() => {
    if (!ticking) {
      return;
    }
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, [ticking]);

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

  // The way back, while it is still on offer. Not under "Running it" and not
  // wearing a confirmation: this row *is* the second step of a two-step, and
  // asking "are you sure you want to undo" is the app arguing with somebody
  // who has already told it twice what they meant. One quiet sentence saying
  // what just happened, and the word that reverses it.
  if (undoable !== null) {
    const ended = undoable === "ended";
    return (
      <section className="flex flex-col gap-3">
        <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
          {ended
            ? "This session just ended. For the next few minutes you can put it back — after that, meeting about this paper again means a new session."
            : "This session was just cancelled. For the next few minutes you can put it back on the calendar, prep digest and all."}
        </p>
        <button
          type="button"
          disabled={pending}
          className={`${secondaryButtonClass} self-start`}
          onClick={() => {
            setPending(true);
            void undoMove(undoable, session._id).finally(() =>
              setPending(false),
            );
          }}
        >
          {ended ? "Reopen session" : "Restore session"}
        </button>
      </section>
    );
  }

  // Only `scheduled` has anything left to run. `live` never reaches here — the
  // page draws a running session as the projector view, and the End that ends
  // it lives there. A session that has been written up, or is past its undo,
  // would otherwise render a "Running it" heading over an empty box; the
  // presenter's remaining move is the write-up, and that has its own section.
  if (session.status !== "scheduled") {
    return null;
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className={eyebrowClass}>Running it</h2>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        {(() => {
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
      </div>

      {moving && (
        <Reschedule session={session} onDone={() => setMoving(false)} />
      )}

      <PresenterPicker session={session} />

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
 * presenter is off sick on the morning of.
 *
 * The server allows the swap right through the meeting (`updateSession` takes
 * a new presenter while a session is `scheduled` or `live`), but this control
 * is only ever on screen before it: a live session routes to the projector
 * view, and `ManageSession` is not mounted then. Re-casting mid-meeting is a
 * rule the API keeps, not a button this page offers.
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
