"use client";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { formatWhen, isUpcoming, isoAt, relativeWhen } from "@/lib/sessions-ui";
import { eyebrowClass, primaryButtonClass } from "@/lib/ui";
import { useQuery } from "convex-helpers/react/cache/hooks";
import Link from "next/link";
import { use } from "react";
import { PageSkeleton } from "../../_components/skeletons";
import { SessionStatusChip } from "../../sessions/_components/session-row";
import { StatusChip, byline } from "../_components/paper-meta";
import { PdfPanel } from "../_components/pdf-panel";

/**
 * The locale is pinned rather than left to the browser. `undefined` means "ask
 * the runtime", and the runtimes disagree: the server renders one string, the
 * client another, and React calls that a hydration mismatch.
 */
function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function PaperPage({
  params,
}: {
  params: Promise<{ paperId: string }>;
}) {
  const { paperId } = use(params);
  const paper = useQuery(api.papers.getPaper, {
    paperId: paperId as Id<"papers">,
  });

  if (paper === undefined) {
    return <PageSkeleton />;
  }

  if (paper === null) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
          That paper isn&rsquo;t in a library you can see. It may have been
          removed, or it may belong to another lab.
        </p>
      </div>
    );
  }

  const line = byline(paper);

  return (
    <div className="flex flex-col gap-10">
      <BackLink />

      <header className="flex flex-col gap-4 border-l border-rule pl-6">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
          <h1 className="font-serif text-3xl leading-tight tracking-tight text-ink-strong">
            {paper.title}
          </h1>
          <StatusChip status={paper.ingestStatus} />
        </div>

        {line.length > 0 && (
          <p className="font-sans text-sm text-ink-muted">{line}</p>
        )}

        <p className="flex flex-wrap items-baseline gap-x-5 gap-y-1 font-sans text-xs text-ink-faint">
          {paper.doi !== undefined && (
            <a
              href={`https://doi.org/${paper.doi}`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-accent underline-offset-4 hover:underline"
            >
              {paper.doi}
            </a>
          )}
          {paper.sourceUrl !== undefined && (
            <a
              href={paper.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="text-accent underline-offset-4 hover:underline"
            >
              Publisher page
            </a>
          )}
          <span>
            Added {formatDate(paper.addedAt)}
            {paper.addedByName !== undefined ? ` by ${paper.addedByName}` : ""}
          </span>
        </p>
      </header>

      {paper.abstract !== undefined && (
        <section className="flex flex-col gap-3">
          <h2 className={eyebrowClass}>Abstract</h2>
          <p className="max-w-prose font-serif text-base leading-relaxed text-ink">
            {paper.abstract}
          </p>
        </section>
      )}

      <PdfPanel
        paperId={paper._id}
        labId={paper.labId}
        hasPdf={paper.hasPdf}
        hasText={paper.hasText}
        pageCount={paper.pageCount}
        ingestStatus={paper.ingestStatus}
        ingestError={paper.ingestError}
      />

      <Reading paperId={paper._id} ready={paper.hasPdf && paper.hasText} />

      <Sessions paperId={paper._id} labId={paper.labId} />
    </div>
  );
}

/**
 * The meetings this paper is on the calendar for.
 *
 * A paper and a session point at each other, and this is the half that was
 * missing: the record says when the lab is discussing it, and hands off to the
 * schedule form with the paper already chosen.
 *
 * Past meetings are deliberately not listed here. They belong to the calendar,
 * and a record that accumulates every session it was ever read in turns into a
 * changelog nobody asked the paper for.
 */
function Sessions({
  paperId,
  labId,
}: {
  paperId: Id<"papers">;
  labId: Id<"labs">;
}) {
  const sessions = useQuery(api.sessions.listSessions, { labId });
  const upcoming = (sessions ?? [])
    .filter(
      (session) => session.paperId === paperId && isUpcoming(session.status),
    )
    .slice()
    .reverse();

  return (
    <section className="flex flex-col gap-4">
      <h2 className={eyebrowClass}>Sessions</h2>

      {upcoming.length === 0 ? (
        <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
          No meeting on the calendar for this paper.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-rule border-y border-rule">
          {upcoming.map((session) => (
            <li key={session._id} className="flex flex-col gap-0.5 py-3">
              <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <Link
                  href={`/app/sessions/${session._id}`}
                  className="font-serif text-lg leading-snug text-ink-strong underline-offset-4 hover:underline"
                >
                  <time dateTime={isoAt(session.scheduledAt)}>
                    {formatWhen(session.scheduledAt)}
                  </time>
                </Link>
                <SessionStatusChip status={session.status} />
              </span>
              <span className="font-sans text-xs text-ink-faint">
                {session.presenterName ?? "No presenter"} ·{" "}
                {relativeWhen(session.scheduledAt)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <Link
        href={`/app/sessions?paper=${paperId}`}
        className="self-start font-sans text-sm text-accent underline-offset-4 hover:underline"
      >
        Schedule a session
      </Link>
    </section>
  );
}

function BackLink() {
  return (
    <Link
      href="/app/library"
      className="self-start font-sans text-sm text-accent underline-offset-4 hover:underline"
    >
      ← Library
    </Link>
  );
}

/**
 * The way in. Drawn as an empty page with a margin rule rather than a button on
 * a grey box, because that is the shape of the thing on the other side of it —
 * the paper on the left, the lab's annotations down the right.
 *
 * A paper with no text layer gets no door. Annotations anchor to passages of
 * extracted text, so opening a scan would be opening a reader whose margins
 * cannot be written in, and saying why is more use than letting someone find
 * out.
 */
function Reading({ paperId, ready }: { paperId: Id<"papers">; ready: boolean }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className={eyebrowClass}>Reading</h2>
      <div className="flex min-h-56 flex-col justify-center gap-4 rounded-md border border-rule bg-surface p-8 md:pr-40">
        <p className="max-w-prose font-serif text-lg leading-relaxed text-ink-muted">
          The paper on the left, the lab&rsquo;s annotations in the margin beside
          it, typed with a tap and threaded where people answer each other.
        </p>
        {ready ? (
          <Link
            href={`/app/library/${paperId}/read`}
            className={`${primaryButtonClass} self-start`}
          >
            Read
          </Link>
        ) : (
          <p className="font-sans text-sm text-ink-faint">
            It needs the PDF and its text layer first — annotations anchor to
            passages of extracted text.
          </p>
        )}
      </div>
    </section>
  );
}
