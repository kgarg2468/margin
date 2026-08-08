"use client";

import type { Id } from "@/convex/_generated/dataModel";
import { eyebrowClass } from "@/lib/ui";
import type { AnnotationType } from "../../../library/[paperId]/read/_components/ontology";
import { typeStyle } from "../../../library/[paperId]/read/_components/ontology";
import type { AnnotationView } from "../../../library/[paperId]/read/_components/types";
import type { PassageGroup, SessionNotes } from "./session-notes";
import { ofType } from "./session-notes";

/**
 * The collective view of a journal club, in three pieces: a spine, a map, and
 * a floor.
 *
 * These render the same on the projector during the meeting and on the page
 * afterwards, because they are the same object — what the lab wrote in the
 * margin, cut two ways. The live view is this board with a header that can end
 * the session; the record is this board with a write-up under it.
 *
 * ## Where a note appears
 *
 * Exactly once, and which place is decided by its type. Three of the seven —
 * open question, critique, connection to own work — are the types a journal
 * club talks *from*, so they stand in the floor's columns where the presenter
 * can work down them. The other four are things the lab noticed *in the paper*,
 * so they sit beside the passage they were written on. Every type is counted in
 * both the spine and the passage's marks, so the map stays complete either way.
 *
 * Nothing here is grouped by member. The passage marks are per type, the spine
 * is per type, and no view in this file can answer "who has read this".
 */

/** The three types the floor is built from, in the order a meeting works down them. */
const FLOOR: readonly { type: AnnotationType; heading: string; empty: string }[] =
  [
    {
      type: "open-question",
      heading: "Open questions",
      empty: "Questions the lab types in the margin land here.",
    },
    {
      type: "critique",
      heading: "Critiques",
      empty: "Nothing challenged yet.",
    },
    {
      type: "connection-to-own-work",
      heading: "Connections",
      empty: "Nobody has tied this to their own work yet.",
    },
  ];

/** Types with no column of their own: they belong beside their passage. */
const AT_THE_PASSAGE: readonly AnnotationType[] = [
  "hypothesis",
  "method-note",
  "definition",
  "note",
];

/** A projector should not try to paint four hundred passage cards. */
const MAX_PASSAGE_CARDS = 40;

/**
 * The session's spine: one segmented rule, a band of ink per annotation type,
 * each as wide as the lab made it.
 *
 * It is the fore-edge of the meeting — the shape of an hour, before anybody
 * reads a word of it. A session that is all rust has been picked apart; one
 * that is all violet has questions and no answers. The legend under it carries
 * the same numbers in text, so the colour is a second channel and never the
 * only one.
 */
