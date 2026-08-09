import { skeletonClass } from "@/lib/ui";
import Link from "next/link";

/**
 * The desk being set, one boundary earlier.
 *
 * The reader is not a page in the content column — it is `fixed inset-0` and
 * takes the viewport, clearing the sidebar on desktop. So the record's
 * `loading.tsx` one segment up is the wrong frame for this route: it would
 * paint a column-width page skeleton and then have the reader drop over the
 * top of it, which is the flash this whole task exists to remove. This
 * boundary is the nearer one, and it is the reader's shape.
 *
 * Deliberately a copy of `reader.tsx`'s own `paper === undefined` frame and of
 * `ReaderShell` around it, down to the geometry: the handoff from this file to
 * that one has to be zero-shift, and the two are the same picture. `ReaderShell`
 * is not exported, and reaching into a `"use client"` module from a route
 * boundary to borrow a wrapper would pull the whole reader — pdf.js and all —
 * into the payload for the frame that exists to be shown *before* any of that
 * arrives. Twelve lines of markup is the cheaper honesty. If the shell moves,
 * this moves with it.
 */
export default function ReadLoading() {
  return (
    <div className="fixed inset-0 z-20 flex flex-col bg-page md:left-64">
      <header className="flex shrink-0 items-center gap-5 border-b border-rule bg-surface px-4 py-2.5 sm:px-6">
        <Link
          href="/app/library"
          className="font-sans text-sm text-accent underline-offset-4 hover:underline"
        >
          ← Library
        </Link>
      </header>
      <div className="flex-1 overflow-y-auto px-6">
        <div
          role="status"
          aria-label="Opening the paper"
          className="mx-auto flex w-full max-w-3xl flex-col items-center gap-6 py-10"
        >
          <span aria-hidden className={`${skeletonClass} h-6 w-2/3 self-start`} />
          <span
            aria-hidden
            className={`${skeletonClass} aspect-[8.5/11] w-full max-w-2xl rounded-[3px] shadow-[var(--shadow-card)]`}
            style={{ animationDelay: "140ms" }}
          />
        </div>
      </div>
    </div>
  );
}
