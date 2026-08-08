"use client";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  formatDuration,
  formatWhen,
  isoAt,
  relativeWhen,
} from "@/lib/sessions-ui";
import { eyebrowClass, primaryButtonClass } from "@/lib/ui";
import { useQuery } from "convex/react";
import Link from "next/link";
import { use, useMemo } from "react";
import { SessionDigest } from "../../_components/digest";
import { byline } from "../../library/_components/paper-meta";
import { SessionStatusChip } from "../_components/session-row";
import { LiveSession } from "./_components/live-session";
import type { SessionDetail } from "./_components/manage";
import { ManageSession, PresenterNotes } from "./_components/manage";
import { FloorColumns, PassageBoard, SessionSpine } from "./_components/session-board";
import { groupSessionNotes } from "./_components/session-notes";
import { SessionSynthesis } from "./_components/synthesis";

/**
 * One session, drawn as whatever it currently is.
 *
 * `scheduled → live → ended → synthesized` are four different screens rather
 * than one screen with four sets of hidden controls: a meeting that hasn't
 * happened is a plan, a meeting in progress is a projector, and a meeting that
 * has happened is a record. The status is the route.
 *
 * The collective view comes from `annotations.listForPaper` — the reader's own
 * subscription — so the live view and the reader show the same margin at the
 * same instant, and there is exactly one place where the privacy rule that
 * strips private notes has to be right.
 */
export default function SessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = use(params);
  const id = sessionId as Id<"sessions">;

  const session = useQuery(api.sessions.getSession, { sessionId: id });
  const annotations = useQuery(
    api.annotations.listForPaper,
    session === undefined || session === null
      ? "skip"
      : { paperId: session.paperId },
  );

  const rows = useMemo(() => annotations?.annotations ?? [], [annotations]);
  const notes = useMemo(() => groupSessionNotes(rows, id), [rows, id]);

  if (session === undefined) {
    return <p className="font-sans text-sm text-ink-faint">Loading…</p>;
  }

  if (session === null) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
          That session isn&rsquo;t on a calendar you can see. It may have been
          cancelled, or it may belong to another lab.
        </p>
      </div>
    );
  }

  const readHref = `/app/library/${session.paperId}/read?session=${session._id}`;

  if (session.status === "live") {
    return (
      <LiveSession session={session} notes={notes} readHref={readHref} />
    );
  }

  return (
    <Record
      session={session}
      notes={notes}
      readHref={readHref}
      visibleAnnotationIds={
        new Set(
          rows
            .filter((row) => row.visibility === "lab" && !row.deleted)
            .map((row) => row._id),
        )
      }
    />
  );
}

function BackLink() {
  return (
    <Link
      href="/app/sessions"
      className="self-start font-sans text-sm text-accent underline-offset-4 hover:underline"
    >
      ← Sessions
    </Link>
  );
}

function Record({
  session,
  notes,
  readHref,
  visibleAnnotationIds,
}: {
  session: SessionDetail;
  notes: ReturnType<typeof groupSessionNotes>;
  readHref: string;
  visibleAnnotationIds: ReadonlySet<Id<"annotations">>;
}) {
  const heading = session.title ?? session.paperTitle ?? "A missing paper";
  const held = session.status === "ended" || session.status === "synthesized";
  const cancelled = session.status === "cancelled";
  const ran =
    session.startedAt !== undefined && session.endedAt !== undefined
      ? formatDuration(session.endedAt - session.startedAt)
      : null;
  const readable = session.paperHasPdf && session.paperIngestStatus === "ready";

  return (
    <div className="flex flex-col gap-10">
      <BackLink />

      <header className="flex flex-col gap-3 border-l border-rule pl-6">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
          <h1 className="font-serif text-3xl leading-tight tracking-tight text-ink-strong">
            {heading}
          </h1>
          <SessionStatusChip status={session.status} />
        </div>

        <p className="font-sans text-sm text-ink-muted">
          <time dateTime={isoAt(session.scheduledAt)}>
            {formatWhen(session.scheduledAt)}
          </time>
          {cancelled ? "" : ` · ${relativeWhen(session.scheduledAt)}`}
          {ran !== null ? ` · ran ${ran}` : ""}
        </p>

        <p className="font-sans text-sm text-ink-muted">
          Presented by {session.presenterName ?? "a member who has left the lab"}
        </p>

        {session.paperTitle !== undefined && (
          <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 font-sans text-xs text-ink-faint">
            <Link
              href={`/app/library/${session.paperId}`}
              className="text-accent underline-offset-4 hover:underline"
            >
              {session.paperTitle}
            </Link>
            <span>
              {byline({
                authors: session.paperAuthors,
                year: session.paperYear,
                venue: session.paperVenue,
              })}
            </span>
          </p>
        )}
      </header>

      {!cancelled && (
        <section className="flex flex-col gap-3">
          <h2 className={eyebrowClass}>
            {held ? "The paper" : "Before the meeting"}
          </h2>
          {readable ? (
            <>
              <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
                {held
                  ? "The margin is still open — a paper keeps collecting notes after the meeting that read it."
                  : "Read it in the margin. Inside a session, notes default to lab-visible, because prep is what the meeting runs on — you can flip any of them back to private."}
              </p>
              <Link
                href={readHref}
                className={`${primaryButtonClass} self-start`}
              >
                Read the paper
              </Link>
            </>
          ) : (
            <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
              This paper isn&rsquo;t readable yet — annotations anchor to
              passages of extracted text, and it needs its PDF and text layer
              first.{" "}
              <Link
                href={`/app/library/${session.paperId}`}
                className="text-accent underline-offset-4 hover:underline"
              >
                Fix it on the record
              </Link>
              .
            </p>
          )}
        </section>
      )}

      {cancelled && (
        <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
          This meeting was called off. Whatever the lab wrote in the margin
          while it was on the calendar is still on the paper.
        </p>
      )}

      {!cancelled && (
        <SessionDigest labId={session.labId} sessionId={session._id} />
      )}

      {session.canManage && <ManageSession session={session} />}

      {!cancelled && <PresenterNotes session={session} />}

      {!cancelled && notes.total > 0 && (
        <section className="flex flex-col gap-6 border-t border-rule pt-8">
          <div className="flex flex-col gap-4">
            <h2 className={eyebrowClass}>
              {held ? "What the room left" : "What the lab has flagged"}
            </h2>
            <SessionSpine notes={notes} />
          </div>

          <PassageBoard notes={notes} readHref={readHref} />

          <div className="border-t border-rule pt-6">
            <FloorColumns
              notes={notes}
              presenterNotes={session.presenterNotes}
              presenterName={session.presenterName}
            />
          </div>
        </section>
      )}

      {held && (
        <div className="border-t border-rule pt-8">
          <SessionSynthesis
            session={session}
            visibleAnnotationIds={visibleAnnotationIds}
          />
        </div>
      )}
    </div>
  );
}
