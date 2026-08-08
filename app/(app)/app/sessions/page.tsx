"use client";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { isUpcoming } from "@/lib/sessions-ui";
import { eyebrowClass, secondaryButtonClass } from "@/lib/ui";
import { useQuery } from "convex/react";
import Link from "next/link";
import { use, useState } from "react";
import type { LabSummary } from "../_components/lab-provider";
import { useLabs } from "../_components/lab-provider";
import { ScheduleForm } from "./_components/schedule-form";
import { SessionRow } from "./_components/session-row";

/**
 * The lab's calendar.
 *
 * `?paper=` opens the schedule form with that paper already chosen — it is how
 * the paper page hands off to here, and it means "schedule a session about
 * this" is one click rather than a second search through the library.
 */
export default function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<{ paper?: string }>;
}) {
  const { paper } = use(searchParams);
  const { labs, currentLab } = useLabs();

  if (labs === undefined) {
    return <p className="font-sans text-sm text-ink-faint">Loading…</p>;
  }

  if (currentLab === null) {
    return (
      <div className="flex flex-col gap-3 border-l border-rule pl-6">
        <h1 className="font-serif text-4xl tracking-tight text-ink-strong">
          Sessions
        </h1>
        <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
          A journal club belongs to a lab, and you aren&rsquo;t in one yet.
        </p>
        <Link
          href="/app"
          className="font-sans text-sm text-accent underline-offset-4 hover:underline"
        >
          Start or join a lab
        </Link>
      </div>
    );
  }

  return (
    <Calendar
      lab={currentLab}
      paperId={
        paper === undefined || paper.length === 0
          ? undefined
          : (paper as Id<"papers">)
      }
    />
  );
}

function Calendar({
  lab,
  paperId,
}: {
  lab: LabSummary;
  paperId?: Id<"papers">;
}) {
  const sessions = useQuery(api.sessions.listSessions, { labId: lab._id });
  const [scheduling, setScheduling] = useState(paperId !== undefined);

  // `listSessions` comes back furthest-future first, which is the order the
  // past wants and the reverse of the order the future wants: the next meeting
  // is the one you are looking for, so upcoming reads soonest-first.
  const upcoming = (sessions ?? [])
    .filter((session) => isUpcoming(session.status))
    .slice()
    .reverse();
  const past = (sessions ?? []).filter(
    (session) => !isUpcoming(session.status),
  );
  const empty = sessions !== undefined && sessions.length === 0;

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-3 border-l border-rule pl-6">
        <h1 className="font-serif text-4xl tracking-tight text-ink-strong">
          Sessions
        </h1>
        <p className="font-sans text-sm text-ink-muted">
          {lab.name}&rsquo;s journal club
          {upcoming.length > 0
            ? ` · ${upcoming.length} ${upcoming.length === 1 ? "meeting" : "meetings"} ahead`
            : ""}
        </p>
      </header>

      {empty || scheduling ? (
        <div className="flex flex-col gap-3">
          <ScheduleForm
            labId={lab._id}
            defaultPaperId={paperId}
            onCancel={empty ? undefined : () => setScheduling(false)}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setScheduling(true)}
          className={`${secondaryButtonClass} self-start`}
        >
          Schedule a session
        </button>
      )}

      <section className="flex flex-col gap-5">
        <h2 className={eyebrowClass}>Ahead</h2>
        {sessions === undefined ? (
          <p className="font-sans text-sm text-ink-faint">Loading…</p>
        ) : upcoming.length === 0 ? (
          <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
            Nothing on the calendar. A session is a paper, a time, and whoever
            is presenting — everyone reads into the margin beforehand, and the
            meeting runs off what the lab flagged.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-rule border-y border-rule">
            {upcoming.map((session) => (
              <SessionRow key={session._id} session={session} />
            ))}
          </ul>
        )}
      </section>

      {past.length > 0 && (
        <section className="flex flex-col gap-5">
          <h2 className={eyebrowClass}>Held</h2>
          <ul className="flex flex-col divide-y divide-rule border-y border-rule">
            {past.map((session) => (
              <SessionRow key={session._id} session={session} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
