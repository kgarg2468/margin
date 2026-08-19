import Link from "next/link";
import { primaryButtonClass } from "@/lib/ui";
import { HeroSurface, PageSurface } from "./_components/hero-surface";
import { Magnetic } from "./_components/magnetic";
import { SweepMark } from "./_components/marks";
import { ReadingProgress } from "./_components/progress";
import { Reveal, Rise } from "./_components/reveal";
import { ScanFieldMount } from "./_components/scan-field-mount";
import { ShowcaseFig1 } from "./_components/showcase";
import { COLUMN, CONTAINER, GRID, RAIL, Section } from "./_components/section";
import { TimelineDraw } from "./_components/timeline";

/**
 * The landing page is a manuscript, and it is deliberately almost silent:
 * the hero speaks, the section heads speak briefly, and everything else is
 * shown rather than said. Fig. 1 does the arguing — the annotated passage
 * performs a whole session as the reader scrolls, which is the product doing
 * the one thing it is for. Around that, the page behaves like a sheet on a
 * desk: the ruling lights under the cursor, a pen line follows the hand
 * across the masthead, and anything marked gets marked while you watch.
 */

const failures = [
  { ink: "critique", lead: "Every member keeps a private library." },
  { ink: "method", lead: "Notes are written once and read never." },
  { ink: "question", lead: "The knowledge leaves when the person does." },
] as const;

const layers = [
  {
    kind: "Wedge",
    name: "Journal club mode",
    line: "A DOI, an invite, and everyone annotates before Thursday.",
  },
  {
    kind: "Core",
    name: "The annotation engine",
    line: "Typed notes, threaded replies, anchored to the passage itself.",
  },
  {
    kind: "Compounding",
    name: "Collective intelligence",
    line: "Margin reads across sessions and points at what converges.",
  },
];

