"use client";

import { readableError } from "@/app/(app)/app/_components/errors";
import { api } from "@/convex/_generated/api";
import {
  STATUS_MARKS,
  statusLine,
  statusWord,
  supersessionLine,
  type EpistemicStatus,
} from "@/lib/epistemic/status";
import { selectClass } from "@/lib/ui";
import { useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { useState } from "react";
import type { AnnotationId, AnnotationView } from "./types";

/**
 * Where the lab says a claim stands.
 *
 * The register is the whole problem here, the way it was for the marks. A
 * reaction is one person's tap and it is drawn as a chip; a status is the
 * *lab's* verdict on a passage, so it has to read as heavier than a chip while
 * staying quieter than the note it sits under — which rules out both a coloured
 * pill and any second hue. What it gets instead is the letterpress move: the
 * verdict set in the same micro-caps as the type badge but in full ink rather
 * than an ontology colour, and its provenance trailing behind it in the faint
 * sans the timestamps already use. One word, pressed into the page.
 *
 * **The verdict and its citation are set apart, always.** Three of the four
 * words are the whole fact. `Superseded` is a reference, and a reference that
 * cannot be checked has to say so — so the line reads "Superseded · by a note
 * that is no longer shared" rather than dropping quietly to "Superseded", which
 * a reader would take as complete. The words come from `lib/epistemic/status`
 * so the server and the margin cannot end up with two vocabularies.
 */

/** A verdict is a dated fact, so it gets a date rather than "3h ago". */
function stamp(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

/**
 * The standing line: what the lab has said about this note, to everybody who
 * can see the note.
 *
 * Nothing at all in the ordinary case — almost every note in a margin is
 * unmarked, and a card that announced "nobody has ruled on this" would have
 * turned reading into filing. The server sends no status for a note that is
 * private or withdrawn, so there is no audience decision to make here.
 */
export function StatusLine({ annotation }: { annotation: AnnotationView }) {
  const status = annotation.status;
  if (status === undefined) {
    return null;
  }

  const mark = {
    value: status.value,
    by: status.supersededByName,
    redacted: status.supersededByRedacted,
  };
  const citation = supersessionLine(mark);

  return (
    <p
      className="mt-2 flex flex-wrap items-baseline gap-x-1.5"
      // The whole sentence for anyone not reading the two registers apart.
      aria-label={`${statusLine(mark)}. Marked by ${status.byName}.`}
    >
      <span className="font-sans text-[10px] uppercase tracking-[0.14em] text-ink">
        {statusWord(status.value)}
      </span>
      {citation !== null && (
        <span className="font-sans text-[11px] text-ink-muted">{citation}</span>
      )}
      <span className="font-sans text-[11px] text-ink-faint">
        · {status.byName}
        {status.at > 0 ? `, ${stamp(status.at)}` : ""}
      </span>
    </p>
  );
}

/** "Nadia Okafor — the assay was never blinded…", for the supersession menu. */
function candidateLabel(candidate: AnnotationView): string {
  const source =
    candidate.body.trim().length > 0 ? candidate.body : candidate.anchor.quote;
  const flattened = source.replace(/\s+/g, " ").trim();
  const preview =
    flattened.length > 60 ? `${flattened.slice(0, 60).trimEnd()}…` : flattened;
  const who = candidate.mine ? "You" : candidate.authorName;
  return preview.length > 0 ? `${who} — ${preview}` : who;
}

/**
 * The control, for the two people who may use it.
 *
 * ## Who sees it
 *
 * `canSetStatus` comes down with the margin — decided once on the server for
 * the whole paper, the way `sessions.get` hands the client `canApprove` — and
 * this reads it from the same subscription the reader is already holding.
 * Identical query arguments, so a hundred cards mounting this cost one
 * subscription and no extra round trip. The gate is convenience either way:
 * `annotations.setStatus` asks the same question again on the way in, because
 * who may speak for the lab is a rule about the data and not about which
 * buttons rendered.
 *
 * ## Why the words are a row and not a menu
 *
 * The four are a closed set and they are the point — the whole feature is that
 * a lab can say one of exactly these things — so they are laid out where they
 * can be read, in the same grammar as the type chips above them, with the one
 * in force wearing the passage wash. A `<select>` would have hidden the
 * vocabulary behind a click and made the current verdict a line of text among
 * options nobody sees.
 *
 * `Superseded` is the one that cannot be a single tap, because it is a
 * reference: choosing it opens the menu of notes on this paper that could be
 * the replacement, and nothing is written until one is picked. The candidates
 * are the lab-visible top-level notes in this same margin, which is exactly
 * what the server will accept — a menu that offered a note the mutation would
 * refuse would be a control that lies.
 */
export function StatusControl({
  annotation,
  onError,
}: {
  annotation: AnnotationView;
  /** Surfaced in the card's one alert line, so a card never grows a second. */
  onError: (message: string | null) => void;
}) {
  const margin = useQuery(api.annotations.listForPaper, {
    paperId: annotation.paperId,
  });
  const setStatus = useMutation(api.annotations.setStatus);
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [pending, setPending] = useState(false);

  const current = annotation.status?.value;

  // A reply is part of the discussion that produces a verdict, not a thing the
  // verdict goes on — the server refuses one, and the card should not offer
  // what the server refuses.
  if (
    margin?.canSetStatus !== true ||
    annotation.deleted ||
    annotation.parentId !== undefined ||
    annotation.visibility !== "lab"
  ) {
    return null;
  }

  async function apply(next: EpistemicStatus | undefined, target?: AnnotationId) {
    setPending(true);
    onError(null);
    try {
      await setStatus({
        annotationId: annotation._id,
        ...(next !== undefined ? { status: next } : {}),
        ...(target !== undefined ? { supersededBy: target } : {}),
      });
      setPicking(false);
    } catch (caught) {
      onError(readableError(caught, "That status didn't stick."));
    } finally {
      setPending(false);
    }
  }

  const candidates = (margin?.annotations ?? []).filter(
    (candidate) =>
      candidate._id !== annotation._id &&
      candidate.parentId === undefined &&
      candidate.visibility === "lab" &&
      !candidate.deleted,
  );

  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((was) => !was);
          setPicking(false);
        }}
        className="tap-target font-sans text-xs text-ink-faint underline-offset-4 hover:text-accent hover:underline"
      >
        {open ? "Done" : "Status"}
      </button>

      {/* `w-full` in the card's wrapping action row, so the panel takes the
          line under the buttons rather than sitting in among them. */}
      {open && (
        <div className="pop-in mt-1.5 w-full">
          <p className="font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint">
            Where the lab stands
          </p>

          <div
            role="group"
            aria-label="Where the lab stands on this note"
            // gap-y-2 for the reason the type chips and the marks have it: the
            // 44px hit boxes are taller than the words and would collide
            // between rows.
            className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-2"
          >
            {STATUS_MARKS.map((mark) => {
              const chosen = current === mark.value;
              return (
                <button
                  key={mark.value}
                  type="button"
                  aria-pressed={chosen}
                  disabled={pending}
                  title={mark.meaning}
                  aria-label={`${mark.word}. ${mark.meaning}.`}
                  onClick={() => {
                    // The one that is a reference rather than a verdict: it
                    // opens the menu and writes nothing until a note is named.
                    if (mark.value === "superseded") {
                      onError(null);
                      setPicking(true);
                      return;
                    }
                    setPicking(false);
                    void apply(mark.value);
                  }}
                  className={
                    "tap-target inline-flex items-center rounded-sm border px-2 py-1 font-sans " +
                    "text-[9px] uppercase tracking-[0.12em] disabled:cursor-not-allowed disabled:opacity-50 " +
                    "motion-safe:transition-[color,background-color,border-color,transform] " +
                    "motion-safe:duration-200 motion-safe:active:scale-[0.96] " +
                    (chosen
                      ? // In force: the passage wash and the accent edge, the
                        // pairing the type chips and the marks both use for
                        // the thing that is currently true.
                        "border-accent bg-highlight text-ink"
                      : "border-rule text-ink-muted hover:border-ink-faint hover:text-ink")
                  }
                >
                  {mark.word}
                </button>
              );
            })}

            {current !== undefined && (
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setPicking(false);
                  void apply(undefined);
                }}
                className="tap-target font-sans text-[9px] uppercase tracking-[0.12em] text-ink-faint underline-offset-4 hover:text-accent hover:underline disabled:opacity-50"
              >
                Clear
              </button>
            )}
          </div>

          {picking &&
            (candidates.length === 0 ? (
              <p className="mt-2 font-sans text-[11px] text-ink-faint">
                There is no other note on this paper to supersede this one with.
              </p>
            ) : (
              <select
                aria-label="Which note supersedes this one"
                disabled={pending}
                defaultValue=""
                onChange={(event) => {
                  const target = event.target.value;
                  if (target.length > 0) {
                    void apply("superseded", target as AnnotationId);
                  }
                }}
                className={`${selectClass} mt-2 text-[13px]`}
              >
                <option value="">Which note replaces this one?</option>
                {candidates.map((candidate) => (
                  <option key={candidate._id} value={candidate._id}>
                    {candidateLabel(candidate)}
                  </option>
                ))}
              </select>
            ))}

          {/* Said once, under the control, rather than in a tooltip nobody
              opens: this is the one place in the product where a person writes
              on the lab's behalf, and the sentence that says so belongs where
              the writing happens. */}
          <p className="mt-2 font-sans text-[11px] leading-relaxed text-ink-faint">
            This is the lab speaking, not a note of your own — every change is
            recorded under your name.
          </p>
        </div>
      )}
    </>
  );
}
