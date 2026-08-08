"use client";

import type { api } from "@/convex/_generated/api";
import {
  formatDate,
  formatTime,
  isoAt,
  relativeWhen,
  statusLabel,
} from "@/lib/sessions-ui";
import { chipClass } from "@/lib/ui";
import type { FunctionReturnType } from "convex/server";
import Link from "next/link";

export type SessionSummary = FunctionReturnType<
  typeof api.sessions.listSessions
>[number];

/**
 * A session's state, when it has one worth saying. `scheduled` is the default
 * and says nothing — a calendar where every row is labelled is a calendar where
 * no label is read, which is the rule `StatusChip` follows in the library.
 *
 * `live` is the exception to the quiet-chip idiom: it is the one state that is
 * true only right now, and the one a member arriving at the page needs to act
 * on. It carries the accent and a dot rather than the hairline border.
 */
export function SessionStatusChip({
  status,
}: {
  status: SessionSummary["status"];
}) {
  const label = statusLabel(status);
  if (label === null) {
    return null;
  }
  if (status === "live") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-sm bg-accent px-1.5 py-0.5 font-sans text-[10px] uppercase tracking-[0.14em] text-accent-contrast">
        <span
          aria-hidden="true"
          className="size-1.5 rounded-full bg-current motion-safe:animate-pulse"
        />
        {label}
      </span>
    );
  }
  return <span className={chipClass}>{label}</span>;
}

/**
 * One line of the calendar: when, what, who.
 *
 * The time is a column of its own rather than a suffix on the title. A list of
 * meetings is read down the dates first — "what is this week" — and a date that
 * starts every row at the same x is the difference between scanning and
 * reading.
 */
export function SessionRow({ session }: { session: SessionSummary }) {
  const heading =
    session.title ?? session.paperTitle ?? "A session on a missing paper";
  const cancelled = session.status === "cancelled";

  return (
    <li className="flex gap-5 py-4">
      <time
        dateTime={isoAt(session.scheduledAt)}
        className="w-20 shrink-0 font-sans tabular-nums"
      >
        <span className="block text-sm text-ink">
          {formatDate(session.scheduledAt)}
        </span>
        <span className="block text-xs text-ink-faint">
          {formatTime(session.scheduledAt)}
        </span>
      </time>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <Link
            href={`/app/sessions/${session._id}`}
            className={
              "font-serif text-xl leading-snug underline-offset-4 hover:underline " +
              (cancelled ? "text-ink-muted line-through" : "text-ink-strong")
            }
          >
            {heading}
          </Link>
          <SessionStatusChip status={session.status} />
        </span>

        {session.title !== undefined && session.paperTitle !== undefined && (
          <span className="truncate font-serif text-sm text-ink-muted">
            {session.paperTitle}
          </span>
        )}

        <span className="font-sans text-xs text-ink-faint">
          {session.presenterName ?? "Presenter has left the lab"}
          {" · "}
          {relativeWhen(session.scheduledAt)}
        </span>
      </div>
    </li>
  );
}
