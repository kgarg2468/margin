"use client";

import { readableError } from "@/app/(app)/app/_components/errors";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { extractPdf } from "@/lib/pdf/extract";
import { useConvex, useMutation } from "convex/react";
import { useCallback, useRef, useState } from "react";

/**
 * Read the text layer out of a PDF that Margin already has.
 *
 * pdf.js only runs in a browser, so a file Margin fetched for itself — every
 * open-access copy found by DOI — arrives with no text layer and no way to
 * make one until somebody opens the app. This is that step, in the two places
 * it can happen: straight after a DOI lookup, while the reader is still
 * standing there, and on the paper record for a paper that got past the first.
 *
 * The URL is fetched imperatively rather than through `useQuery` because this
 * runs in response to an event, and the paper it runs for is not known until
 * that event happens.
 */
export type TextLayerPhase =
  | { kind: "idle" }
  | { kind: "working"; message: string }
  | { kind: "done" }
  | { kind: "failed"; message: string };

export function useTextLayer() {
  const convex = useConvex();
  const saveExtractedText = useMutation(api.papers.saveExtractedText);
  const markIngestFailed = useMutation(api.papers.markIngestFailed);
  const [phase, setPhase] = useState<TextLayerPhase>({ kind: "idle" });
  // Extraction is idempotent but not cheap — eighteen pages of pdf.js — and
  // the callers below are reactive, so they will ask more than once for the
  // same paper. One attempt each.
  const attempted = useRef<Set<string>>(new Set());

  const read = useCallback(
    /** `force` is somebody pressing the button again; the guard is for the
     *  callers that ask automatically. */
    async (paperId: Id<"papers">, force = false): Promise<boolean> => {
      if (!force && attempted.current.has(paperId)) {
        return false;
      }
      attempted.current.add(paperId);

      try {
        setPhase({ kind: "working", message: "Fetching the PDF…" });
        const url = await convex.query(api.papers.getPdfUrl, { paperId });
        if (url === null || url === undefined) {
          throw new Error("The stored file has gone missing.");
        }
        const response = await fetch(url);
        if (!response.ok) {
          // Without this, a 404 body goes to pdf.js and comes back as
          // "couldn't read that PDF" — which blames the file for the fetch.
          throw new Error(`The stored file came back ${response.status}.`);
        }
        const data = await response.arrayBuffer();
        const extraction = await extractPdf(data, {
          onProgress: (pagesDone, pages) =>
            setPhase({
              kind: "working",
              message: `Reading page ${pagesDone} of ${pages}…`,
            }),
        });
        await saveExtractedText({ paperId, pages: extraction.pages });
        setPhase({ kind: "done" });
        return true;
      } catch (caught) {
        const message = readableError(caught, "That PDF wouldn't open.");
        setPhase({ kind: "failed", message });
        try {
          // Otherwise it sits at "text pending" forever, indistinguishable
          // from a paper nobody has opened yet.
          await markIngestFailed({ paperId, message });
        } catch {
          // Best effort. The member has already been told what went wrong; a
          // failed note about it is not a second thing to say.
        }
        return false;
      }
    },
    [convex, saveExtractedText, markIngestFailed],
  );

  return { phase, read };
}
