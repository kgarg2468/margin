"use client";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { isEmpty } from "@/lib/temporal/derive";
import { formatDate, relativeWhen } from "@/lib/sessions-ui";
import { eyebrowClass } from "@/lib/ui";
import type { FunctionReturnType } from "convex/server";
import { useQuery } from "convex-helpers/react/cache/hooks";
import Link from "next/link";
import { useState } from "react";
import { typeStyle } from "../read/_components/ontology";

/**
 * Over time: what the paper's record says about the lab.
 *
 * Every other section of this page is about the paper — its title, its file, the
 * meetings it is booked for. This one is about the *reading*, and it is the only
 * surface in the product whose subject is a shape rather than a text: a question
 * nobody has answered in three meetings is not a sentence anywhere in the PDF or
 * in the margin, and no amount of searching would find it.
 *
 * ## Drawn as a record, not a dashboard
 *
 * Three lenses, each a hairline-ruled list in the same register as the Sessions
 * section above it — the page's own furniture, so this reads as another entry in
 * the paper's file rather than as analytics that arrived from somewhere else.
 * There is no chart, no total, no trend, and there will not be one. The
 * quantities that appear (three meetings, two revisions) are there because they
 * are the fact being reported, and they are set in the chrome typeface at the
 * weight of a byline.
 *
 * The one place colour does work is the retype: `hypothesis → critique` is
 * drawn in the two ontology inks the rest of the app already uses for those
 * words, because the whole point of the line is that a note moved from one of
 * them to the other. The words say it too, as everywhere else in this app.
 *
 * The numbered gutter is deliberately not borrowed from the presenter's brief.
 * That gesture is a running order — a list somebody works down — and this is not
 * one; a reader arrives here with a question and leaves with an answer to it.
 *
 * ## Absent rather than empty
 *
 * A paper the lab added yesterday has no memory, and nothing here is drawn for
 * it — no heading, no placeholder, and no skeleton while the query is in flight.
 * A skeleton is a promise that something is coming, and this section is allowed
 * to have nothing to say. Week one it is not there; by week six it is the reason
 * the page gets opened.
 *
 * ## What it does not know about you
 *
 * The "since" window is anchored to a meeting the whole lab attended, never to
 * when the reader last looked — there is no cursor in this feature and opening
 * it records nothing. Every line is re-checked against what the lab can still
 * see when the query runs, so a note taken back takes its line with it.
 */

type Index = NonNullable<FunctionReturnType<typeof api.temporal.forPaper>>;
type Unresolved = Index["unresolved"]["items"][number];
type Position = Index["positions"]["items"][number];
type Arrived = NonNullable<Index["changed"]>["arrived"]["items"][number];

