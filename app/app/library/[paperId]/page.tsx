"use client";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { eyebrowClass } from "@/lib/ui";
import { useQuery } from "convex/react";
import Link from "next/link";
import { use } from "react";
import { StatusChip, byline } from "../_components/paper-meta";
import { PdfPanel } from "../_components/pdf-panel";

/**
 * The locale is pinned rather than left to the browser. `undefined` means "ask
 * the runtime", and the runtimes disagree: the server renders one string, the
 * client another, and React calls that a hydration mismatch.
 */
function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function PaperPage({
  params,
}: {
  params: Promise<{ paperId: string }>;
}) {
  const { paperId } = use(params);
  const paper = useQuery(api.papers.getPaper, {
    paperId: paperId as Id<"papers">,
  });

  if (paper === undefined) {
    return <p className="font-sans text-sm text-ink-faint">Loading…</p>;
  }

  if (paper === null) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
          That paper isn&rsquo;t in a library you can see. It may have been
          removed, or it may belong to another lab.
        </p>
      </div>
    );
  }

  const line = byline(paper);

  return (
    <div className="flex flex-col gap-10">
      <BackLink />

      <header className="flex flex-col gap-4 border-l border-rule pl-6">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
          <h1 className="font-serif text-3xl leading-tight tracking-tight text-ink-strong">
            {paper.title}
          </h1>
          <StatusChip status={paper.ingestStatus} />
        </div>

        {line.length > 0 && (
          <p className="font-sans text-sm text-ink-muted">{line}</p>
        )}

        <p className="flex flex-wrap items-baseline gap-x-5 gap-y-1 font-sans text-xs text-ink-faint">
          {paper.doi !== undefined && (
            <a
              href={`https://doi.org/${paper.doi}`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-accent underline-offset-4 hover:underline"
            >
              {paper.doi}
            </a>
          )}
          {paper.sourceUrl !== undefined && (
            <a
              href={paper.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="text-accent underline-offset-4 hover:underline"
            >
              Publisher page
            </a>
          )}
          <span>
            Added {formatDate(paper.addedAt)}
            {paper.addedByName !== undefined ? ` by ${paper.addedByName}` : ""}
          </span>
        </p>
      </header>

      {paper.abstract !== undefined && (
        <section className="flex flex-col gap-3">
          <h2 className={eyebrowClass}>Abstract</h2>
          <p className="max-w-prose font-serif text-base leading-relaxed text-ink">
            {paper.abstract}
          </p>
        </section>
      )}

      <PdfPanel
        paperId={paper._id}
        labId={paper.labId}
        hasPdf={paper.hasPdf}
        hasText={paper.hasText}
        pageCount={paper.pageCount}
        ingestStatus={paper.ingestStatus}
        ingestError={paper.ingestError}
      />

      <ReaderPlaceholder ready={paper.hasPdf && paper.hasText} />
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/app/library"
      className="self-start font-sans text-sm text-accent underline-offset-4 hover:underline"
    >
      ← Library
    </Link>
  );
}

/**
 * Where the reader goes. It is drawn as an empty page with a margin rule
 * rather than a grey box, because that is the shape of the thing that lands
 * here next — the text on the left, the lab's annotations down the right.
 */
function ReaderPlaceholder({ ready }: { ready: boolean }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className={eyebrowClass}>Reading</h2>
      <div className="flex min-h-56 flex-col justify-center gap-3 rounded-md border border-rule bg-surface p-8 md:pr-40">
        <p className="max-w-prose font-serif text-lg leading-relaxed text-ink-muted">
          The reader lands here: the paper on the left, the lab&rsquo;s
          annotations in the margin beside it, typed with a tap and threaded
          where people answer each other.
        </p>
        <p className="font-sans text-sm text-ink-faint">
          {ready
            ? "This paper is ready for it — text extracted, anchors resolvable."
            : "It needs the PDF and its text layer first."}
        </p>
      </div>
    </section>
  );
}
