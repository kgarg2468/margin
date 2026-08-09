"use client";

import { readableError } from "@/app/(app)/app/_components/errors";
import { api } from "@/convex/_generated/api";
import { useMutation } from "convex/react";
import { useState } from "react";
import type { AnnotationView } from "./types";

/**
 * Marks in the margin.
 *
 * The cheapest thing anyone can say about a colleague's note, and the one place
 * Margin borrows a mechanic from social software — so the register matters more
 * here than anywhere else in the product. Two decisions carry it:
 *
 * **Words, not emoji.** A stamp reading AGREE is a thing a referee does to a
 * manuscript; a thumbs-up is a thing that happens on a phone. Emoji would also
 * be the only full-colour objects in a two-hue letterpress palette, so they
 * would win every page they appeared on — which is precisely backwards for a
 * control this small. The marks are set in the same micro-caps as the type
 * badge above them and inherit `currentColor`, so they cost the page nothing.
 *
 * **Five, fixed, and none of them a score.** Agree and Doubt are the two
 * halves of reading an argument; Key and Unclear are what a reader flags for
 * themselves; Discuss is the one that only makes sense in journal-club
 * software. Nothing in the product sorts or ranks by any of them — a margin
 * with a leaderboard in it is a margin nobody writes the difficult note in.
 */

export type ReactionKind = AnnotationView["reactions"][number]["kind"];

type Mark = {
  kind: ReactionKind;
  label: string;
  /** Said in full the first time the row is opened, so the set teaches itself. */
  meaning: string;
};

/** The order the chips are always drawn in: the two verdicts, then the three flags. */
export const REACTION_MARKS: readonly Mark[] = [
  { kind: "agree", label: "Agree", meaning: "This holds up" },
  { kind: "doubt", label: "Doubt", meaning: "I'm not convinced" },
  { kind: "key", label: "Key", meaning: "The important point here" },
  { kind: "unclear", label: "Unclear", meaning: "I don't follow this" },
  { kind: "discuss", label: "Discuss", meaning: "Raise it at the meeting" },
];

/** "You", "You and Tom", "Nadia, Tom and 3 others" — never a bare number. */
function roster(people: string[], hidden: number): string {
  const parts =
    hidden > 0
      ? [...people, `${hidden} other${hidden === 1 ? "" : "s"}`]
      : people;
  if (parts.length === 0) {
    return "";
  }
  if (parts.length === 1) {
    return parts[0] as string;
  }
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1) as string}`;
}

export function Reactions({
  annotation,
  onError,
}: {
  annotation: AnnotationView;
  /** Surfaced in the card's one alert line, so a card never grows a second. */
  onError: (message: string | null) => void;
}) {
  const react = useMutation(api.annotations.react);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<ReactionKind | null>(null);

  const byKind = new Map(annotation.reactions.map((entry) => [entry.kind, entry]));

  // Closed, the row is only what the lab actually said — an empty note carries
  // no chips at all, just the quiet control that offers them. Opened, the same
  // row grows to the full set in place rather than opening a second surface
  // underneath: the marks you could make and the marks that exist are the same
  // five things, and drawing them twice would say otherwise.
  const shown = open
    ? REACTION_MARKS
    : REACTION_MARKS.filter((mark) => byKind.has(mark.kind));

  async function toggle(kind: ReactionKind) {
    setPending(kind);
    onError(null);
    try {
      await react({ annotationId: annotation._id, kind });
    } catch (caught) {
      onError(readableError(caught, "That mark didn't stick."));
    } finally {
      setPending(null);
    }
  }

  return (
    <div
      role="group"
      aria-label="Marks on this note"
      // gap-y-2 for the same reason the type chips have it: the 44px hit boxes
      // are taller than the chips and would otherwise collide between rows.
      //
      // And the other half of the same argument, because gap alone does not
      // close it: `tap-target`'s box is centred, so on a 14px control it
      // reaches 14px past each edge, and the card's action row — Reply, Edit,
      // Status — sits directly under this one. Measured, "Mark" was
      // unreachable at its own centre. Capped at 8px past each edge down the
      // column, which is under half the gap either way; the full 44px stands
      // across, and everywhere else in the card.
      className={
        "mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-2 " +
        "[&>.tap-target]:after:h-[calc(100%+1rem)] [&>.tap-target]:after:min-h-0"
      }
    >
      {shown.map((mark) => {
        const entry = byKind.get(mark.kind);
        const count = entry?.count ?? 0;
        const mine = entry?.mine ?? false;
        const hidden = count - (entry?.names.length ?? 0) - (mine ? 1 : 0);
        const people = roster(
          mine ? ["You", ...(entry?.names ?? [])] : (entry?.names ?? []),
          Math.max(hidden, 0),
        );

        return (
          <button
            key={mark.kind}
            type="button"
            aria-pressed={mine}
            disabled={pending !== null}
            // Hover gets who; the accessible name gets the label first (so it
            // still matches what the eye reads) and then the same sentence.
            title={count === 0 ? mark.meaning : `${mark.label} — ${people}`}
            aria-label={
              count === 0
                ? `${mark.label}. ${mark.meaning}.`
                : `${mark.label}, ${count}. ${people}.`
            }
            onClick={() => void toggle(mark.kind)}
            className={
              "tap-target pressable inline-flex items-center rounded-full border px-2 py-1 font-sans " +
              "text-[9px] uppercase tracking-[0.12em] disabled:cursor-not-allowed disabled:opacity-50 " +
              (mine
                ? // Yours reads as a mark pressed into the page: the passage
                  // wash behind it and the accent on its edge, the same pair
                  // the type chips use for the type you chose. Ink rather than
                  // accent for the word itself — accent on its own wash is a
                  // hue against the same hue, and this is 9px type.
                  "border-accent bg-highlight text-ink"
                : count === 0
                  ? // Offered but unsaid: a dashed edge, the way an empty
                    // field is drawn everywhere else in the app.
                    "pop-in border-dashed border-rule text-ink-faint hover:border-ink-faint hover:text-ink-muted"
                  : "border-rule text-ink-muted hover:border-ink-faint hover:text-ink")
            }
          >
            {mark.label}
            {count > 0 && (
              <span className="ml-1.5 tabular-nums opacity-70">{count}</span>
            )}
          </button>
        );
      })}

      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className={
          "tap-target font-sans text-[9px] uppercase tracking-[0.12em] text-ink-faint " +
          "underline-offset-4 transition-colors hover:text-accent hover:underline"
        }
      >
        {open ? "Done" : "Mark"}
      </button>
    </div>
  );
}
