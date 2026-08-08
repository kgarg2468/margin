"use client";

import type { ReactNode } from "react";
import { createContext, useContext } from "react";
import styles from "./showcase.module.css";
import { WordReveal } from "./word-reveal";

/**
 * The centrepiece: one paragraph of one paper, as a group would leave it.
 *
 * Everything here is CSS and type — no screenshots, no video. The scroll
 * wrapper feeds in a scene number and the figure performs a session in
 * eight beats:
 *
 *   1–4  the first four notes arrive in reading order
 *   5    a selection sweeps across § 5 and a composer sheet opens on it
 *   6    the note types itself into the sheet
 *   7    the sheet files — the same words land in the margin as note 5
 *   8    the synthesis drafts itself under the passage
 *
 * The header's annotation count ticks up as notes land, because that is
 * what a live session header does. The server renders scene 8 — the
 * finished artifact — for crawlers and readers without JavaScript, and
 * reduced motion never leaves it.
 *
 * The paper and the notes are invented; the figcaption says so.
 */

export const TOTAL_SCENES = 8;

/** Which beat the performance is on. The server renders the last one. */
const Scene = createContext(TOTAL_SCENES);

const markActive = (scene: number, n: number) =>
  n <= 4 ? scene >= n : scene >= 5;
const noteActive = (scene: number, n: number) =>
  n <= 4 ? scene >= n : scene >= 7;

type NoteType =
  | "hypothesis"
  | "method"
  | "critique"
  | "connection"
  | "question";

const NOTE: Record<NoteType, { label: string; ink: string; wash: string }> = {
  hypothesis: {
    label: "hypothesis",
    ink: "var(--note-hypothesis)",
    wash: "var(--note-hypothesis-wash)",
  },
  method: {
    label: "method-note",
    ink: "var(--note-method)",
    wash: "var(--note-method-wash)",
  },
  critique: {
    label: "critique",
    ink: "var(--note-critique)",
    wash: "var(--note-critique-wash)",
  },
  connection: {
    label: "connection",
    ink: "var(--note-connection)",
    wash: "var(--note-connection-wash)",
  },
  question: {
    label: "open question",
    ink: "var(--note-question)",
    wash: "var(--note-question-wash)",
  },
};

const TYPE_ORDER: NoteType[] = [
  "hypothesis",
  "method",
  "critique",
  "connection",
  "question",
];

/**
 * A highlighter pass plus a pen underline, in the ink of its note type.
 *
 * The ink is decoration; the numeral is the actual key. It is announced as
 * "note N" here and again on the note itself, so a reader who cannot see the
 * colour still has the passage-to-margin link in the text.
 */
function Mark({
  type,
  n,
  children,
}: {
  type: NoteType;
  n: number;
  children: ReactNode;
}) {
  const note = NOTE[type];
  const active = markActive(useContext(Scene), n);
  return (
    <>
      <mark
        data-active={active}
        className={`${styles.mark} box-decoration-clone rounded-[0.15em] px-[0.12em] text-ink`}
        style={
          {
            backgroundColor: "transparent",
            backgroundImage: `linear-gradient(${note.wash}, ${note.wash})`,
            "--mark-ink": note.ink,
          } as React.CSSProperties
        }
      >
        {children}
      </mark>
      <sup
        data-active={active}
        className={`${styles.marker} ml-[0.15em] font-sans text-[0.55em] font-medium`}
        style={{ color: note.ink }}
      >
        <span className="sr-only"> (note {n})</span>
        <span aria-hidden>{n}</span>
      </sup>
    </>
  );
}

type Note = {
  n: number;
  type: NoteType;
  author: string;
  body: string;
  reply?: { author: string; body: string };
};

type Row = { locator: string; passage: ReactNode; notes: Note[] };

/** Note 5's text, shared with the composer scene that types it. */
const NOTE_FIVE_BODY =
  "What would count as direct here? Nobody in this literature has it either. Is this a limitation of the study or of the field?";

