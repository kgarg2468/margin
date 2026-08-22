"use client";

import type { PDFDocumentLoadingTask } from "pdfjs-dist/types/src/display/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { typeStyle } from "@/app/(app)/app/library/[paperId]/read/_components/ontology";
import { loadPdfjs } from "@/lib/pdf/extract";
import { sharedPdfEndpoint } from "@/lib/pdf/delivery";
import { eyebrowClass, skeletonClass } from "@/lib/ui";
import { PartialNotice, ShareFrame } from "./chrome";
import type { SharedNote, SharedPaperView } from "./types";

/**
 * A paper and its margin, for somebody who has no account and will not be
 * asked to make one.
 *
 * Deliberately *not* the reader from `(app)`. That surface is 1500 lines of
 * selection handling, composers, anchor resolution and live mutations, all of
 * it built on a signed-in member with a lab — and every one of those is a way
 * for an authed capability to end up on a public page. This renders pages and
 * draws cards beside them. There is nothing here to write with, so there is
 * nothing here to get wrong.
 *
 * The one real loss is the passage highlight: a note names its quote rather
 * than being drawn on top of it, because tying a card to a rectangle on the
 * page needs the text layer and the anchor-resolution machinery that comes
 * with it. Every card carries the quote it was written against and the page
 * it sits on, which is enough to read the conversation and follow it back into
 * the paper.
 */
