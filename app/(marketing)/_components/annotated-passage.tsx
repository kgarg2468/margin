import type { ReactNode } from "react";

/**
 * The centrepiece: one paragraph of one paper, as a group would leave it.
 *
 * Everything here is CSS and type — no screenshots, no mock UI chrome. The
 * whole argument for Margin is legible in the object itself: a mark in the
 * text and a typed note in the margin are the same colour, so the passage
 * and the apparatus read as one thing. On a narrow screen the notes fall
 * inline, which is what a margin does when there is no margin.
 *
 * The paper and the notes are invented; the figcaption says so.
 */

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
  return (
    <>
      <mark
        className="box-decoration-clone rounded-[0.15em] px-[0.12em] text-ink"
        style={{
          backgroundColor: note.wash,
          boxShadow: `inset 0 -0.09em 0 0 ${note.ink}`,
        }}
      >
        {children}
      </mark>
      <sup
        className="ml-[0.15em] font-sans text-[0.55em] font-medium"
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
        body: "What would count as direct here? Nobody in this literature has it either. Is this a limitation of the study or of the field?",
      },
    ],
  },
];

function MarginNote({ note }: { note: Note }) {
  const meta = NOTE[note.type];
  return (
    <li
      className="border-l-2 pl-3 md:border-l-0 md:pl-0"
      style={{ borderColor: meta.ink }}
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

export function AnnotatedPassage() {
  return (
    <figure className="m-0">
      <div className="overflow-hidden rounded-md border border-rule bg-surface">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-rule bg-surface-sunken px-5 py-3 font-sans text-[0.7rem] tracking-[0.06em] text-ink-muted">
          <span>Reyes Lab &middot; Thursday journal club</span>
          <span className="text-ink-faint">
            Session 12 &middot; 14 annotations &middot; 3 open questions
          </span>
        </div>

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
            {ROWS.map((row) => (
              <div
                key={row.locator}
                className="grid gap-x-8 gap-y-4 md:grid-cols-[minmax(0,1fr)_16rem]"
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
              </div>
            ))}
          </div>
        </div>

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
        Fig. 1 &mdash; Illustrative. The paper and the notes on it are invented;
        the structure is not.
      </figcaption>
    </figure>
  );
}