const ROWS: Row[] = [
  {
    locator: "§2.3 · Methods",
    passage: (
      <>
        Participants completed a 90-minute nap opportunity in the laboratory
        immediately after encoding.{" "}
        <Mark type="method" n={1}>
          Habitual afternoon nappers were not excluded from either cohort.
        </Mark>
      </>
    ),
    notes: [
      {
        n: 1,
        type: "method",
        author: "R. Okafor",
        body: "If the habitual nappers are carrying this, Table 2 already splits it — we should ask for the split before anyone cites the headline number.",
      },
    ],
  },
  {
    locator: "§3.1 · Results",
    passage: (
      <>
        Replay density during slow-wave sleep predicted next-day recall accuracy{" "}
        <Mark type="hypothesis" n={2}>
          (&beta; = 0.41, p = .003)
        </Mark>
        , an effect that{" "}
        <Mark type="critique" n={3}>
          held across both cohorts
        </Mark>{" "}
        after correction for total sleep time and time of day. Effect sizes
        were comparable across both age bands (Fig. 4c).
      </>
    ),
    notes: [
      {
        n: 2,
        type: "hypothesis",
        author: "D. Mensah",
        body: "If density is the mechanism and not a correlate, our ripple-band protocol should move recall the same way. Two weeks of rig time to find out.",
      },
      {
        n: 3,
        type: "critique",
        author: "P. Sundaram",
        body: "Cohort B is n = 14. “Held across both cohorts” is doing a great deal of work for a study this size.",
        reply: {
          author: "D. Mensah",
          body: "Fair — though the per-subject plot in 4c points the same way. Worth raising Thursday.",
        },
      },
    ],
  },
  {
    locator: "§4.2 · Discussion",
    passage: (
      <>
        We read this as evidence that consolidation is gated by{" "}
        <Mark type="connection" n={4}>
          the same interference dynamics reported in sparse-coding models
        </Mark>
        .
      </>
    ),
    notes: [
      {
        n: 4,
        type: "connection",
        author: "R. Okafor",
        body: "This is the account from the Lindqvist paper we ran in March. Two labs, two methods, the same claim — that is starting to look like a result.",
      },
    ],
  },
  {
    locator: "§5 · Limitations",
    passage: (
      <>
        The design provides{" "}
        <Mark type="question" n={5}>
          no direct measure of hippocampal output
        </Mark>{" "}
        during the consolidation window.
      </>
    ),
    notes: [
      {
        n: 5,
        type: "question",
        author: "A. Thiel",
        body: NOTE_FIVE_BODY,
      },
    ],
  },
];

function MarginNote({ note }: { note: Note }) {
  const meta = NOTE[note.type];
  const active = noteActive(useContext(Scene), note.n);
  return (
    <li
      data-active={active}
      className={`${styles.note} border-l-2 pl-3 md:border-l-0 md:pl-0`}
      style={{ borderColor: meta.ink }}
      aria-hidden={!active}
    >
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className="inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 font-sans text-[0.65rem] font-medium uppercase tracking-[0.12em]"
          style={{ backgroundColor: meta.wash, color: meta.ink }}
        >
          <span className="sr-only">note {note.n}, </span>
          <span aria-hidden>{note.n}</span>
          {meta.label}
        </span>
        <span className="font-sans text-[0.7rem] tracking-[0.06em] text-ink-faint">
          {note.author}
        </span>
      </p>
      <p className="mt-2 font-serif text-sm leading-relaxed text-ink">
        {note.body}
      </p>
      {note.reply ? (
        <div className="mt-3 border-l border-rule pl-3">
          <p className="font-sans text-[0.7rem] tracking-[0.06em] text-ink-faint">
            {note.reply.author} replied
          </p>
          <p className="mt-1 font-serif text-sm leading-relaxed text-ink-muted">
            {note.reply.body}
          </p>
        </div>
      ) : null}
    </li>
  );
}

/**
 * The composer sheet, performed. A facsimile of the app's real composer laid
 * over the page the way the real one is, on which note 5 gets written: it
 * opens on the § 5 selection (scene 5), the words arrive (scene 6), and it
 * files itself into the margin (scene 7). Purely decorative — the margin
 * note it becomes carries the accessible text.
 */
