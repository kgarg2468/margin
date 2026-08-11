"use client";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { stripLabels } from "@/lib/citations/labels";
import {
  citationSummary,
  coverageLine,
  drawnStatusLine,
  droppedLine,
  type KnownNote,
} from "@/lib/scout/surface";
import { chipClass, linkButtonClass } from "@/lib/ui";
import { useQuery } from "convex-helpers/react/cache/hooks";
import Link from "next/link";

/**
 * What a machine found, under the question that provoked it.
 *
 * ## Why this is violet and the brief is not
 *
 * `--secondary` is the second voice, the one the session synthesis is set in,
 * and it means exactly one thing on this page: **a model wrote this**. The
 * brief above is in the lab's own espresso because every line of it is
 * somebody's own writing rearranged. A reader should never have to work out
 * which of the two they are looking at, and colour is the channel that answers
 * before the words do — with the words saying it too, in the eyebrow.
 *
 * ## Nothing here waits for anything
 *
 * The brief renders on its own subscription and this hangs underneath on two
 * more. A question with no run draws nothing at all; a run in flight draws one
 * quiet line that resolves itself when the row moves — including a *rerun*,
 * whose line is drawn above the report the previous run left standing, so that
 * pressing the button visibly does something. There is no path by
 * which a delegation can delay a brief, and there is not meant to be one
 * (design §6.1) — the scout is scheduled strictly after the brief is written,
 * in its own transaction.
 *
 * ## The check this does not repeat
 *
 * `brief.tsx` re-applies the server's redaction rule against the margin it can
 * see, because every brief citation is on this paper. A finding's are not: the
 * gather searches the lab's whole corpus, so "not in my rows" here means
 * "another paper" far more often than it means "withdrawn", and a client
 * running that test would blank the feature. `findings.toView` re-resolves
 * every citation on every read and is documented as the defense of record;
 * this renders what it was handed and counts what it cannot name.
 */