export function PaperMemory({ paperId }: { paperId: Id<"papers"> }) {
  /** Which meeting the "since" window is anchored to; `null` is the most recent. */
  const [since, setSince] = useState<Id<"sessions"> | null>(null);

  const index = useQuery(api.temporal.forPaper, {
    paperId,
    ...(since === null ? {} : { sinceSessionId: since }),
  });

  if (index === undefined || index === null || isEmpty(index)) {
    return null;
  }

  const { unresolved, positions, changed } = index;

  return (
    <section className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h2 className={eyebrowClass}>Over time</h2>
        <p className="max-w-prose font-sans text-xs text-ink-faint">
          What this paper&rsquo;s record says about the lab: what nobody has
          settled, where somebody changed their mind, and what has arrived since
          you last met on it. Worked out from notes the lab can still see, every
          time this page is opened — nothing here is stored, and nothing records
          that you read it.
        </p>
      </header>

      {unresolved.items.length > 0 && (
        <Lens
          heading="Still unanswered"
          count={unresolved.items.length}
          ink={typeStyle("open-question").ink}
          dropped={unresolved.droppedCount}
          note="Open questions the lab has now met on more than once without writing an answer under them."
        >
          {unresolved.items.map((item) => (
            <UnresolvedRow key={item.annotationId} item={item} paperId={paperId} />
          ))}
        </Lens>
      )}

      {positions.items.length > 0 && (
        <Lens
          heading="Where positions moved"
          count={positions.items.length}
          ink={typeStyle("critique").ink}
          dropped={positions.droppedCount}
          note="Notes their author retyped into something else, or took back and put out again."
        >
          {positions.items.map((item) => (
            <PositionRow key={item.annotationId} item={item} paperId={paperId} />
          ))}
        </Lens>
      )}

      {changed !== null && (
        <Lens
          heading={
            changed.anchor.sessionId === undefined
              ? `Since ${formatDate(changed.anchor.at)}`
              : `Since the ${formatDate(changed.anchor.at)} meeting`
          }
          count={changed.arrived.items.length}
          ink="var(--accent-strong)"
          dropped={changed.arrived.droppedCount}
          note={summarize(changed.counts, changed.meetings.length)}
          anchors={
            index.anchors.length > 1 ? (
              <Anchors
                anchors={index.anchors}
                current={changed.anchor.sessionId ?? null}
                onPick={setSince}
              />
            ) : undefined
          }
        >
          {changed.arrived.items.map((item) => (
            <ArrivedRow key={item.annotationId} item={item} paperId={paperId} />
          ))}
        </Lens>
      )}

      {index.truncated && (
        // Said rather than hidden. A paper with more history than one pass reads
        // is far outside the shape of a journal club, and a surface that
        // silently reported on a slice of it would be the worst of both.
        <p className="max-w-prose font-sans text-[11px] text-ink-faint">
          This paper has more history than the index reads in one pass. These
          lenses cover its recent end.
        </p>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------
 * The furniture
 * ---------------------------------------------------------------------- */

/**
 * One lens: a small-caps heading in the ink of what it holds, a line of prose
 * saying what it is, and a hairline-ruled list — the Sessions section's own
 * shape, because this belongs to the same page and the same file.
 */
function Lens({
  heading,
  count,
  ink,
  note,
  dropped,
  anchors,
  children,
}: {
  heading: string;
  count: number;
  ink: string;
  note: string;
  dropped: number;
  anchors?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span style={{ color: ink }} className={eyebrowClass}>
          {heading}
        </span>
        {count > 0 && (
          <span className="font-sans text-[11px] text-ink-faint tabular-nums">
            {count}
          </span>
        )}
      </h3>

      <p className="max-w-prose font-sans text-xs text-ink-faint">{note}</p>

      {anchors}

      {count > 0 && (
        <ul className="flex flex-col divide-y divide-rule border-y border-rule">
          {children}
        </ul>
      )}

      {dropped > 0 && (
        <p className="font-sans text-xs text-ink-faint tabular-nums">
          +{dropped} more the index held back.
        </p>
      )}
    </div>
  );
}

/**
 * A note as it reads in a list: what the member said, or the passage they marked
 * when they said nothing.
 *
 * The body is preferred over the quote for the reason `noteLine` gives in
 * `lib/brief/assemble.ts` — the body is what the member *said* and the passage is
 * only where they said it — and an empty body is a real and common object, so
 * the fallback says which of the two it is showing rather than quoting the paper
 * as though a member had written it.
 */
function Said({ body, quote }: { body: string; quote: string }) {
  if (body.length > 0) {
    return (
      <p className="max-w-prose font-serif text-base leading-relaxed text-ink">
        {body}
      </p>
    );
  }
  return (
    <blockquote className="max-w-prose font-serif text-base italic leading-snug text-ink-muted">
      <span className="line-clamp-2">{quote}</span>
    </blockquote>
  );
}

/** The meta line under a note: chrome typeface, faint, tabular figures. */
function Meta({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 font-sans text-xs text-ink-faint tabular-nums">
      {children}
    </p>
  );
}

function Dot() {
  return <span aria-hidden="true">·</span>;
}

/** Into the reader, at the note itself — the `?note=` the notifications use. */
function NoteLink({
  paperId,
  annotationId,
}: {
  paperId: Id<"papers">;
  annotationId: Id<"annotations">;
}) {
  return (
    <Link
      href={`/app/library/${paperId}/read?note=${annotationId}`}
      className="text-accent underline-offset-4 hover:underline"
    >
      Open in the margin
    </Link>
  );
}

/* -------------------------------------------------------------------------
 * The three rows
 * ---------------------------------------------------------------------- */

function UnresolvedRow({
  item,
  paperId,
}: {
  item: Unresolved;
  paperId: Id<"papers">;
}) {
  const ink = typeStyle("open-question").ink;
  return (
    <li className="flex flex-col gap-1 py-3">
      <Said body={item.body} quote={item.quote} />
      <Meta>
        <span>{item.memberName}</span>
        <Dot />
        <span>p. {item.pageIndex + 1}</span>
        <Dot />
        <span>asked {formatDate(item.askedAt)}</span>
        <Dot />
        {/* The fact the lens exists for, so it takes the ink. The words carry
            it as well: colour is never the only channel. */}
        <span style={{ color: ink }}>
          through {item.meetings} {item.meetings === 1 ? "meeting" : "meetings"}
        </span>
        <Dot />
        <Link
          href={`/app/sessions/${item.lastMeetingId}`}
          className="text-accent underline-offset-4 hover:underline"
        >
          last {formatDate(item.lastMeetingAt)}
        </Link>
        <Dot />
        <NoteLink paperId={paperId} annotationId={item.annotationId} />
      </Meta>
    </li>
  );
}

function PositionRow({
  item,
  paperId,
}: {
  item: Position;
  paperId: Id<"papers">;
}) {
  return (
    <li className="flex flex-col gap-1 py-3">
      <Said body={item.body} quote={item.quote} />
      <Meta>
        <span>{item.memberName}</span>
        <Dot />
        <span>p. {item.pageIndex + 1}</span>

        {item.retyped !== undefined && (
          <>
            <Dot />
            <span>
              <span style={{ color: typeStyle(item.retyped.from).ink }}>
                {typeStyle(item.retyped.from).label.toLowerCase()}
              </span>
              <span aria-hidden="true" className="px-1">
                →
              </span>
              <span style={{ color: typeStyle(item.retyped.to).ink }}>
                {typeStyle(item.retyped.to).label.toLowerCase()}
              </span>
            </span>
          </>
        )}

        {item.restated !== undefined && (
          <>
            <Dot />
            <span>
              taken back {formatDate(item.restated.takenBackAt)}, shared again{" "}
              {formatDate(item.restated.restatedAt)}
            </span>
          </>
        )}

        {item.revisions > 1 && (
          // "Edited", not "rewritten": the ledger records that a note changed
          // without saying which field moved, and a retype leaves a row here
          // too. The narrower word would be a claim it cannot support.
          <>
            <Dot />
            <span>edited {item.revisions} times</span>
          </>
        )}

        <Dot />
        <NoteLink paperId={paperId} annotationId={item.annotationId} />
      </Meta>
    </li>
  );
}

function ArrivedRow({
  item,
  paperId,
}: {
  item: Arrived;
  paperId: Id<"papers">;
}) {
  const style = typeStyle(item.type);
  const heldBack = item.arrivedAt > item.writtenAt;
  return (
    <li className="flex flex-col gap-1 py-3">
      <Said body={item.body} quote={item.quote} />
      <Meta>
        <span>{item.memberName}</span>
        <Dot />
        <span>p. {item.pageIndex + 1}</span>
        {item.type !== "note" && (
          <>
            <Dot />
            <span style={{ color: style.ink }}>
              {style.label.toLowerCase()}
            </span>
          </>
        )}
        <Dot />
        {/* A note drafted privately and shared later arrived when it was
            shared, and saying only the later date would misdate the thinking
            behind it. Both, in the order they happened. */}
        <span>
          {heldBack
            ? `written ${formatDate(item.writtenAt)}, shared ${formatDate(item.arrivedAt)}`
            : relativeWhen(item.arrivedAt)}
        </span>
        <Dot />
        <NoteLink paperId={paperId} annotationId={item.annotationId} />
      </Meta>
    </li>
  );
}

/* -------------------------------------------------------------------------
 * Moving the window
 * ---------------------------------------------------------------------- */

/**
 * The meetings the window can be anchored to, as dates rather than a menu.
 *
 * A select would be one fewer element and the wrong object: these are the lab's
 * own meetings on this paper, they are few, and reading the list is half the
 * answer — "we have discussed this four times" is a fact the picker gives away
 * for free.
 */
function Anchors({
  anchors,
  current,
  onPick,
}: {
  anchors: Index["anchors"];
  current: Id<"sessions"> | null;
  onPick: (sessionId: Id<"sessions">) => void;
}) {
  return (
    <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-sans text-xs text-ink-faint tabular-nums">
      <span>Measured from</span>
      {anchors.map((anchor) => {
        const active = anchor.sessionId === current;
        return (
          <button
            key={anchor.sessionId}
            type="button"
            aria-pressed={active}
            onClick={() => onPick(anchor.sessionId)}
            className={
              "underline-offset-4 motion-safe:transition-colors motion-safe:duration-200 " +
              (active
                ? "text-ink-strong underline"
                : "text-ink-faint hover:text-accent")
            }
          >
            {formatDate(anchor.at)}
          </button>
        );
      })}
    </p>
  );
}

/**
 * The window in one sentence.
 *
 * Written out rather than drawn as four counters, because four counters is a
 * dashboard and a sentence is a note. Nothing is reported with a zero: a lab
 * that wrote no replies is not owed the word "replies", and a surface that
 * printed `0` beside every quiet week would be measuring the lab rather than
 * reporting to it.
 *
 * There is no count of what was withdrawn, and there cannot be — see
 * `changedSince` in `lib/temporal/derive.ts`.
 */
function summarize(
  counts: NonNullable<Index["changed"]>["counts"],
  meetings: number,
): string {
  const parts: string[] = [];
  if (counts.written > 0) {
    parts.push(`${counts.written} new ${counts.written === 1 ? "note" : "notes"}`);
  }
  if (counts.shared > 0) {
    parts.push(
      `${counts.shared} written earlier and shared since`,
    );
  }
  if (counts.replies > 0) {
    parts.push(`${counts.replies} ${counts.replies === 1 ? "reply" : "replies"}`);
  }
  if (counts.revised > 0) {
    parts.push(`${counts.revised} rewritten`);
  }
  if (meetings > 0) {
    parts.push(`${meetings} ${meetings === 1 ? "meeting" : "meetings"} held`);
  }
  if (parts.length === 0) {
    return "Nothing has been written on this paper since.";
  }
  return `${parts.join(", ")}.`;
}
