const swatches = [
  { name: "page", chip: "bg-page", note: "warm sand paper" },
  { name: "surface", chip: "bg-surface", note: "cards, editor sheets" },
  { name: "surface-sunken", chip: "bg-surface-sunken", note: "wells, gutters" },
  { name: "rule", chip: "bg-rule", note: "hairlines, borders" },
  { name: "ink", chip: "bg-ink", note: "espresso body text" },
  { name: "ink-muted", chip: "bg-ink-muted", note: "metadata, captions" },
  { name: "accent", chip: "bg-accent", note: "Wedgwood — links, actions" },
  { name: "secondary", chip: "bg-secondary", note: "muted violet — synthesis" },
];

export default function Home() {
  return (
    <div className="min-h-screen bg-page px-6 py-16 sm:px-10 sm:py-24">
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-16 border-l border-rule pl-6 sm:pl-10">
        <header className="flex flex-col gap-5">
          <h1 className="font-serif text-6xl lowercase tracking-tight text-ink-strong sm:text-7xl">
            margin
          </h1>
          <p className="font-serif text-xl leading-relaxed text-ink sm:text-2xl">
            The collective intelligence layer for research groups.
          </p>
          <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
            A shared notebook for the papers your lab reads together — every{" "}
            <mark className="bg-highlight px-0.5 text-ink">
              highlight, question, and objection
            </mark>{" "}
            kept in the margins, where the next person can find it.
          </p>
        </header>

        <section className="flex flex-col gap-5">
          <h2 className="font-sans text-xs font-medium uppercase tracking-[0.18em] text-ink-faint">
            Palette
          </h2>
          <ul className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
            {swatches.map((swatch) => (
              <li key={swatch.name} className="flex items-center gap-3">
                <span
                  aria-hidden
                  className={`${swatch.chip} h-7 w-7 shrink-0 rounded-sm border border-rule`}
                />
                <span className="flex min-w-0 flex-col">
                  <span className="font-sans text-sm text-ink">
                    {swatch.name}
                  </span>
                  <span className="truncate font-sans text-xs text-ink-faint">
                    {swatch.note}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="flex flex-col gap-5">
          <h2 className="font-sans text-xs font-medium uppercase tracking-[0.18em] text-ink-faint">
            Type &amp; surfaces
          </h2>
          <div className="rounded-md border border-rule bg-surface p-6">
            <p className="font-sans text-xs uppercase tracking-[0.14em] text-ink-faint">
              Annotation
            </p>
            <p className="mt-3 font-serif text-lg leading-relaxed text-ink">
              &ldquo;The ablation in §4.2 is doing a lot of work here — does it
              hold once the retrieval corpus is deduplicated?&rdquo;
            </p>
            <p className="mt-4 font-sans text-sm text-ink-muted">
              Serif for reading and writing. Sans for chrome, labels, and
              controls.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-4">
              <span className="rounded-sm bg-accent px-3 py-1.5 font-sans text-sm text-accent-contrast">
                Primary action
              </span>
              <a
                href="#"
                className="font-sans text-sm text-accent underline-offset-4 hover:underline"
              >
                Secondary link
              </a>
              <span className="font-sans text-sm text-secondary">
                Synthesis
              </span>
            </div>
          </div>
        </section>

        <footer className="border-t border-rule pt-6 font-sans text-xs text-ink-faint">
          Light and dark follow your system appearance. Design tokens live in{" "}
          <code className="rounded-sm bg-surface-sunken px-1 py-0.5 text-ink-muted">
            app/globals.css
          </code>
          .
        </footer>
      </main>
    </div>
  );
}