export function SharedPaper({
  token,
  shared,
}: {
  token: string;
  shared: SharedPaperView;
}) {
  const pagesRef = useRef<HTMLDivElement>(null);

  const jumpToPage = useCallback((pageIndex: number) => {
    const page = pagesRef.current?.querySelector(
      `[data-page-index="${pageIndex}"]`,
    );
    page?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <ShareFrame labName={shared.labName}>
      <main className="mx-auto max-w-6xl px-6 py-10">
        <header className="mb-8">
          <h1 className="max-w-prose font-serif text-2xl leading-tight text-ink-strong">
            {shared.title}
          </h1>
          <Citation shared={shared} />
        </header>

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div ref={pagesRef} className="min-w-0">
            {shared.pdf === "included" ? (
              <PdfPages token={token} />
            ) : shared.pdf === "withheld" ? (
              // A choice, not a withdrawal, and worded so it cannot be read as
              // one: nothing here was taken back or stopped being shared. The
              // reason goes unstated because it is the sharer's, and the
              // likeliest one — they have no right to redistribute a
              // publisher's file — is nobody else's business.
              <p className="font-serif text-sm text-ink-muted">
                Whoever shared this link included the margin but not the paper
                itself. The notes are written against the passages they quote.
              </p>
            ) : (
              <p className="font-serif text-sm text-ink-muted">
                The paper itself isn&rsquo;t attached to this link — the notes
                below are the conversation the lab had about it.
              </p>
            )}
          </div>

          <aside className="flex flex-col gap-4 lg:sticky lg:top-6 lg:max-h-[calc(100dvh-3rem)] lg:overflow-y-auto">
            <div className="flex flex-col gap-2">
              <p className={eyebrowClass}>In the margin</p>
              <PartialNotice />
            </div>
            {shared.notes.length === 0 ? (
              <p className="font-serif text-sm leading-relaxed text-ink-muted">
                Nothing from this paper&rsquo;s margin is shared publicly.
              </p>
            ) : (
              shared.notes.map((note) => (
                <NoteCard key={note._id} note={note} onJump={jumpToPage} />
              ))
            )}
          </aside>
        </div>
      </main>
    </ShareFrame>
  );
}

function Citation({ shared }: { shared: SharedPaperView }) {
  const parts = [
    shared.authors?.join(", "),
    shared.venue,
    shared.year === undefined ? undefined : String(shared.year),
  ].filter((part): part is string => part !== undefined && part.length > 0);

  if (parts.length === 0 && shared.doi === undefined) return null;

  return (
    <p className="mt-2 max-w-prose font-serif text-sm text-ink-muted">
      {parts.join(" · ")}
      {shared.doi === undefined ? null : (
        <>
          {parts.length > 0 ? " · " : null}
          <a
            href={`https://doi.org/${shared.doi}`}
            className="underline decoration-rule underline-offset-4 transition-colors hover:decoration-ink-faint"
            // A DOI leaves for a publisher's site. `noreferrer` so the share
            // URL — which is the credential — is never handed to them in a
            // `Referer` header.
            rel="noreferrer nofollow"
            target="_blank"
          >
            {shared.doi}
          </a>
        </>
      )}
    </p>
  );
}

/** One card, drawn in its type's ink, with whatever consent left of it. */
function NoteCard({
  note,
  onJump,
}: {
  note: SharedNote;
  onJump: (pageIndex: number) => void;
}) {
  const style = typeStyle(note.type);

  if (note.redacted) {
    // The one place a placeholder is right: this note is gone but a reply
    // under it is somebody's writing and still shared. Everywhere else a note
    // that fails the gates is simply absent, because a column of "withheld"
    // markers would publish the shape of what the lab chose not to publish.
    return (
      <article className="rounded-sm border border-dashed border-rule px-3.5 py-3">
        <p className="font-serif text-sm italic leading-relaxed text-ink-faint">
          {note.body}
        </p>
        <Replies replies={note.replies} />
      </article>
    );
  }

  return (
    <article
      className="rounded-sm border border-rule bg-surface px-3.5 py-3 shadow-card"
      style={{ borderLeftWidth: 2, borderLeftColor: style.ink }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-sans text-xs text-ink-muted">{note.authorName}</p>
        <button
          type="button"
          onClick={() => onJump(note.pageIndex)}
          className="font-sans text-xs text-ink-faint transition-colors hover:text-ink"
        >
          p. {note.pageIndex + 1}
        </button>
      </div>

      {note.quote.length === 0 ? null : (
        <blockquote className="mt-2 border-l-2 border-rule pl-2.5 font-serif text-xs leading-relaxed text-ink-muted">
          {note.quote}
        </blockquote>
      )}

      <p className="mt-2 font-serif text-sm leading-relaxed text-ink">
        {note.body}
      </p>

      <p className="mt-2 font-sans text-[0.65rem] uppercase tracking-[0.14em]" style={{ color: style.ink }}>
        {style.label}
        {note.status === undefined ? null : ` · ${note.status}`}
      </p>

      <Replies replies={note.replies} />
    </article>
  );
}

function Replies({ replies }: { replies: SharedNote["replies"] }) {
  if (replies.length === 0) return null;
  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-rule pt-2">
      {replies.map((reply) => (
        <div key={reply._id}>
          <p className="font-sans text-xs text-ink-muted">{reply.authorName}</p>
          <p className="mt-0.5 font-serif text-sm leading-relaxed text-ink">
            {reply.body}
          </p>
        </div>
      ))}
    </div>
  );
}

/**
 * The pages, rendered once into canvases.
 *
 * Everything the authed reader needs a live document for — zoom, selection,
 * the text layer — is absent here, so the document is loaded, drawn, and
 * released. The bytes come from `/shared-pdf?token=`, which re-checks the
 * share on every request; a link revoked while somebody is reading fails the
 * next fetch rather than the current pixels, and the page itself deads on the
 * next load.
 */
function PdfPages({ token }: { token: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">(
    "loading",
  );

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    let cancelled = false;
    // The loading task, not the document, is what owns the worker — tearing it
    // down is how an abandoned navigation stops fetching a paper nobody is
    // looking at any more.
    let task: PDFDocumentLoadingTask | undefined;
    void (async () => {
      try {
        const pdfjs = await loadPdfjs();
        task = pdfjs.getDocument({ url: sharedPdfEndpoint(token) });
        const doc = await task.promise;
        if (cancelled) return;

        // The canvases go in one at a time, so a long paper starts reading
        // before it has finished drawing.
        for (let number = 1; number <= doc.numPages; number++) {
          const page = await doc.getPage(number);
          if (cancelled) break;

          const width = host.clientWidth || 720;
          const unscaled = page.getViewport({ scale: 1 });
          const scale = width / unscaled.width;
          const viewport = page.getViewport({ scale });
          const ratio = Math.min(window.devicePixelRatio || 1, 2);

          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width * ratio);
          canvas.height = Math.floor(viewport.height * ratio);
          canvas.style.width = "100%";
          canvas.style.height = "auto";
          canvas.className =
            "mb-4 block rounded-sm border border-rule bg-surface shadow-card";
          canvas.setAttribute("data-page-index", String(number - 1));

          const context = canvas.getContext("2d");
          if (context === null) continue;
          context.scale(ratio, ratio);
          host.append(canvas);
          await page.render({ canvas, canvasContext: context, viewport })
            .promise;
          if (number === 1) setStatus("ready");
        }
        if (!cancelled) setStatus("ready");
      } catch {
        // One outcome for every way this can fail — a revoked link, a paper
        // with no file, a PDF that will not parse. The page still has the
        // margin on it, which is the half a reader cannot get anywhere else.
        if (!cancelled) setStatus("failed");
      }
    })();

    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [token]);

  return (
    <>
      <div ref={hostRef} />
      {status === "loading" ? (
        <div className={`${skeletonClass} h-[60dvh] w-full`} />
      ) : null}
      {status === "failed" ? (
        <p className="font-serif text-sm text-ink-muted">
          The paper couldn&rsquo;t be loaded. The notes beside it are the
          lab&rsquo;s reading of it.
        </p>
      ) : null}
    </>
  );
}
