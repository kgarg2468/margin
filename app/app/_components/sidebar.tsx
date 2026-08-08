"use client";

import { api } from "@/convex/_generated/api";
import { eyebrowClass } from "@/lib/ui";
import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { LabSummary } from "./lab-provider";
import { useLabs } from "./lab-provider";

/**
 * Nav destinations that don't exist yet. They are listed rather than hidden
 * because the shape of the product should be legible from the first screen —
 * but they are inert, not links to a 404.
 */
const upcoming = [
  { label: "Library", note: "Papers the lab is reading" },
  { label: "Sessions", note: "Journal club meetings" },
];

export function Sidebar() {
  const { labs, currentLab, selectLab } = useLabs();
  const viewer = useQuery(api.users.viewer);
  const { signOut } = useAuthActions();
  const router = useRouter();

  return (
    <aside className="flex shrink-0 flex-col gap-8 border-b border-rule bg-surface-sunken px-6 py-6 md:h-screen md:w-64 md:border-b-0 md:border-r md:py-8">
      <Link
        href="/app"
        className="font-serif text-3xl lowercase tracking-tight text-ink-strong"
      >
        margin
      </Link>

      <div className="flex flex-col gap-2">
        <span className={eyebrowClass}>Lab</span>
        {labs === undefined ? (
          <span className="font-sans text-sm text-ink-faint">Loading…</span>
        ) : labs.length === 0 ? (
          <span className="font-sans text-sm text-ink-faint">No lab yet</span>
        ) : labs.length === 1 && currentLab !== null ? (
          <span className="font-serif text-lg leading-snug text-ink">
            {currentLab.name}
          </span>
        ) : (
          <select
            aria-label="Switch lab"
            value={currentLab?._id ?? ""}
            onChange={(event) =>
              selectLab(event.target.value as LabSummary["_id"])
            }
            className="w-full rounded-sm border border-rule bg-surface px-2 py-1.5 font-sans text-sm text-ink"
          >
            {labs.map((lab) => (
              <option key={lab._id} value={lab._id}>
                {lab.name}
              </option>
            ))}
          </select>
        )}
      </div>

      <nav className="flex flex-col gap-4">
        <span className={eyebrowClass}>Sections</span>
        <ul className="flex flex-col gap-3">
          {upcoming.map((item) => (
            <li key={item.label} className="flex flex-col gap-0.5">
              <span className="flex items-baseline gap-2">
                <span className="font-sans text-sm text-ink-muted">
                  {item.label}
                </span>
                <span className="font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                  Soon
                </span>
              </span>
              <span className="font-sans text-xs text-ink-faint">
                {item.note}
              </span>
            </li>
          ))}
        </ul>
      </nav>

      <div className="mt-auto flex flex-col gap-2 border-t border-rule pt-5">
        {viewer !== undefined && viewer !== null && (
          <span className="truncate font-sans text-sm text-ink-muted">
            {viewer.name ?? viewer.email}
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
