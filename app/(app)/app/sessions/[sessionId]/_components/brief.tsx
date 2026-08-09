"use client";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { GOLD_PAIRS } from "@/lib/digest/engine";
import { ownPrivateNotes, tallyContributors } from "@/lib/brief/prep";
import { formatDate, relativeWhen } from "@/lib/sessions-ui";
import {
  errorClass,
  eyebrowClass,
  primaryButtonClass,
  secondaryButtonClass,
  skeletonClass,
} from "@/lib/ui";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { readableError } from "../../../_components/errors";
import { typeStyle } from "../../../library/[paperId]/read/_components/ontology";
import type { AnnotationView } from "../../../library/[paperId]/read/_components/types";
import type { SessionDetail } from "./manage";
import { annotationAnchorId } from "./session-board";

type Brief = NonNullable<FunctionReturnType<typeof api.briefs.getForSession>>;
type Section = Brief["sections"][number];
type Item = Section["items"][number];

/**
 * The presenter's brief: an agenda, drawn as one.
 *
 * ## Why this is not violet
 *
 * The write-up below it is set in `--secondary`, the second voice the design
 * tokens hold in reserve, because a model wrote it and a reader should never
 * have to ask which of the two they are looking at. The brief is in the lab's
 * own espresso, and that is the whole argument for it in a colour: **nothing
 * here was generated**. Every line is something a member of this lab wrote,
 * moved next to the other lines it belongs beside. There is no model in the
 * path, so there is nothing for the second voice to mark.
 *
 * ## A running order
 *
 * Numbered, in the gutter, in tabular figures — the one gesture this panel has
 * that nothing else in the app does, and it is what the surface actually is: a
 * presenter works down it on a Sunday night and again in the ten minutes before
 * the room fills. Sections with nothing in them are left out rather than drawn
 * empty, which is the opposite of what the session board does with its floor
 * columns and right for the opposite reason: a board is a picture of a meeting
 * and an empty column is a fact about it, while an agenda lists what is on it.
 *
 * Each section takes the ink of what it holds. Open questions are written in
 * the ontology's `open-question` violet because that is literally what they
 * are; the floor is the critique rust; collisions take the accent, the way a
 * collision line does in a digest. Colour is a second channel throughout — the
 * heading says the same thing in words.
 *
 * ## Two sections that are never stored
 *
 * "Who has written" and "Your own notes" are derived here, in the browser, from
 * the same `annotations.listForPaper` subscription the rest of the page runs
 * on (see `lib/brief/prep.ts` for why that is a privacy property and not an
 * optimisation). They carry no citations because they are not claims about the
 * paper — they are the margin, counted and filtered. Everything above them
 * comes from a stored, cited, reviewable `briefs` row.
 *
 * ## Attribution is checked here, not trusted
 *
 * The server re-resolves every citation on read and redacts a line unless every
 * note behind it is still shared. This applies that threshold again against
 * what *this* client can currently see, in the spirit of `SessionSynthesis` —
 * because a brief that keeps quoting a note somebody took back would be a way
 * around `visibility: "private"`, and one check is one place to be wrong.
 *
 * One threshold, not the synthesis's two. A synthesis can keep a partly
 * withdrawn item and drop its attribution, because its text is a paraphrase and
 * its names are a union that points at nobody in particular once removed. A
 * brief line is the notes themselves, formatted: a collision names both members
 * and quotes each. There is no version of it with one member removed that is
 * still a true sentence, so a half-withdrawn line is held back whole — the same
 * call `redactWithdrawn` makes in `convex/briefs.ts`, and it has to be the same
 * one, or the client would draw a live citation link and an ontology label
 * around text the server had already replaced.
 */

/** The ink each lens is written in. Ontology colour where the section has one. */
const SECTION_INK: Record<Section["key"], string> = {
  collisions: "var(--accent-strong)",
  "open-questions": typeStyle("open-question").ink,
  "carried-over": typeStyle("open-question").ink,
  floor: typeStyle("critique").ink,
};

