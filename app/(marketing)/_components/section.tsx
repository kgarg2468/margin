import type { ReactNode } from "react";

/**
 * The page is laid out like a manuscript: a narrow left margin that carries
 * the apparatus — section numbers, headings, glosses — and a reading column
 * beside it. The margin cell stretches to the full height of its row and
 * draws the rule, so the hairline runs unbroken from the masthead to the
 * footer the way a ruled sheet does.
 */

export const CONTAINER = "mx-auto w-full max-w-[76rem] px-6 sm:px-10 lg:px-12";

export const GRID = "grid lg:grid-cols-[13rem_minmax(0,1fr)]";

export const RAIL =
  "flex flex-col gap-3 pt-14 lg:h-full lg:border-r lg:border-rule lg:pr-10 lg:pt-24";

export const COLUMN = "pt-8 pb-20 lg:pt-24 lg:pb-28 lg:pl-10";

export function Section({
  id,
  index,
  title,
  gloss,
  children,
}: {
  id: string;
  index: string;
  title: string;
  gloss?: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-heading`} className="border-t border-rule">
      <div className={CONTAINER}>
        <div className={GRID}>
          <div className={RAIL}>
            {/* Sticky so the section keeps announcing itself in the margin
                while you read past it — the way a running head does. */}
            <div className="flex flex-col gap-3 lg:sticky lg:top-16">
              <p
                aria-hidden
                className="font-sans text-xs tracking-[0.22em] text-accent"
              >
                {index}
              </p>
              <h2
                id={`${id}-heading`}
                className="font-sans text-xs font-medium uppercase tracking-[0.2em] text-ink"
              >
                {title}
              </h2>
              {gloss ? (
                <p className="max-w-[24rem] font-serif text-sm italic leading-relaxed text-ink-faint">
                  {gloss}
                </p>
              ) : null}
            </div>
          </div>
          <div className={COLUMN}>{children}</div>
        </div>
      </div>
    </section>
  );
}
