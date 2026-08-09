"use client";

import { primaryButtonClass, secondaryButtonClass } from "@/lib/ui";
import { useEffect } from "react";

/**
 * The boundary for the authenticated shell itself.
 *
 * `app/(app)/app/error.tsx` cannot catch this: Next's `error.tsx` wraps its
 * segment's page and any *nested* layouts, but not the `layout.tsx` beside it.
 * `LabProvider` lives in that layout and calls `getMyLabs`, which throws
 * "Not signed in." whenever the client holds a query result recorded without
 * an identity — so the one error most likely to reach a reader is the one the
 * inner boundary structurally cannot see. This is where it lands.
 *
 * The rail is gone by the time this renders, so it frames the whole page.
 */
export default function AuthedError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Next's own pattern. Without it the boundary is silent in production: the
  // reader sees the copy, we see nothing, and the one failure most likely to
  // land here is the one hardest to reproduce on a laptop.
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div
      role="alert"
      className="mx-auto flex min-h-screen w-full max-w-3xl flex-col items-start justify-center gap-4 bg-page px-6 py-10 sm:px-10"
    >
      <h1 className="font-serif text-3xl tracking-tight text-ink-strong">
        Margin couldn&rsquo;t open your lab.
      </h1>
      <p className="max-w-prose font-sans text-sm text-ink-muted">
        The session may have expired while this tab was open. Nothing you wrote
        has been lost — the margin only ever adds. Try again, and if that
        doesn&rsquo;t work, sign in once more.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={reset} className={primaryButtonClass}>
          Try again
        </button>
        {/*
          A plain anchor, not `<Link>`, and for exactly the reason the rail's
          sign-out is one: this has to be a document navigation.

          `reset()` re-renders the same tree against the same client, and on an
          expired session the query store still holds the recorded failure —
          `getMyLabs` rethrows it during render and lands right back here. That
          is a trap the reader cannot press their way out of. A full load throws
          the JS context away with the poisoned store in it, so the next attempt
          starts from nothing. `<Link>` would keep both and offer a way out that
          isn't one.
        */}
        <a href="/signin" className={secondaryButtonClass}>
          Sign in again
        </a>
      </div>
    </div>
  );
}
