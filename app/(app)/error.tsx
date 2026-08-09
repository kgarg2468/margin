"use client";

import { primaryButtonClass } from "@/lib/ui";

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
export default function AuthedError({ reset }: { reset: () => void }) {
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
      <button type="button" onClick={reset} className={primaryButtonClass}>
        Try again
      </button>
    </div>
  );
}
