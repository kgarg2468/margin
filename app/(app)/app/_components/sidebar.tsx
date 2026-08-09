"use client";

import { api } from "@/convex/_generated/api";
import { shortcutLabel } from "@/lib/command";
import { chipClass, eyebrowClass, skeletonClass } from "@/lib/ui";
import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useLabs } from "./lab-provider";
import { Select } from "./select";

/** The product, in two rooms: what the lab is reading, and when it meets. */
const sections = [
  { label: "Library", href: "/app/library", note: "Papers the lab is reading" },
  { label: "Sessions", href: "/app/sessions", note: "Journal club meetings" },
];

export function Sidebar() {
  const { labs, currentLab, selectLab } = useLabs();
  const viewer = useQuery(api.users.viewer);
  const { signOut } = useAuthActions();
  const router = useRouter();
  const pathname = usePathname();
  const shortcut = useShortcut();

  return (
    <aside className="flex shrink-0 flex-col gap-8 border-b border-rule bg-surface-sunken px-6 py-6 md:sticky md:top-0 md:h-screen md:w-64 md:self-start md:overflow-y-auto md:border-b-0 md:border-r md:py-8">
      <Link
        href="/app"
        className="self-start font-serif text-3xl lowercase tracking-tight text-ink-strong transition-opacity hover:opacity-75"
      >
        margin
      </Link>

      <div className="flex flex-col gap-2">
        <span className={eyebrowClass}>Lab</span>
        {labs === undefined ? (
          <span aria-hidden className={`${skeletonClass} h-6 w-32`} />
        ) : labs.length === 0 ? (
          <span className="font-sans text-sm text-ink-faint">No lab yet</span>
        ) : labs.length === 1 && currentLab !== null ? (
          <span className="font-serif text-lg leading-snug text-ink">
            {currentLab.name}
          </span>
        ) : (
          <Select
            aria-label="Switch lab"
            value={currentLab?._id ?? null}
            onValueChange={selectLab}
            options={labs.map((lab) => ({ value: lab._id, label: lab.name }))}
          />
        )}
      </div>

      <nav className="flex flex-col gap-4">
        <span className={eyebrowClass}>Sections</span>
        {/* Each room is a passage in the rail's own margin: an accent rule
            marks where you are, the way a mark anchors a note. */}
        <ul className="flex flex-col gap-1">
          {sections.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <li key={item.label}>
                <Link
                  href={item.href}
                  prefetch={true}
                  aria-current={active ? "page" : undefined}
                  className={
                    "-mx-3 flex flex-col gap-0.5 rounded-r-sm border-l-2 px-3 py-2 transition-colors " +
                    (active
                      ? "border-accent bg-surface"
                      : "border-transparent hover:bg-surface/70")
                  }
                >
                  <span
                    className={
                      "font-sans text-sm " +
                      (active ? "text-ink-strong" : "text-ink-muted")
                    }
                  >
                    {item.label}
                  </span>
                  <span className="font-sans text-xs text-ink-faint">
                    {item.note}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="mt-auto flex flex-col gap-2 border-t border-rule pt-5">
        {viewer !== undefined && viewer !== null && (
          <span className="truncate font-sans text-sm text-ink-muted">
            {viewer.name ?? viewer.email}
          </span>
        )}
        {/* The palette is invisible until it is summoned, so the rail carries
            the only thing that says it exists. It is text, not a button: the
            shortcut is the affordance, and a second control that opens the
            same sheet would teach the slower of the two ways. */}
        {shortcut !== null && (
          <span className="flex items-center gap-2 font-sans text-xs text-ink-faint">
            <kbd className={chipClass}>{shortcut}</kbd>
            Commands
          </span>
        )}
        <button
          type="button"
          className="self-start font-sans text-sm text-accent underline-offset-4 hover:underline"
          onClick={async () => {
            await signOut();
            router.push("/signin");
          }}
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}

/**
 * How the ⌘K shortcut is written on *this* machine, or `null` until it is
 * known.
 *
 * The server cannot know which modifier the reader's keyboard has, so it
 * cannot render either answer without risking a hydration mismatch — and
 * guessing the common one would leave Mac users reading "Ctrl K", trying it,
 * and getting a kill-line for their trouble. So the chip is absent for one
 * commit and then correct, rather than wrong for a frame. `shortcutLabel` is
 * the pure half, tested in `lib/command.test.ts`.
 */
function useShortcut(): string | null {
  const [shortcut, setShortcut] = useState<string | null>(null);
  useEffect(() => {
    setShortcut(shortcutLabel(navigator.platform));
  }, []);
  return shortcut;
}