export function SessionSpine({ notes }: { notes: SessionNotes }) {
  if (notes.total === 0) {
    return null;
  }
  const summary = notes.counts
    .map(({ type, count }) => `${count} ${typeStyle(type).label.toLowerCase()}`)
    .join(", ");

  return (
    <div className="flex flex-col gap-2.5">
      <div
        role="img"
        aria-label={`${notes.total} notes in this session: ${summary}`}
        className="flex h-1.5 w-full gap-px overflow-hidden bg-rule"
      >
        {notes.counts.map(({ type, count }) => (
          <span
            key={type}
            style={{
              flex: `${count} 0 0%`,
              backgroundColor: typeStyle(type).ink,
            }}
          />
        ))}
      </div>
      <ul aria-hidden="true" className="flex flex-wrap gap-x-4 gap-y-1">
        {notes.counts.map(({ type, count }) => (
          <li
            key={type}
            style={{ color: typeStyle(type).ink }}
            className="font-sans text-[11px] uppercase tracking-[0.12em] tabular-nums"
          >
            {typeStyle(type).label} {count}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Where the lab stopped: the passages that got marked, in the order they occur
 * in the paper.
 *
 * Document order rather than most-marked-first, because the meeting walks the
 * paper. The card that has been marked six times is already the loudest thing
 * on the page — it has six ticks — and re-sorting the paper around it would
 * cost the reader the one axis they can navigate by.
 */
export function PassageBoard({
  notes,
  readHref,
}: {
  notes: SessionNotes;
  readHref: string;
}) {
  if (notes.passages.length === 0) {
    return (
      <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
        Nothing marked yet. Open the paper and the passages the lab stops on
        appear here as they are written.
      </p>
    );
  }

  const shown = notes.passages.slice(0, MAX_PASSAGE_CARDS);
  const hidden = notes.passages.length - shown.length;

  return (
    <div className="flex flex-col gap-4">
      {/* `items-start`, not the grid's default stretch: a card's rule is the
          length of what the lab wrote on that passage, and a two-line note
          under a six-line one should not be given four lines of empty ink. */}
      <div className="grid items-start gap-x-8 gap-y-6 md:grid-cols-2 xl:grid-cols-3">
        {shown.map((passage) => (
          <PassageCard key={passage.key} passage={passage} />
        ))}
      </div>
      {hidden > 0 && (
        <p className="font-sans text-xs text-ink-faint">
          {hidden} more marked {hidden === 1 ? "passage" : "passages"} —{" "}
          <a
            href={readHref}
            className="text-accent underline-offset-4 hover:underline"
          >
            read the paper
          </a>{" "}
          to see them in place.
        </p>
      )}
    </div>
  );
}

/**
 * The rest of the paper's margin.
 *
 * The board is scoped to notes written *in this session*, which is what makes
 * it a record of a meeting rather than of a paper. But a member who opened the
 * paper from the library rather than from the session link writes notes with no
 * session on them, and they are just as much the lab's thinking — so the count
 * is always on the screen with a way through to it. Never invisible, never
 * silently mixed in.
 */
export function MarginElsewhere({
  count,
  readHref,
}: {
  count: number;
  readHref: string;
}) {
  if (count === 0) {
    return null;
  }
  return (
    <p className="font-sans text-xs text-ink-faint tabular-nums">
      {count} more lab {count === 1 ? "note" : "notes"} on this paper{" "}
      {count === 1 ? "was" : "were"} written outside this session —{" "}
      <a href={readHref} className="text-accent underline-offset-4 hover:underline">
        read them in the margin
      </a>
      .
    </p>
  );
}

function PassageCard({ passage }: { passage: PassageGroup }) {
  const dominant = passage.marks[0]?.type ?? "note";
  const beside = passage.notes.filter((note) =>
    AT_THE_PASSAGE.includes(note.type),
  );

  return (
    <article
      style={{ borderLeftColor: typeStyle(dominant).ink }}
      className="flex flex-col gap-2 border-l-2 bg-surface py-1.5 pl-3.5 pr-1"
    >
      <span className="font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint tabular-nums">
        Page {passage.pageIndex + 1}
        {passage.notes.length > 1 ? ` · ${passage.notes.length} notes` : ""}
      </span>

      <blockquote className="font-serif text-[15px] italic leading-snug text-ink">
        <span className="line-clamp-4">{passage.quote}</span>
      </blockquote>

      <ul className="flex flex-wrap gap-1.5">
        {passage.marks.map(({ type, count }) => {
          const style = typeStyle(type);
          return (
            <li
              key={type}
              style={{ color: style.ink, borderColor: style.ink }}
              className="rounded-sm border px-1.5 py-0.5 font-sans text-[10px] uppercase tracking-[0.1em] tabular-nums"
            >
              {style.label}
              {count > 1 ? ` ${count}` : ""}
            </li>
          );
        })}
      </ul>

      {beside.length > 0 && (
        <ul className="flex flex-col gap-1.5 border-t border-rule pt-2">
          {beside.map((note) => (
            <li key={note._id}>
              {note.body.length > 0 ? (
                <p className="whitespace-pre-wrap font-serif text-sm leading-relaxed text-ink">
                  {note.body}
                </p>
              ) : (
                <p className="font-serif text-sm italic leading-relaxed text-ink-muted">
                  Marked, without a comment.
                </p>
              )}
              <p className="font-sans text-[11px] text-ink-faint">
                {note.mine ? "You" : note.authorName}
              </p>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

/**
 * The floor: presenter notes, then the three typed columns a discussion runs
 * down.
 *
 * Empty columns are drawn rather than hidden. A journal club with no critiques
 * on the board is a fact about the meeting, and a column that appears halfway
 * through would move everything under it while somebody was reading.
 */
export function FloorColumns({
  notes,
  presenterNotes,
  presenterName,
  showPresenter = true,
}: {
  notes: SessionNotes;
  presenterNotes?: string;
  presenterName?: string;
  /**
   * Off on the session page, where the outline already has a section of its
   * own — an editable one. On the projector it is on, because the presenter's
   * plan belongs beside the discussion it is trying to run.
   */
  showPresenter?: boolean;
}) {
  return (
    <div
      className={
        "grid gap-x-8 gap-y-8 md:grid-cols-2 " +
        (showPresenter ? "xl:grid-cols-4" : "xl:grid-cols-3")
      }
    >
      {showPresenter && (
        <section className="flex flex-col gap-3">
          <h3 className={eyebrowClass}>
            Presenter&rsquo;s notes
            {presenterName !== undefined ? ` · ${presenterName}` : ""}
          </h3>
          {presenterNotes === undefined || presenterNotes.length === 0 ? (
            <p className="font-serif text-sm leading-relaxed text-ink-faint">
              The presenter hasn&rsquo;t written an outline.
            </p>
          ) : (
            <p className="whitespace-pre-wrap font-serif text-[15px] leading-relaxed text-ink">
              {presenterNotes}
            </p>
          )}
        </section>
      )}

      {FLOOR.map((column) => {
        const rows = ofType(notes.inSession, column.type);
        const style = typeStyle(column.type);
        return (
          <section key={column.type} className="flex flex-col gap-3">
            <h3 className="flex items-baseline gap-2">
              <span style={{ color: style.ink }} className={eyebrowClass}>
                {column.heading}
              </span>
              {rows.length > 0 && (
                <span className="font-sans text-[11px] text-ink-faint tabular-nums">
                  {rows.length}
                </span>
              )}
            </h3>
            {rows.length === 0 ? (
              <p className="font-serif text-sm leading-relaxed text-ink-faint">
                {column.empty}
              </p>
            ) : (
              <ul className="flex flex-col gap-4">
                {rows.map((note) => (
                  <FloorNote
                    key={note._id}
                    note={note}
                    ink={style.ink}
                    replies={notes.repliesByParent.get(note._id) ?? EMPTY}
                  />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

const EMPTY: AnnotationView[] = [];

function FloorNote({
  note,
  ink,
  replies,
}: {
  note: AnnotationView;
  ink: string;
  replies: AnnotationView[];
}) {
  return (
    <li
      id={annotationAnchorId(note._id)}
      style={{ borderLeftColor: ink }}
      className="scroll-mt-24 border-l-2 pl-3"
    >
      {note.body.length > 0 ? (
        <p className="whitespace-pre-wrap font-serif text-[15px] leading-relaxed text-ink">
          {note.body}
        </p>
      ) : (
        <p className="font-serif text-[15px] italic leading-relaxed text-ink-muted">
          Marked, without a comment.
        </p>
      )}

      <p className="mt-1 font-sans text-[11px] text-ink-faint tabular-nums">
        {note.mine ? "You" : note.authorName} · p. {note.anchor.pageIndex + 1}
        {replies.length > 0
          ? ` · ${replies.length} ${replies.length === 1 ? "reply" : "replies"}`
          : ""}
      </p>

      <blockquote className="mt-1 font-serif text-[13px] italic leading-snug text-ink-faint">
        <span className="line-clamp-2">{note.anchor.quote}</span>
      </blockquote>

      {replies.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1.5 border-l border-rule pl-2.5">
          {replies.map((reply) => (
            <li key={reply._id}>
              <p className="whitespace-pre-wrap font-serif text-sm leading-snug text-ink">
                {reply.body}
              </p>
              <p className="font-sans text-[11px] text-ink-faint">
                {reply.mine ? "You" : reply.authorName}
              </p>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** Where a synthesis item's citation jumps to. */
export function annotationAnchorId(id: Id<"annotations">): string {
  return `note-${id}`;
}
