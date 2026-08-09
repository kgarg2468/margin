"use client";

import { api } from "@/convex/_generated/api";
import { formatDuration } from "@/lib/sessions-ui";
import { errorClass, eyebrowClass } from "@/lib/ui";
import { useMutation } from "convex/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ConfirmAction } from "../../../_components/confirm-action";
import { readableError } from "../../../_components/errors";
import { useUndoableMove, type SessionDetail } from "./manage";
import {
  FloorColumns,
  MarginElsewhere,
  PassageBoard,
  SessionSpine,
} from "./session-board";
import type { SessionNotes } from "./session-notes";

/**
 * The live session: the screen at the front of the room.
 *
 * It takes the whole window, the way the reader does, because it is the same
 * kind of surface — a working view rather than a document in the app's column —
 * and because it is going on a projector. Everything on it is a live Convex
 * subscription: a note a postdoc types in the margin during the meeting appears
 * here without a reload, which is the entire point of holding the meeting in
 * front of it.
 *
 * What it is not, and cannot become: a view of who is present, who has read,
 * or who has written the most. Every number here is a count of *notes by type*,
 * and none of them can be sliced by member. That is the privacy constitution,
 * and on a screen the whole lab is looking at it is the one place it matters
 * most.
 */

/** The elapsed clock, re-read every half minute. A meeting is not timed to the second. */
function useElapsed(since: number | undefined): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  if (since === undefined) {
    return null;
  }
  return formatDuration(Math.max(0, now - since));
}

export function LiveSession({
  session,
  notes,
  readHref,
}: {
  session: SessionDetail;
  notes: SessionNotes;
  readHref: string;
}) {
  const elapsed = useElapsed(session.startedAt);
  const endSession = useMutation(api.sessions.endSession);
  const { announceMove } = useUndoableMove();
  const [error, setError] = useState<string | null>(null);

  const heading = session.title ?? session.paperTitle ?? "This session";

  return (
    <div className="fixed inset-0 z-20 flex flex-col bg-page md:left-64">
      <header className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2 border-b border-rule bg-surface px-4 py-2.5 sm:px-6">
        <Link
          href="/app/sessions"
          className="font-sans text-sm text-accent underline-offset-4 hover:underline"
        >
          ← Sessions
        </Link>

        <span className="inline-flex items-center gap-1.5 rounded-sm bg-accent px-1.5 py-0.5 font-sans text-[10px] uppercase tracking-[0.14em] text-accent-contrast">
          <span
            aria-hidden="true"
            className="size-1.5 rounded-full bg-current motion-safe:animate-pulse"
          />
          Live
        </span>

        <h1 className="min-w-0 flex-1 truncate font-serif text-lg leading-tight text-ink-strong">
          {heading}
        </h1>

        <span className="font-sans text-xs text-ink-faint tabular-nums">
          {session.presenterName ?? "No presenter"}
          {elapsed !== null ? ` · ${elapsed} in` : ""}
          {notes.total > 0
            ? ` · ${notes.total} ${notes.total === 1 ? "note" : "notes"}`
            : ""}
        </span>

        <Link
          href={readHref}
          className="font-sans text-sm text-accent underline-offset-4 hover:underline"
        >
          Read the paper
        </Link>

        {/* The one place in the app where a destructive click happens in front
            of an audience, so it is the place the two-step matters most: the
            question, then ten minutes in which the answer can be taken back.
            Word for word what the manage row says, because the presenter uses
            one screen and the room is looking at the other.

            `sm` rather than the `xs` this scale otherwise reserves for chrome:
            this row is chrome on a laptop and a headline on a projector, and
            End sits between two `text-sm` links either way. */}
        {session.canManage && (
          <ConfirmAction
            label="End session"
            confirmLabel="End it"
            cancelLabel="Keep going"
            tone="faint"
            size="sm"
            run={async () => {
              setError(null);
              try {
                await endSession({ sessionId: session._id });
                announceMove("ended", session._id);
              } catch (caught) {
                setError(readableError(caught, "That session didn't end."));
              }
            }}
          />
        )}
      </header>

      <div className="flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-10 px-4 py-7 sm:px-8">
          {error !== null && (
            <p role="alert" aria-live="polite" className={errorClass}>
              {error}
            </p>
          )}

          {notes.total === 0 ? (
            <div className="mt-10 flex flex-col items-center gap-4 text-center">
              <p className="max-w-prose font-serif text-lg leading-relaxed text-ink-muted">
                The margin is empty so far. Everything the lab writes on this
                paper during the session appears here as it is written —
                passages on the left of the paper, the discussion beneath them.
              </p>
              <Link
                href={readHref}
                className="font-sans text-sm text-accent underline-offset-4 hover:underline"
              >
                Open the paper
              </Link>
              <MarginElsewhere count={notes.elsewhere} readHref={readHref} />
            </div>
          ) : (
            <>
              <SessionSpine notes={notes} />

              <section className="flex flex-col gap-5">
                <h2 className={eyebrowClass}>Where the lab stopped</h2>
                <PassageBoard notes={notes} readHref={readHref} />
                <MarginElsewhere count={notes.elsewhere} readHref={readHref} />
              </section>

              <section className="flex flex-col gap-5 border-t border-rule pt-8">
                <h2 className={eyebrowClass}>The floor</h2>
                <FloorColumns
                  notes={notes}
                  presenterNotes={session.presenterNotes}
                  presenterName={session.presenterName}
                />
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
