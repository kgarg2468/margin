"use client";

import { api } from "@/convex/_generated/api";
import { eyebrowClass, selectClass, skeletonClass } from "@/lib/ui";
import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { SearchAffordance } from "./command-palette";
import type { LabSummary } from "./lab-provider";
import { useLabs } from "./lab-provider";
import { NotificationRail } from "./notifications";

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

  return (
    <aside className="flex shrink-0 flex-col gap-8 border-b border-rule bg-surface-sunken px-6 py-6 md:h-screen md:w-64 md:border-b-0 md:border-r md:py-8">
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
          <select
            aria-label="Switch lab"
            value={currentLab?._id ?? ""}
            onChange={(event) =>
              selectLab(event.target.value as LabSummary["_id"])
            }
            className={selectClass}
          >
            {labs.map((lab) => (
              <option key={lab._id} value={lab._id}>
                {lab.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* The catalogue drawer, where a catalogue drawer belongs: under the
          lab it searches and above the rooms it searches through. Only once
          there is a lab — there is nothing to look for before that. */}
      {currentLab !== null && <SearchAffordance />}

      {/* Your pigeonhole, between the drawer and the rooms: the two things
          addressed to you in particular — somebody named you, somebody
          answered you — and nothing ambient. Everything ambient is the
          digest's job, and it keeps to its boundaries. */}
      {currentLab !== null && <NotificationRail labId={currentLab._id} />}

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

      {currentLab !== null && <Collections labId={currentLab._id} />}

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

/**
 * The lab's shelves, under the rooms they are shelves in.
 *
 * A collection is not a room of its own — it is the library with a filter on,
 * so each of these is a link into `/app/library?collection=…` rather than a
 * route. They are set a size down from the sections and carry no note: a
 * section needs explaining once, a shelf explains itself by its name.
 *
 * No active mark, deliberately. Which collection is showing is a question about
 * the query string, and the shell reads the URL only on mount (see
 * `lab-provider.tsx` on why `useSearchParams` is not used here) — a mark that
 * went stale the moment you picked a second shelf would be worse than none.
 * The library's own heading takes the collection's name, which is where the
 * answer belongs.
 */
function Collections({ labId }: { labId: LabSummary["_id"] }) {
  const collections = useQuery(api.collections.listCollections, { labId });

  if (collections === undefined || collections.length === 0) {
    return null;
  }

  return (
    <nav className="flex flex-col gap-3">
      <span className={eyebrowClass}>Collections</span>
      <ul className="flex flex-col gap-0.5">
        {collections.map((collection) => (
          <li key={collection._id}>
            <Link
              href={`/app/library?collection=${collection._id}`}
              className="-mx-3 flex items-baseline justify-between gap-2 rounded-r-sm border-l-2 border-transparent px-3 py-1 transition-colors hover:border-accent hover:bg-surface/70"
            >
              <span className="truncate font-sans text-sm text-ink-muted">
                {collection.name}
              </span>
              <span className="shrink-0 font-sans text-xs tabular-nums text-ink-faint">
                {collection.paperCount}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
