"use client";

import { api } from "@/convex/_generated/api";
import { eyebrowClass, secondaryButtonClass } from "@/lib/ui";
import { useQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";
import type { LabSummary } from "../_components/lab-provider";
import { useLabs } from "../_components/lab-provider";
import { ListSkeleton, PageSkeleton } from "../_components/skeletons";
import { AddPaper } from "./_components/add-paper";
import { StatusChip, byline } from "./_components/paper-meta";

export default function LibraryPage() {
  const { labs, currentLab } = useLabs();

  if (labs === undefined) {
    return <PageSkeleton />;
  }

  if (currentLab === null) {
    return (
      <div className="flex flex-col gap-3 border-l border-rule pl-6">
        <h1 className="font-serif text-4xl tracking-tight text-ink-strong">
          Library
        </h1>
        <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
          A library belongs to a lab, and you aren&rsquo;t in one yet.
        </p>
        <Link
          href="/app"
          className="font-sans text-sm text-accent underline-offset-4 hover:underline"
        >
          Start or join a lab
        </Link>
      </div>
    );
  }

  return <Library lab={currentLab} />;
}

function Library({ lab }: { lab: LabSummary }) {
  const papers = useQuery(api.papers.listPapers, { labId: lab._id });
  const [adding, setAdding] = useState(false);

  const isEmpty = papers !== undefined && papers.length === 0;

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-3 border-l border-rule pl-6">
        <h1 className="font-serif text-4xl tracking-tight text-ink-strong">
          Library
        </h1>
        <p className="font-sans text-sm text-ink-muted">
          What {lab.name} is reading
          {papers !== undefined && papers.length > 0
            ? ` · ${papers.length} ${papers.length === 1 ? "paper" : "papers"}`
            : ""}
        </p>
      </header>

      {/* An empty library has nothing to hide the form behind.
          `onAdded` pins the panel open the moment a lookup succeeds: without
          it the first paper closed the form by arriving, because `isEmpty`
          stopped being true and `adding` had never been set — taking the
          outcome of the lookup off the screen at the one moment it was worth
          reading. Closing it is now something the reader does. */}
      {isEmpty || adding ? (
        <div className="flex flex-col gap-3">
          <AddPaper labId={lab._id} onAdded={() => setAdding(true)} />
          {!isEmpty && (
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="tap-target self-start font-sans text-sm text-accent underline-offset-4 hover:underline"
            >
              Done adding
            </button>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className={`${secondaryButtonClass} tap-target self-start`}
        >
          Add a paper
        </button>
      )}

      <section className="flex flex-col gap-5">
        <h2 className={eyebrowClass}>Papers</h2>

        {papers === undefined ? (
          <ListSkeleton />
        ) : papers.length === 0 ? (
          <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
            Nothing on the shelf yet. A library starts with one paper: paste a
            DOI and Margin fetches the record, drop in a PDF, or import a
            reference-manager export in bulk.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-rule border-y border-rule">
            {papers.map((paper) => {
              const line = byline(paper);
              // A ready paper is one whose text layer is in, which is the only
              // state the margins can be written in — so the title opens the
              // reader and the record moves to a second link. Anything else has
              // something to fix first, and the record is where you fix it.
              const readable = paper.ingestStatus === "ready" && paper.hasPdf;
              return (
                <li key={paper._id} className="flex flex-col gap-1 py-4">
                  <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <Link
                      href={
                        readable
                          ? `/app/library/${paper._id}/read`
                          : `/app/library/${paper._id}`
                      }
                      className="font-serif text-xl leading-snug text-ink-strong underline-offset-4 hover:underline"
                    >
                      {paper.title}
                    </Link>
                    <StatusChip status={paper.ingestStatus} />
                  </span>
                  {line.length > 0 && (
                    <span className="font-sans text-sm text-ink-muted">
                      {line}
                    </span>
                  )}
                  {/* A paper that can't be read yet has exactly one thing
                      worth doing to it, and "TEXT PENDING" next to a title
                      does not say what that is or where. One named action,
                      in the accent, rather than a chip to decode. */}
                  <Link
                    href={`/app/library/${paper._id}`}
                    className={
                      readable
                        ? "tap-target self-start font-sans text-xs text-ink-faint underline-offset-4 hover:text-accent hover:underline"
                        : "tap-target self-start font-sans text-sm text-accent underline-offset-4 hover:underline"
                    }
                  >
                    {readable ? "Record" : "Finish preparing this paper →"}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