function ComposerScene() {
  const scene = useContext(Scene);
  const state = scene < 5 || scene >= 7 ? "hidden" : scene === 5 ? "open" : "typed";
  const meta = NOTE.question;

  return (
    <div
      aria-hidden
      data-state={state}
      className={`${styles.sheet} absolute bottom-full left-0 z-10 mb-3 hidden w-[19.5rem] -rotate-[0.6deg] rounded-md border border-rule bg-surface p-4 shadow-[0_18px_44px_-20px_rgba(42,33,29,0.55)] md:block`}
    >
      <p className="font-sans text-[0.65rem] uppercase tracking-[0.16em] text-ink-faint">
        A. Thiel &middot; annotating
      </p>
      <p className="mt-2 border-l-2 border-rule pl-2.5 font-serif text-sm italic leading-snug text-ink-muted">
        no direct measure of hippocampal output
      </p>
      <p className="mt-3 flex flex-wrap gap-1.5">
        {(["note", "hypothesis", "critique"] as const).map((label) => (
          <span
            key={label}
            className="rounded-full border border-rule px-2 py-1 font-sans text-[9px] uppercase tracking-[0.1em] text-ink-faint"
          >
            {label}
          </span>
        ))}
        <span
          className="rounded-full border border-current px-2 py-1 font-sans text-[9px] uppercase tracking-[0.1em]"
          style={{ color: meta.ink, backgroundColor: meta.wash }}
        >
          open question
        </span>
      </p>
      <p className="mt-3 min-h-[4.5rem] rounded-sm border border-rule bg-page px-2.5 py-2 font-serif text-sm leading-relaxed text-ink">
        <WordReveal text={NOTE_FIVE_BODY} active={state === "typed"} />
        <span className={styles.caret} data-state={state} />
      </p>
      <p className="mt-3 flex items-center gap-3">
        <span className="rounded-sm bg-accent px-3 py-1.5 font-sans text-sm text-accent-contrast">
          Save note
        </span>
        <span className="font-sans text-sm text-ink-faint">Cancel</span>
      </p>
    </div>
  );
}

/** The synthesis drafting itself under the session, in the second voice. */
function SynthesisScene() {
  const scene = useContext(Scene);
  const on = scene >= TOTAL_SCENES;

  const ref = (n: number, type: NoteType) => (
    <sup
      aria-hidden
      className="ml-[0.15em] font-sans text-[0.6em] font-medium"
      style={{ color: NOTE[type].ink }}
    >
      {n}
    </sup>
  );

  return (
    <div data-active={on} className={styles.grow} aria-hidden={!on}>
      <div className="overflow-hidden">
        <div className="border-t border-rule px-5 pb-5 pt-4 sm:px-8">
          <p
            className="font-sans text-[0.65rem] uppercase tracking-[0.18em]"
            style={{ color: "var(--secondary)" }}
          >
            Synthesis &middot; drafted for Thursday
          </p>
          <p className="mt-3 max-w-[44rem] font-serif text-[0.95rem] leading-[1.7] text-ink">
            <WordReveal
              text="Converging: replay density read as mechanism, pending the ripple-band replication."
              active={on}
              delay={0.1}
            />
            {ref(2, "hypothesis")}{" "}
            <WordReveal
              text="Flagged: cohort B is n = 14."
              active={on}
              delay={0.9}
            />
            {ref(3, "critique")}{" "}
            <WordReveal
              text="Open for Thursday: what would count as a direct measure."
              active={on}
              delay={1.3}
            />
            {ref(5, "question")}
          </p>
          <p className="mt-3 font-sans text-[0.7rem] text-ink-faint">
            Drafted from 14 annotations &middot; cites 2, 3, 5 &middot; every
            claim links back to a passage
          </p>
        </div>
      </div>
    </div>
  );
}

