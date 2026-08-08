import Link from "next/link";
import { primaryButtonClass } from "@/lib/ui";
import { AnnotatedPassage } from "./_components/annotated-passage";
import { COLUMN, CONTAINER, GRID, RAIL, Section } from "./_components/section";

const failures = [
  {
    lead: "Knowledge is siloed instead of shared.",
    body: "Every member keeps a private library. Two people in the same group read the same foundational paper in the same month, annotate it privately, and never find out that the other one had the better objection.",
  },
  {
    lead: "Annotations are written once and read never again.",
    body: "Nothing ingests what a researcher actually noted, relates it to the rest of the group’s reading, or surfaces it at the moment it becomes somebody else’s problem. The highlight is a gesture, not a record.",
  },
  {
    lead: "The knowledge leaves when the person does.",
    body: "A PhD student graduates and takes their mental model of the literature with them. Years of reading history walk out with the badge, and the group starts the next one from the beginning.",
  },
];

const layers = [
  {
    kind: "Wedge",
    name: "Journal club mode",
    body: "The ask is one session, not a migration. An organizer creates it, drops in a DOI, and invites the group — under two minutes. Members annotate before the meeting, so the shared library fills up as a by-product of prep nobody was going to skip anyway.",
    points: [
      "A live view of what the group has collectively flagged",
      "Presenter notes, open questions and method critiques kept apart",
      "A synthesis written from the session, not from memory",
    ],
  },
  {
    kind: "Core",
    name: "The annotation engine",
    body: "Every note carries a type — hypothesis, method-note, critique, definition, connection, open question — so the record is structured and machine-readable rather than a drawer of yellow rectangles. Notes thread, which means a labmate answers you on the passage itself instead of three days later in a Slack channel.",
    points: [
      "Private by default, shared on purpose",
      "Threads that live on the passage, not beside it",
      "A personal library that fills itself as you read",
    ],
  },
  {
    kind: "Compounding",
    name: "Collective intelligence",
    body: "Once a group has sessions behind it, Margin reads across them. It notices when two members converge on the same idea in different papers, points at the intersections nobody has looked at yet, and hands whoever joins next a reading list drawn from what the lab actually argued about.",
    points: [
      "Cross-member idea linking",
      "Group-aware recommendations, not personalized ones",
      "A knowledge graph you can put in front of a grant reviewer",
    ],
  },
];

