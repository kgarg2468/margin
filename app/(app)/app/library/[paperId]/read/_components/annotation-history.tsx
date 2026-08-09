"use client";

import { api } from "@/convex/_generated/api";
import {
  buildHistory,
  changeSummary,
  versionSummary,
} from "@/lib/annotation-history/history";
import { skeletonClass } from "@/lib/ui";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { typeStyle } from "./ontology";
import type { AnnotationView } from "./types";

/**
 * What a note used to say, under the note.
 *
 * The register is the whole design problem here. A margin is a place people
 * write half-formed things in, and a product that renders every revision as a
 * tracked-changes diff turns writing a note into publishing a draft — which is
 * exactly the chill the annotation ontology exists to avoid. So this is a
 * disclosure, closed by default, opening onto plain prior bodies in the same
 * serif the note is set in. No diff colours, no strikethrough, no red. What
 * the panel adds beyond the words is one faint line per version saying when it
 * stopped being true and what the edit changed, because those are the two
 * things a reader of a lab's memory is actually asking.
 *
 * ## The query does not run until it is opened
 *
 * A rail can hold a hundred cards. Subscribing each one to its own history on
 * render would be a hundred live queries to draw a control nobody has pressed,
 * so the card knows *whether* there is a history from a count it already has
 * (`versionCount`, which rides on the annotation) and this fetches *what* it
 * is only on demand.
 *
 * ## Who sees it
 *
 * Not decided here. The server reads the audience off the parent annotation on
 * every read, so a note flipped to private takes its history with it in the
 * same instant — and this component would get an empty list back for a note it
 * is somehow still rendering. The client gating below is convenience, never
 * the guarantee.
 */

/**
 * A version's timestamp, absolute rather than relative.
 *
 * The card's own `when()` says "3h ago", which is right for a thing that just
 * happened and wrong for a history: "what did this say in March" is a question
 * about a date, and a list of nine relative offsets is one nobody can hold in
 * their head. Pinned to one locale for the same reason `when()` is.
 */
function stamp(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * When a state was true, in the fewest words that stay true.
 *
 * A prior state is named by when it *ended*, not by a range: its start is the
 * previous state's end, which is the line directly below it, and printing both
 * would set every timestamp twice. The current state is named by when it began
 * — and when even that is unknown (the version before it has been dropped) it
 * says nothing at all rather than reaching for the note's creation date, which
 * would be a moment several edits before this state existed.
 */
function interval(entry: {
  current: boolean;
  from: number | null;
  until: number | null;
}): string {
  if (entry.current) {
    return entry.from === null ? "now" : `now — since ${stamp(entry.from)}`;
  }
  return entry.until === null ? "an earlier version" : `until ${stamp(entry.until)}`;
}

export function AnnotationHistory({
  annotation,
  open,
}: {
  annotation: AnnotationView;
  /** Nothing is fetched while this is false. */
  open: boolean;
}) {
  const history = useQuery(
    api.annotationVersions.listForAnnotation,
    open ? { annotationId: annotation._id } : "skip",
  );

  if (!open) {
    return null;
  }

  if (history === undefined) {
    return (
      <div className="mt-2 border-l border-rule pl-2.5">
        <span
          role="status"
          aria-label="Loading this note's history"
          className={`${skeletonClass} h-12 w-full`}
        />
      </div>
    );
  }

  const { entries, total, droppedCount, truncated } = buildHistory(
    {
      body: annotation.body,
      type: annotation.type,
      createdAt: annotation.createdAt,
      versionCount: annotation.versionCount,
    },
    history.versions,
  );

  return (
    <div className="pop-in mt-2 border-l border-rule pl-2.5">
      <p className="font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint">
        {versionSummary(total)}
      </p>

      <ol className="mt-1.5 flex flex-col gap-2">
        {entries.map((entry) => {
          const style = typeStyle(entry.type);
          const changed = changeSummary(entry.changed);

          return (
            <li key={entry.version}>
              <p className="flex flex-wrap items-baseline gap-x-1.5 font-sans text-[11px] text-ink-faint">
                <span style={{ color: style.ink }}>{style.label}</span>
                {/* The current state is labelled by what it is rather than by
                    its ordinal: "Now" is the thing a reader is comparing
                    everything else against, and it is the body already drawn
                    above this panel rather than a copy of it. */}
                <span>{interval(entry)}</span>
                {changed !== null && <span>· {changed}</span>}
              </p>

              {/* The live body is the card, three lines up. Repeating it here
                  would make the panel a list in which one item is a duplicate
                  of the page it is on. */}
              {!entry.current &&
                (entry.body.length > 0 ? (
                  <p className="mt-0.5 whitespace-pre-wrap font-serif text-sm leading-snug text-ink-muted">
                    {entry.body}
                  </p>
                ) : (
                  <p className="mt-0.5 font-serif text-sm italic leading-snug text-ink-faint">
                    No words — a bare highlight.
                  </p>
                ))}
            </li>
          );
        })}
      </ol>

      {/* The honest line. A history that has outgrown its retention says so
          rather than presenting its surviving tail as the beginning. */}
      {truncated && (
        <p className="mt-2 font-sans text-[11px] text-ink-faint">
          {droppedCount === 1
            ? "The first version is no longer kept."
            : `The first ${droppedCount} versions are no longer kept.`}
        </p>
      )}
    </div>
  );
}