export function ScoutFinding({
  subject,
  paperId,
  known,
}: {
  /** The question the scout was pointed at — an open-question note, or an outcome row. */
  subject:
    | { kind: "annotation"; annotationId: Id<"annotations"> }
    | { kind: "action"; actionId: Id<"actions"> };
  /** The paper whose reader a resolvable citation links into. */
  paperId: Id<"papers">;
  /** The notes this page has rows for, so a citation can be named rather than counted. */
  known: ReadonlyMap<Id<"annotations">, KnownNote>;
}) {
  const runs = useQuery(api.delegations.listForSubject, { subject });
  const finding = useQuery(api.findings.newestForSubject, { subject });

  // Undefined is "the subscription has not landed", and it draws nothing
  // rather than a skeleton: this sits under a line that is already readable,
  // and a shimmering block under every carried-forward question would make a
  // brief look like it was still loading when it was finished.
  if (runs === undefined || runs.length === 0) {
    return null;
  }
  // `undefined` is a subscription that has not landed and `null` is a question
  // with no report; both mean "nothing to draw underneath", and neither waits.
  const report = finding ?? null;
  // Both facts, one rule, and it lives in `lib/` — see `drawnStatusLine` for
  // why a rerun still in flight is drawn over a standing report while a rerun
  // that came back empty or failed leaves that report alone and says nothing.
  // `finding`, not `report`: a subscription that has not landed may yet hold a
  // report, so an empty/failed sentence must wait for it — otherwise the
  // sentence flashes for the sub-second window before a standing report lands,
  // exactly the contradiction the leave-it-alone rule exists to prevent.
  const status = drawnStatusLine(runs[0], finding !== null);

  // Declared once and placed twice: alone under the question when there is no
  // report, and above one when there is.
  const line =
    status === null ? null : (
      <p role="status" className="mt-2 font-sans text-xs italic text-ink-faint">
        {status}
      </p>
    );

  if (report === null) {
    return line;
  }

  const dropped = droppedLine(report);

  return (
    <>
      {line}
      <div
        style={{ borderLeftColor: "var(--secondary)" }}
        className="mt-3 flex flex-col gap-2 border-l-2 pl-3.5"
      >
        <p className="flex flex-wrap items-baseline gap-x-3">
          <span
            style={{ color: "var(--secondary)" }}
            className="font-sans text-[10px] uppercase tracking-[0.14em]"
          >
            Scout
          </span>
          <span className="font-sans text-[11px] text-ink-faint tabular-nums">
            {coverageLine(report.coverage)}
          </span>
        </p>

        <ul className="flex flex-col gap-2.5">
          {report.items.map((item, index) => {
            const { resolved, elsewhere } = citationSummary(
              item.citedAnnotationIds,
              known,
            );
            return (
              <li key={`${report._id}-${index}`} className="flex flex-col gap-1">
                {/* A redacted item carries the sentence the backend wrote for
                    it and nothing else — no citations drawn as links, no
                    counts, no shape of what was behind it. The ids stay on the
                    wire so a client can reach the same verdict; they are not
                    drawn. */}
                <p
                  className={
                    item.redacted
                      ? "max-w-prose font-serif text-[15px] italic leading-relaxed text-ink-faint"
                      : "max-w-prose font-serif text-[15px] leading-relaxed text-ink"
                  }
                >
                  {item.redacted ? item.text : stripLabels(item.text)}
                </p>
                {!item.redacted && (
                  <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-sans text-[11px] text-ink-faint">
                    {resolved.map((note) => (
                      <Link
                        key={note.id}
                        href={`/app/library/${paperId}/read?note=${note.id}`}
                        className="text-accent underline-offset-4 hover:underline tabular-nums"
                      >
                        {note.authorName}, p. {note.pageIndex + 1}
                      </Link>
                    ))}
                    {elsewhere > 0 && (
                      // Counted, not named. The page has no row for these, and
                      // a link it cannot aim is a promise it cannot keep.
                      <span className="tabular-nums">
                        and {elsewhere} more elsewhere in the lab
                      </span>
                    )}
                  </p>
                )}
              </li>
            );
          })}
        </ul>

        {dropped !== null && (
          <p className="font-sans text-[11px] text-ink-faint tabular-nums">
            {dropped}
          </p>
        )}

        {subject.kind === "annotation" && (
          // Into the reader, at the question, with the composer open on its
          // citations. Action rows get no adopt (design §7): there is no thread
          // under an outcome to reply into, and inventing one would be a second
          // place the lab argues about the same question.
          <Link
            href={`/app/library/${paperId}/read?note=${subject.annotationId}&adopt=1`}
            className={`${linkButtonClass} self-start text-xs`}
          >
            Adopt citations
          </Link>
        )}
      </div>
    </>
  );
}

/**
 * A run's state as a mark in the chrome, for a row that has no room for a
 * sentence.
 *
 * `chipClass` is the librarian's pencil note this codebase already uses for a
 * state marker, and it is deliberately not a control: pressing it would do
 * nothing, and there is nothing to filter by.
 */
export function ScoutStatusChip({
  status,
}: {
  status: "queued" | "running" | "returned" | "empty" | "failed" | "cancelled";
}) {
  const word =
    status === "queued" || status === "running"
      ? "scout looking"
      : status === "returned"
        ? "scout returned"
        : status === "empty"
          ? "scout found nothing"
          : null;
  return word === null ? null : (
    <span style={{ color: "var(--secondary)" }} className={chipClass}>
      {word}
    </span>
  );
}

/** The row's newest run, as a chip. Subscribes so a card in flight settles itself. */
export function ScoutChip({
  subject,
}: {
  subject: Parameters<typeof ScoutFinding>[0]["subject"];
}) {
  const runs = useQuery(api.delegations.listForSubject, { subject });
  const newest = runs?.[0];
  return newest === undefined ? null : <ScoutStatusChip status={newest.status} />;
}