function StartCta() {
  return (
    <Magnetic>
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
    </Magnetic>
  );
}

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-page">
      <ReadingProgress />
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
        <HeroSurface>
          {/* The ground the sheet is lying on, seen through it. It sits over
              the flat ruling and under every word — the masthead's content is
              positioned and comes later in source order, so type always wins
              — and being out of flow it cannot move a line either way. */}
          <ScanFieldMount />
          <div className={`relative ${CONTAINER}`}>
            <div className={GRID}>
              <div className={RAIL}>
                {/* The name, glossed in the margin — which is where a gloss
                    belongs, and roughly the entire product thesis. */}
                <Rise delay={0.35}>
                  <p className="font-sans text-xs uppercase tracking-[0.2em] text-ink-faint">
                    mar&middot;gin
                  </p>
                  <p className="mt-2 font-sans text-xs text-ink-faint">
                    /&#712;m&auml;r-j&#601;n/ <i>n.</i>
                  </p>
                  <p className="mt-3 max-w-[24rem] font-serif text-sm leading-relaxed text-ink-muted">
                    The blank beside the text, where a reader argues with it.
                    The argument used to stay there.
                  </p>
                </Rise>
              </div>

              <div className={COLUMN}>
                <Rise>
                  <h1 className="font-serif text-[clamp(4rem,15vw,9.5rem)] lowercase leading-[0.82] tracking-[-0.035em] text-ink-strong">
                    margin
                  </h1>
                </Rise>

                <Rise delay={0.12}>
                  <p className="mt-10 max-w-[32rem] font-serif text-2xl leading-snug text-ink sm:text-[2rem] sm:leading-[1.2]">
                    The collective intelligence layer for research groups.
                  </p>
                </Rise>

                <Rise delay={0.22} className="relative">
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
                    <sup
                      aria-hidden
                      className="ml-[0.2em] font-sans text-[0.55em] font-medium text-accent"
                    >
                      1
                    </sup>
                  </p>

                  {/* The page annotating its own thesis — the product's whole
                      grammar, demonstrated in the empty right margin. */}
                  <Rise delay={1.15} className="absolute left-[calc(100%-11rem)] top-16 hidden w-52 xl:block">
                    <div
                      aria-hidden
                      className="rotate-[0.8deg] rounded-md border border-rule bg-surface p-3 shadow-[0_14px_36px_-20px_rgba(42,33,29,0.5)]"
                    >
                      <p className="flex items-center gap-1.5 font-sans text-[0.6rem] font-medium uppercase tracking-[0.12em]">
                        <span
                          className="rounded-sm px-1.5 py-0.5"
                          style={{
                            backgroundColor: "var(--note-hypothesis-wash)",
                            color: "var(--note-hypothesis)",
                          }}
                        >
                          1 hypothesis
                        </span>
                      </p>
                      <p className="mt-2 font-serif text-[0.8rem] leading-relaxed text-ink">
                        The argument doesn&rsquo;t have to stay in the margin
                        any more.
                      </p>
                    </div>
                  </Rise>
                </Rise>

                <Rise delay={0.32}>
                  <div className="mt-10">
                    <StartCta />
                  </div>
                  <p className="mt-8 font-sans text-xs leading-relaxed text-ink-faint">
                    Closed beta with partner labs, fall 2026.
                  </p>
                </Rise>
              </div>
            </div>
          </div>
        </HeroSurface>

        <PageSurface>
          {/* --- the artifact ------------------------------------------- */}
          <Section
            id="passage"
            index="Fig. 1"
            title="What a session leaves behind"
            gloss="Five typed notes from four people, on one paper. Keep scrolling; the session writes itself."
          >
            <ShowcaseFig1 />
          </Section>

          {/* --- problem ------------------------------------------------- */}
          <Section
            id="problem"
            index="§ 1"
            title="The problem"
            gloss="Labs read more than ever. The reading doesn't accumulate."
          >
            <ul className="flex max-w-[38rem] flex-col gap-10">
              {failures.map((failure, i) => (
                <li key={failure.lead}>
                  <Reveal delay={i * 0.08}>
                    <p className="grid grid-cols-[2.5rem_minmax(0,1fr)] items-baseline gap-x-2">
                      <span
                        aria-hidden
                        className="font-serif text-2xl italic leading-none text-ink-faint"
                      >
                        {i + 1}.
                      </span>
                      <span className="font-serif text-xl leading-snug text-ink sm:text-[1.6rem] sm:leading-[1.35]">
                        <SweepMark ink={failure.ink} delay={0.25 + i * 0.35}>
                          {failure.lead}
                        </SweepMark>
                      </span>
                    </p>
                  </Reveal>
                </li>
              ))}
            </ul>
          </Section>

          {/* --- how it works -------------------------------------------- */}
          <Section
            id="how"
            index="§ 2"
            title="How it works"
            gloss="Three layers. Each one is only possible because the group already uses the one above it."
          >
            <TimelineDraw>
              <ol className="max-w-[40rem]">
                {layers.map((layer, i) => (
                  <li
                    key={layer.name}
                    className="relative pb-14 pl-8 last:pb-0 sm:pl-10"
                  >
                    <Reveal delay={i * 0.08}>
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
                      <p className="mt-3 font-serif text-base leading-relaxed text-ink-muted sm:text-lg">
                        {layer.line}
                      </p>
                    </Reveal>
                  </li>
                ))}
              </ol>
            </TimelineDraw>

            <Reveal>
              <p className="mt-14 max-w-[40rem] font-serif text-base italic leading-relaxed text-ink sm:text-lg">
                A lab fifty sessions in has something a lab on its first
                session cannot buy.
              </p>
            </Reveal>
          </Section>

          {/* --- call to action ------------------------------------------- */}
          <Section
            id="start"
            index="¶"
            title="Start"
            gloss="Setup is a DOI and an invite. The first session makes the case."
          >
            <Reveal>
              <p className="max-w-[34rem] font-serif text-3xl leading-[1.15] tracking-[-0.01em] text-ink-strong sm:text-5xl">
                Bring one paper. See what your group leaves{" "}
                <SweepMark ink="hypothesis" underline="var(--accent)" delay={0.3}>
                  in the margins.
                </SweepMark>
              </p>
              <div className="mt-10">
                <StartCta />
              </div>
              <p className="mt-8 font-sans text-xs leading-relaxed text-ink-faint">
                Annotations stay inside the lab that wrote them.
              </p>
            </Reveal>
          </Section>
        </PageSurface>
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
