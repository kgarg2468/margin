import Link from "next/link";
import { eyebrowClass } from "@/lib/ui";

/**
 * The frame both share pages sit in.
 *
 * Two jobs, and it is worth being explicit that the second one is not selling
 * anything. A reader needs to know whose margin this is, because a note is
 * only worth what its author's judgement is worth and an unattributed page of
 * commentary is worth nothing. And a reader who wants one needs a way to get
 * an account — one line, at the bottom, after the thing they came for. No
 * banner, no interstitial, no wall, and no prices: the page is the argument.
 */
export function ShareFrame({
  labName,
  children,
}: {
  labName: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-dvh bg-page text-ink">
      <header className="border-b border-rule">
        <div className="mx-auto flex max-w-6xl items-baseline justify-between gap-4 px-6 py-4">
          <p className={eyebrowClass}>Shared by {labName}</p>
          <Link
            href="/"
            className="font-serif text-sm text-ink-faint transition-colors hover:text-ink"
          >
            margin
          </Link>
        </div>
      </header>

      {children}

      <footer className="border-t border-rule">
        <div className="mx-auto max-w-6xl px-6 py-10">
          <p className="max-w-prose font-serif text-sm leading-relaxed text-ink-muted">
            This is a page from a research group&rsquo;s margin — the notes they
            wrote while reading, kept beside the paper they were reading. Labs
            use margin to read together and to keep what they work out.{" "}
            <Link
              href="/signin"
              className="text-ink underline decoration-rule underline-offset-4 transition-colors hover:decoration-ink-faint"
            >
              Start one for your group
            </Link>
            .
          </p>
        </div>
      </footer>
    </div>
  );
}

/**
 * The line that says a page is not the whole margin.
 *
 * Rendered always, and that is the design rather than laziness. Shown only
 * when something *was* withheld, its presence becomes a one-bit disclosure —
 * a reader who sees it learns that somebody in this lab declined, and a reader
 * who does not learns that everybody agreed. Rendered unconditionally it says
 * what is true of every share page under this consent model and measures
 * nothing.
 *
 * It says the view is partial without saying how partial for the same reason.
 * A count would be a measurement of what the members who declined had written,
 * and publishing the size of a thing is a way of publishing part of it.
 */
export function PartialNotice() {
  return (
    <p className="font-sans text-xs leading-relaxed text-ink-faint">
      Only the notes whose authors chose to share them appear here.
    </p>
  );
}