const tiers = [
  {
    tier: "Tier 1",
    name: "Individual",
    price: "Free",
    unit: "",
    body: "Journal club participation, personal annotation, a personal library, and a limited slice of the recommendations.",
    marked: false,
  },
  {
    tier: "Tier 2",
    name: "Researcher Pro",
    price: "$12",
    unit: "/ mo",
    body: "Unlimited library and annotation history, full AI recommendations, a personal knowledge graph, Zotero import.",
    marked: false,
  },
  {
    tier: "Tier 3",
    name: "Lab Team",
    price: "$49",
    unit: "/ mo · up to 15",
    body: "Full journal club mode, group intelligence, cross-member linking, lab memory, the group knowledge graph, Slack.",
    marked: true,
  },
  {
    tier: "Tier 4",
    name: "Institutional",
    price: "Custom",
    unit: "/ seat",
    body: "SSO, admin dashboard, usage analytics, priority support, API access, unlimited groups. Sold to research offices.",
    marked: false,
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-page">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-sm focus:bg-accent focus:px-3 focus:py-2 focus:font-sans focus:text-sm focus:text-accent-contrast"
      >
        Skip to content
      </a>

      {/* A running head, the way a journal prints one. */}
      <header className="border-b border-rule">
        <div className={CONTAINER}>
          <div className="flex items-baseline justify-between gap-6 py-4">
            <p className="font-sans text-[0.7rem] uppercase tracking-[0.22em] text-ink-faint">
              margin
              <span aria-hidden className="mx-2 text-rule">
                /
              </span>
              <span className="hidden sm:inline">
                collective intelligence for research groups
              </span>
              <span className="sm:hidden">for research groups</span>
            </p>
            <Link
              href="/signin"
              className="tap-target shrink-0 font-sans text-sm text-accent underline-offset-4 hover:underline"
            >
              Sign in
            </Link>
          </div>
        </div>
      </header>

      <main id="main">
        {/* --- masthead ------------------------------------------------- */}
        <div className="relative overflow-hidden">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 opacity-60"
            style={{
              backgroundImage:
                "linear-gradient(to right, var(--rule) 1px, transparent 1px), linear-gradient(to bottom, var(--rule) 1px, transparent 1px)",
              backgroundSize: "34px 34px",
              maskImage:
                "linear-gradient(to bottom, rgba(0,0,0,0.85), transparent 72%)",
              WebkitMaskImage:
                "linear-gradient(to bottom, rgba(0,0,0,0.85), transparent 72%)",
            }}
          />
          <div className={`relative ${CONTAINER}`}>
            <div className={GRID}>
              <div className={RAIL}>
                {/* The name, glossed in the margin — which is where a gloss
                    belongs, and roughly the entire product thesis. */}
                <p className="font-sans text-xs uppercase tracking-[0.2em] text-ink-faint">
                  mar&middot;gin
                </p>
                <p className="font-sans text-xs text-ink-faint">
                  /&#712;m&auml;r-j&#601;n/ <i>n.</i>
                </p>
                <p className="max-w-[24rem] font-serif text-sm leading-relaxed text-ink-muted">
                  The blank beside the text, where a reader argues with it
                  &mdash; and where, until now, the argument stayed.
                </p>
              </div>

              <div className={COLUMN}>
                <h1 className="font-serif text-[clamp(4rem,15vw,9.5rem)] lowercase leading-[0.82] tracking-[-0.035em] text-ink-strong">
                  margin
                </h1>

                <p className="mt-10 max-w-[32rem] font-serif text-2xl leading-snug text-ink sm:text-[2rem] sm:leading-[1.2]">
                  The collective intelligence layer for research groups.
                </p>

                <p className="mt-7 font-serif text-xl leading-relaxed text-ink sm:text-2xl">
                  <mark
                    className="box-decoration-clone rounded-[0.15em] px-[0.15em] text-ink-strong"
                    style={{
                      backgroundColor: "var(--note-hypothesis-wash)",
                      boxShadow: "inset 0 -0.08em 0 0 var(--accent)",
                    }}
                  >
                    Run your next journal club here.
                  </mark>
                </p>

                <p className="mt-7 max-w-[34rem] font-serif text-base leading-relaxed text-ink-muted">
                  Bring one paper. Your group annotates it before the meeting,
                  the discussion lands on the passage instead of in a Slack
                  thread, and the shared library builds itself out of prep
                  everyone was doing anyway. Nothing to migrate.
                </p>

                <div className="mt-10">
                  {/* Both acquisition CTAs promise an account, so both ask for
                      the form that makes one. Landing on "Pick up where your
                      lab left off" contradicts the button that was pressed. */}
                  <Link
                    href="/signin?flow=signup"
                    className={`group tap-target ${primaryButtonClass}`}
                  >
                    Start a journal club
                    <span
                      aria-hidden
                      className="ml-2 inline-block motion-safe:transition-transform motion-safe:group-hover:translate-x-0.5"
                    >
                      &rarr;
                    </span>
                  </Link>
                </div>

                <p className="mt-10 max-w-[34rem] font-sans text-xs leading-relaxed text-ink-faint">
                  Pre-product. Closed beta opening with partner labs this fall.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* --- the artifact --------------------------------------------- */}
        <Section
          id="passage"
          index="Fig. 1"
          title="What a session leaves behind"
          gloss="Five typed notes from four people, on four sentences of one paper. Everything else in Margin is built out of this."
        >
          <AnnotatedPassage />
        </Section>

        {/* --- problem --------------------------------------------------- */}
        <Section
          id="problem"
          index="01"
          title="The problem"
          gloss="The failure is not that researchers don’t read. It is that reading doesn’t accumulate."
        >
          <p className="max-w-[38rem] font-serif text-xl leading-relaxed text-ink sm:text-2xl sm:leading-[1.5]">
            Research is a group activity performed with tools built for one
            person at a time. Labs read more than ever, and more of what they
            find falls through the gaps between them.
          </p>

          <ol className="mt-14 flex max-w-[38rem] flex-col gap-12">
            {failures.map((failure, i) => (
              <li
                key={failure.lead}
                className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-2"
              >
                <span
                  aria-hidden
                  className="font-serif text-2xl italic leading-none text-ink-faint"
                >
                  {i + 1}.
                </span>
                <p className="font-serif text-base leading-relaxed text-ink-muted sm:text-lg">
                  <strong className="font-semibold text-ink-strong">
                    {failure.lead}
                  </strong>{" "}
                  {failure.body}
                </p>
              </li>
            ))}
          </ol>

          <p className="mt-14 max-w-[38rem] border-l-2 border-accent pl-5 font-serif text-base leading-relaxed text-ink sm:text-lg">
            Journal club is the one structured moment when a lab reads together
            &mdash; and it has no tooling. A shared doc for notes, a Slack
            thread for discussion, a PDF reader each. Nothing connects them.
            Margin starts there, where the pain is weekly and the group layer is
            live from the first session.
          </p>
        </Section>

        {/* --- how it works ---------------------------------------------- */}
        <Section
          id="how"
          index="02"
          title="How it works"
          gloss="Three layers. Each one is only possible because the group already uses the one above it."
        >
          <p className="max-w-[38rem] font-serif text-xl leading-relaxed text-ink sm:text-2xl sm:leading-[1.5]">
            Margin is not three products. It is one that keeps getting deeper
            the longer a group stays in it.
          </p>

          <ol className="mt-14 max-w-[40rem] border-l border-rule">
            {layers.map((layer, i) => (
              <li
                key={layer.name}
                className="relative pb-16 pl-8 last:pb-0 sm:pl-10"
              >
                <span
                  aria-hidden
                  className="absolute -left-[6px] top-2 h-3 w-3 rounded-full border"
                  style={{
                    borderColor: i === 0 ? "var(--rule)" : "var(--accent)",
                    backgroundColor:
                      i === 2 ? "var(--accent)" : "var(--surface)",
                  }}
                />
                <p className="font-sans text-[0.65rem] uppercase tracking-[0.2em] text-ink-faint">
                  <span className="text-accent">{`0${i + 1}`}</span>
                  <span aria-hidden className="mx-2 text-rule">
                    /
                  </span>
                  {layer.kind}
                </p>
                <h3 className="mt-3 font-serif text-2xl leading-tight text-ink-strong sm:text-3xl">
                  {layer.name}
                </h3>
                <p className="mt-4 font-serif text-base leading-relaxed text-ink-muted sm:text-lg">
                  {layer.body}
                </p>
                <ul className="mt-5 flex flex-col gap-2">
                  {layer.points.map((point) => (
                    <li
                      key={point}
                      className="grid grid-cols-[1rem_minmax(0,1fr)] font-sans text-sm leading-relaxed text-ink-muted"
                    >
                      <span aria-hidden className="text-ink-faint">
                        &mdash;
                      </span>
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>

          <p className="mt-4 max-w-[40rem] font-serif text-base italic leading-relaxed text-ink sm:text-lg">
            A lab fifty sessions in has something a lab on its first session
            cannot buy.
          </p>
        </Section>

        {/* --- pricing ---------------------------------------------------- */}
        <Section
          id="pricing"
          index="03"
          title="Pricing"
          gloss="Individuals join free. Groups pay at the point where the group layer is the reason they stay."
        >
          <ul className="max-w-[44rem] border-t border-rule">
            {tiers.map((tier) => (
              <li
                key={tier.name}
                className={`grid gap-x-6 gap-y-2 border-b border-rule py-6 sm:grid-cols-[11rem_minmax(0,1fr)] ${
                  tier.marked ? "border-l-2 border-l-accent pl-4 sm:pl-5" : ""
                }`}
              >
                <div>
                  <p className="font-sans text-[0.65rem] uppercase tracking-[0.18em] text-ink-faint">
                    {tier.tier}
                  </p>
                  <p className="mt-1 font-serif text-lg text-ink-strong">
                    {tier.name}
                  </p>
                  <p className="mt-1 font-sans text-sm text-ink">
                    {tier.price}
                    {tier.unit ? (
                      <span className="text-ink-faint"> {tier.unit}</span>
                    ) : null}
                  </p>
                </div>
                <div>
                  <p className="font-serif text-base leading-relaxed text-ink-muted">
                    {tier.body}
                  </p>
                  {tier.marked ? (
                    <p className="mt-2 font-sans text-xs text-accent">
                      Where most labs land.
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>

          <p className="mt-6 max-w-[44rem] font-sans text-xs leading-relaxed text-ink-faint">
            Margin only ever works with published papers, and annotation content
            stays inside the lab that wrote it.
          </p>
        </Section>

        {/* --- call to action --------------------------------------------- */}
        <Section
          id="start"
          index="¶"
          title="Start"
          gloss="Setup is a DOI and an invite. The first session is the whole trial."
        >
          <p className="max-w-[34rem] font-serif text-3xl leading-[1.15] tracking-[-0.01em] text-ink-strong sm:text-5xl">
            Bring one paper. See what your group leaves in the margins.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-x-7 gap-y-4">
            <Link
              href="/signin?flow=signup"
              className={`group tap-target ${primaryButtonClass}`}
            >
              Create an account
              <span
                aria-hidden
                className="ml-2 inline-block motion-safe:transition-transform motion-safe:group-hover:translate-x-0.5"
              >
                &rarr;
              </span>
            </Link>
            <Link
              href="/signin"
              className="tap-target font-sans text-sm text-accent underline-offset-4 hover:underline"
            >
              Sign in
            </Link>
          </div>
        </Section>
      </main>

      <footer className="border-t border-rule">
        <div className={CONTAINER}>
          <div className="flex flex-col gap-8 py-12 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="font-serif text-3xl lowercase leading-none tracking-tight text-ink-strong">
                margin
              </p>
              <p className="mt-3 max-w-[24rem] font-serif text-sm leading-relaxed text-ink-muted">
                The collective intelligence layer for research groups.
              </p>
            </div>
            <div className="flex flex-col gap-2 font-sans text-xs text-ink-faint sm:items-end">
              <Link
                href="/signin"
                className="tap-target text-sm text-accent underline-offset-4 hover:underline"
              >
                Sign in
              </Link>
              <p>&copy; 2026 Margin &middot; Pre-product &middot; Fall 2026</p>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