/** A heading for a section whose own has gone missing. */
const SECTION_FALLBACK: Record<Section["key"], string> = {
  collisions: "Where the lab collided",
  "open-questions": "Open questions nobody has answered",
  "carried-over": "Still open from earlier sessions",
  floor: "Threads that drew a crowd",
};

export function PresenterBrief({
  session,
  rows,
}: {
  session: SessionDetail;
  /** The paper's margin, as the page already has it. */
  rows: readonly AnnotationView[];
}) {
  const brief = useQuery(api.briefs.getForSession, { sessionId: session._id });
  const generate = useMutation(api.briefs.generate);
  const approve = useMutation(api.briefs.approve);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"assemble" | "approve" | null>(null);

  const visibleAnnotationIds = useMemo(
    () =>
      new Set(
        rows
          .filter((row) => row.visibility === "lab" && !row.deleted)
          .map((row) => row._id),
      ),
    [rows],
  );
  const contributors = useMemo(() => tallyContributors(rows), [rows]);
  const ownNotes = useMemo(() => ownPrivateNotes(rows), [rows]);

  // Nobody else's business. The server answers `null` for anyone who is not
  // the presenter or the PI; this is the same rule, applied before the panel
  // takes up any room at all.
  if (!session.canApprove || session.status === "cancelled") {
    return null;
  }

  async function run(
    kind: "assemble" | "approve",
    action: () => Promise<unknown>,
    fallback: string,
  ) {
    setError(null);
    setPending(kind);
    try {
      await action();
    } catch (caught) {
      setError(readableError(caught, fallback));
    } finally {
      setPending(null);
    }
  }

  const approval = brief === undefined || brief === null ? null : brief.approval;
  const stale = approval !== null && approval.withdrawnSince > 0;

  // The running order is one sequence across the stored sections and the two
  // live ones, because that is how it is read.
  const stored = (brief?.sections ?? []).filter(
    (section) => section.items.length > 0,
  );
  let position = 0;

  return (
    <section className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h2 className={eyebrowClass}>Presenter brief</h2>
          {brief !== undefined && brief !== null && (
            <span className="font-sans text-xs text-ink-faint tabular-nums">
              {brief.trigger === "scheduled"
                ? "Assembled for the meeting"
                : "Assembled"}{" "}
              {relativeWhen(brief.generatedAt)}
              {brief.generation > 1 ? ` · take ${brief.generation}` : ""}
            </span>
          )}
        </div>

        <p className="max-w-prose font-sans text-xs text-ink-faint">
          Everything the lab has already written about this paper, arranged for
          the hour you have to run. Nothing here was generated — every line
          links back to the note it came from. Only you and the PI see it.
        </p>

        {approval !== null && !stale && (
          <p className="font-sans text-xs text-ink-muted">
            Reviewed{" "}
            {approval.approvedByName === undefined
              ? ""
              : `by ${approval.approvedByName} `}
            {relativeWhen(approval.approvedAt)}.
          </p>
        )}

        {stale && (
          <p role="status" className={`${errorClass} max-w-prose`}>
            {approval.withdrawnSince === 1
              ? "A note this brief rests on has been withdrawn or made private since it was reviewed."
              : `${approval.withdrawnSince} of the notes this brief rests on have been withdrawn or made private since it was reviewed.`}{" "}
            The lines that rested on them are held back below. Read it through
            and mark it reviewed again, or assemble it afresh.
          </p>
        )}
      </header>

      {brief === undefined ? (
        <span
          role="status"
          aria-label="Loading the brief"
          className={`${skeletonClass} h-24 w-full`}
        />
      ) : brief === null ? (
        <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
          {session.status === "scheduled"
            ? "No brief yet. One assembles itself two hours before the meeting, out of whatever the lab has written by then — or you can put it together now."
            : "No brief was assembled for this session."}
        </p>
      ) : (
        <ol className="flex flex-col gap-9">
          {stored.map((section) => {
            position += 1;
            return (
              <BriefSection
                key={section.key}
                position={position}
                section={section}
                visibleAnnotationIds={visibleAnnotationIds}
              />
            );
          })}

          {contributors.length > 0 && (
            <Entry
              position={(position += 1)}
              heading="Who has written on this paper"
              count={contributors.length}
              ink="var(--ink-faint)"
            >
              <ul className="flex flex-col gap-2.5">
                {contributors.map((contributor) => (
                  <li
                    key={contributor.memberId}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-1"
                  >
                    <span className="font-serif text-base text-ink">
                      {contributor.mine ? "You" : contributor.name}
                    </span>
                    <span className="font-sans text-xs text-ink-faint tabular-nums">
                      {contributor.total}
                    </span>
                    <span className="flex flex-wrap gap-x-2.5 gap-y-1">
                      {contributor.counts.map(({ type, count }) => (
                        <span
                          key={type}
                          style={{ color: typeStyle(type).ink }}
                          className="font-sans text-[10px] uppercase tracking-[0.12em] tabular-nums"
                        >
                          {typeStyle(type).label} {count}
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
              {/* The complement of this list is not on it, and never will be.
                  A roster with a zero beside somebody's name is the artifact
                  the privacy constitution exists to prevent. */}
              <p className="mt-2.5 font-sans text-[11px] text-ink-faint">
                Counted from what the lab can see. Nobody appears here with
                nothing — Margin records what a member wrote, never that they
                looked.
              </p>
            </Entry>
          )}

          {ownNotes.length > 0 && (
            <Entry
              position={(position += 1)}
              heading="Your own notes on this paper"
              count={ownNotes.length}
              ink="var(--ink-faint)"
            >
              <p className="mb-3 font-sans text-[11px] text-ink-faint">
                Private. These never left your account — not to the lab, not to
                the PI, and not into the brief above.
              </p>
              <ul className="flex flex-col gap-3">
                {ownNotes.map((note) => (
                  <li key={note._id} className="border-l border-rule pl-3">
                    <p className="font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint tabular-nums">
                      Page {note.anchor.pageIndex + 1}
                    </p>
                    {note.body.length > 0 ? (
                      <p className="max-w-prose whitespace-pre-wrap font-serif text-[15px] leading-relaxed text-ink">
                        {note.body}
                      </p>
                    ) : (
                      <blockquote className="max-w-prose font-serif text-[15px] italic leading-snug text-ink-muted">
                        <span className="line-clamp-2">
                          {note.anchor.quote}
                        </span>
                      </blockquote>
                    )}
                  </li>
                ))}
              </ul>
            </Entry>
          )}
        </ol>
      )}

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        {brief !== undefined && brief !== null && (
          <button
            type="button"
            disabled={pending !== null || (approval !== null && !stale)}
            className={approval === null || stale ? primaryButtonClass : secondaryButtonClass}
            onClick={() =>
              run(
                "approve",
                () =>
                  approve({
                    sessionId: session._id,
                    generatedAt: brief.generatedAt,
                  }),
                "That didn't go through.",
              )
            }
          >
            {pending === "approve"
              ? "Marking…"
              : approval !== null && !stale
                ? "Reviewed"
                : approval !== null
                  ? "Mark reviewed again"
                  : "Mark as reviewed"}
          </button>
        )}

        <button
          type="button"
          disabled={pending !== null || brief === undefined}
          className={brief === null ? primaryButtonClass : secondaryButtonClass}
          onClick={() =>
            run(
              "assemble",
              () => generate({ sessionId: session._id }),
              "The brief couldn't be assembled. Try again.",
            )
          }
        >
          {pending === "assemble"
            ? "Assembling…"
            : brief === null
              ? "Assemble the brief"
              : "Assemble it again"}
        </button>

        {brief !== undefined && brief !== null && approval !== null && (
          <span className="max-w-prose font-sans text-xs text-ink-faint">
            Assembling it again starts a new take, which nobody has read yet.
          </span>
        )}
      </div>

      {error !== null && (
        <p role="alert" aria-live="polite" className={`${errorClass} max-w-prose`}>
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * One numbered entry in the running order.
 *
 * The number hangs in a fixed gutter so every heading starts on the same
 * vertical, which is what makes a list of four look like an agenda rather than
 * four headings that happen to be stacked.
 */
function Entry({
  position,
  heading,
  count,
  ink,
  dropped = 0,
  children,
}: {
  position: number;
  heading: string;
  count: number;
  ink: string;
  dropped?: number;
  children: React.ReactNode;
}) {
  return (
    <li className="grid grid-cols-[2.25rem_1fr] items-baseline">
      <span
        aria-hidden="true"
        className="font-sans text-xs text-ink-faint tabular-nums"
      >
        {String(position).padStart(2, "0")}
      </span>
      <div className="flex flex-col gap-3">
        <h3 className="flex flex-wrap items-baseline gap-x-3">
          <span style={{ color: ink }} className={eyebrowClass}>
            {heading}
          </span>
          <span className="font-sans text-[11px] text-ink-faint tabular-nums">
            {count}
          </span>
        </h3>
        {children}
        {dropped > 0 && (
          <p className="font-sans text-xs text-ink-faint tabular-nums">
            +{dropped} more {dropped === 1 ? "line" : "lines"} the brief held
            back.
          </p>
        )}
      </div>
    </li>
  );
}

function BriefSection({
  position,
  section,
  visibleAnnotationIds,
}: {
  position: number;
  section: Section;
  visibleAnnotationIds: ReadonlySet<Id<"annotations">>;
}) {
  const ink = SECTION_INK[section.key];
  return (
    <Entry
      position={position}
      heading={
        section.heading.length > 0
          ? section.heading
          : SECTION_FALLBACK[section.key]
      }
      count={section.items.length}
      ink={ink}
      dropped={section.droppedCount}
    >
      <ul className="flex flex-col gap-5">
        {section.items.map((item, index) => (
          <BriefLine
            key={`${section.key}-${index}`}
            item={item}
            ink={ink}
            visibleAnnotationIds={visibleAnnotationIds}
          />
        ))}
      </ul>
    </Entry>
  );
}

function BriefLine({
  item,
  ink,
  visibleAnnotationIds,
}: {
  item: Item;
  ink: string;
  visibleAnnotationIds: ReadonlySet<Id<"annotations">>;
}) {
  const cited = item.annotationIds.filter((id) => visibleAnnotationIds.has(id));
  // All or nothing, which is the rule the server applies on the way out. A
  // collision line is built from both the notes it cites and names both
  // members, so one of the two going is not a line with a gap in it — it is a
  // line that is still about somebody who took their note back.
  const withdrawn = cited.length < item.annotationIds.length;
  const label = item.pairType === undefined ? undefined : GOLD_PAIRS[item.pairType];

  return (
    <li style={{ borderLeftColor: ink }} className="border-l-2 pl-3.5">
      {withdrawn ? (
        // Held back rather than dropped. A brief that quietly got shorter
        // would tell the presenter their lab wrote less than it did.
        <p className="max-w-prose font-serif text-base italic leading-relaxed text-ink-faint">
          A line here rested on notes that are no longer shared.
        </p>
      ) : (
        <>
          {label !== undefined && (
            <span
              style={{ color: ink }}
              className="font-sans text-[10px] uppercase tracking-[0.14em]"
            >
              {label}
            </span>
          )}
          <p className="max-w-prose font-serif text-base leading-relaxed text-ink">
            {item.text}
          </p>
          <p className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 font-sans text-xs text-ink-faint">
            {item.fromSessionId !== undefined && (
              <Link
                href={`/app/sessions/${item.fromSessionId}`}
                className="text-accent underline-offset-4 hover:underline"
              >
                {item.fromSessionAt === undefined
                  ? "Raised in an earlier session"
                  : `Still open since ${formatDate(item.fromSessionAt)}`}
              </Link>
            )}
            {cited.map((id, position) => (
              <a
                key={id}
                href={`#${annotationAnchorId(id)}`}
                className="text-accent underline-offset-4 hover:underline"
              >
                Note {position + 1}
              </a>
            ))}
          </p>
        </>
      )}
    </li>
  );
}