/** The card header keeps score while the session runs. */
function SessionHeader() {
  const scene = useContext(Scene);
  const landed = Math.min(scene, 4) + (scene >= 7 ? 1 : 0);
  const count = 9 + landed;
  const done = scene >= TOTAL_SCENES;

  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-rule bg-surface-sunken px-5 py-3 font-sans text-[0.7rem] tracking-[0.06em] text-ink-muted">
      <span>Reyes Lab &middot; Thursday journal club</span>
      <span className="inline-flex items-center gap-2 tabular-nums text-ink-faint">
        <span
          aria-hidden
          data-active={!done}
          className={styles.live}
          style={{ backgroundColor: done ? "var(--secondary)" : "var(--accent)" }}
        />
        Session 12 &middot; {count} annotations &middot;{" "}
        {done ? "synthesis drafted" : "3 open questions"}
      </span>
    </div>
  );
}

export function AnnotatedPassage({
  scene = TOTAL_SCENES,
}: {
  scene?: number;
}) {
  return (
    <Scene.Provider value={scene}>
      <figure className="m-0">
        <div className="overflow-hidden rounded-md border border-rule bg-surface shadow-[0_24px_60px_-44px_rgba(42,33,29,0.55)]">
          <SessionHeader />

          <div className="px-5 py-6 sm:px-8 sm:py-8">
            <h3 className="max-w-[36rem] font-serif text-lg leading-snug text-ink-strong sm:text-xl">
              Hippocampal replay density predicts overnight consolidation of
              spatial memory
            </h3>
            <p className="mt-2 font-sans text-xs text-ink-faint">
              Okonkwo, Feld, Ram&iacute;rez &amp; Chaudhry &middot; bioRxiv
              2025.04.11.648302
            </p>

            <div className="relative mt-8 flex flex-col gap-8">
              {/* The margin rule itself: one unbroken hairline down the whole
                  apparatus rather than a stub beside each row. Sits in the
                  middle of the 2rem gutter — 16rem of notes plus half of it. */}
              <span
                aria-hidden
                className="absolute inset-y-0 right-[17rem] hidden w-px bg-rule md:block"
              />
              {ROWS.map((row, i) => (
                <div
                  key={row.locator}
                  // The camera in the scroll wrapper aims at this row while
                  // the composer performs on it.
                  data-camera={i === ROWS.length - 1 ? "focus" : undefined}
                  className="relative grid gap-x-8 gap-y-4 md:grid-cols-[minmax(0,1fr)_16rem]"
                >
                  <div>
                    <p className="font-sans text-[0.65rem] uppercase tracking-[0.16em] text-ink-faint">
                      {row.locator}
                    </p>
                    <p className="mt-2 font-serif text-[1.0625rem] leading-[1.75] text-ink">
                      {row.passage}
                    </p>
                  </div>
                  <ul className="flex flex-col gap-5">
                    {row.notes.map((note) => (
                      <MarginNote key={note.n} note={note} />
                    ))}
                  </ul>
                  {/* The last row is where note 5 gets written live. */}
                  {i === ROWS.length - 1 ? <ComposerScene /> : null}
                </div>
              ))}
            </div>
          </div>

          <SynthesisScene />

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-rule bg-surface-sunken px-5 py-3">
            <span className="font-sans text-[0.65rem] uppercase tracking-[0.16em] text-ink-faint">
              Annotation types
            </span>
            {TYPE_ORDER.map((type) => (
              <span
                key={type}
                className="inline-flex items-center gap-1.5 font-sans text-[0.7rem] text-ink-muted"
              >
                <span
                  aria-hidden
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: NOTE[type].ink }}
                />
                {NOTE[type].label}
              </span>
            ))}
            {/* The ontology has a sixth type, and nothing in this excerpt is one.
                A hollow swatch and a reason keeps the legend one coherent line
                instead of trailing off into a fragment. */}
            <span className="inline-flex items-center gap-1.5 font-sans text-[0.7rem] text-ink-faint">
              <span
                aria-hidden
                className="h-2 w-2 rounded-full border border-current"
              />
              definition &mdash; none in this excerpt
            </span>
          </div>
        </div>

        <figcaption className="mt-3 font-sans text-xs leading-relaxed text-ink-faint">
          Fig. 1 &mdash; Illustrative. The paper and the notes on it are
          invented; the structure is not.
        </figcaption>
      </figure>
    </Scene.Provider>
  );
}
