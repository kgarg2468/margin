"use client";

import { recoverSession } from "@/lib/auth/session-recovery";
import { primaryButtonClass, secondaryButtonClass } from "@/lib/ui";
import { useAuthActions } from "@convex-dev/auth/react";
import { useEffect, useState } from "react";

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
  // This boundary renders inside `ConvexAuthNextjsProvider`, so the sign-out
  // the rail offers is available here too — and here it matters more, because
  // this is the page a reader reaches when the session is the thing that broke.
  const { signOut } = useAuthActions();
  const [recovering, setRecovering] = useState(false);

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
          Sign out first, then a document navigation — not `<Link>`, and for
          exactly the reason the rail's sign-out is one.

          `reset()` re-renders the same tree against the same client, and on an
          expired session the query store still holds the recorded failure —
          `getMyLabs` rethrows it during render and lands right back here. That
          is a trap the reader cannot press their way out of. A full load throws
          the JS context away with the poisoned store in it, so the next attempt
          starts from nothing. `<Link>` would keep both and offer a way out that
          isn't one.

          The plain `<a>` this used to be was half the fix: it destroyed the
          store but left the stale tokens in place, so `/signin` opened already
          "authenticated" against a session the backend had stopped trusting
          and the reader was pushed straight back into the same failure.
          `signOut()` clears those tokens, and `recoverSession` holds the two
          in order.
        */}
        <button
          type="button"
          disabled={recovering}
          onClick={() => {
            setRecovering(true);
            void recoverSession({
              signOut,
              navigate: (destination) => window.location.assign(destination),
            });
          }}
          className={secondaryButtonClass}
        >
          {recovering ? "Signing out…" : "Sign in again"}
        </button>
      </div>
    </div>
  );
}
