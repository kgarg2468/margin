"use client";

import { primaryButtonClass } from "@/lib/ui";
import { useEffect } from "react";

/**
 * The app shell's last line of defence.
 *
 * Convex queries are live subscriptions, and a failing one throws during
 * render — an expired session, a lab you were removed from, a backend that is
 * briefly unreachable. Without this the whole screen goes to Next's bare
 * fallback with no way back. The boundary sits at `/app` so the rail and the
 * route both remount cleanly on `reset()`, which re-runs the query that threw:
 * for anything transient, pressing the button is the whole fix.
 *
 * The copy says what is known and nothing more. Guessing at a cause ("check
 * your connection") is worse than admitting there isn't one, because the
 * reader can tell when they are being told something generic.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Next's own pattern. The `error` prop was being discarded, which meant a
  // boundary that told the reader something had gone wrong and told us nothing
  // — every production occurrence invisible.
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div
      role="alert"
      className="mx-auto flex w-full max-w-3xl flex-col items-start gap-4 px-6 py-10 sm:px-10 md:py-12"
    >
      <h1 className="font-serif text-3xl tracking-tight text-ink-strong">
        This screen didn&rsquo;t load.
      </h1>
      <p className="max-w-prose font-sans text-sm text-ink-muted">
        Something went wrong fetching your lab&rsquo;s data. Nothing you wrote
        has been lost — the margin only ever adds. Try again, and if it keeps
        happening, signing out and back in will get you a fresh session.
      </p>
      <button type="button" onClick={reset} className={primaryButtonClass}>
        Try again
      </button>
    </div>
  );
}
