"use client";

import { readableError } from "@/app/(app)/app/_components/errors";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PdfAuthError, fetchPdfBytes } from "@/lib/pdf/delivery";
import { describePdfOpenError, extractPdf } from "@/lib/pdf/extract";
import { useAuthToken } from "@convex-dev/auth/react";
import { useMutation } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Read the text layer out of a PDF that Margin already has.
 *
 * pdf.js only runs in a browser, so a file Margin fetched for itself — every
 * open-access copy found by DOI — arrives with no text layer and no way to
 * make one until somebody opens the app. This is that step, in the two places
 * it can happen: straight after a DOI lookup, while the reader is still
 * standing there, and on the paper record for a paper that got past the first.
 *
 * The bytes are pulled down imperatively rather than through `useQuery`
 * because this runs in response to an event, and the paper it runs for is not
 * known until that event happens. They come from the membership-checked
 * endpoint in `convex/http.ts` — the same one the reader renders from — so
 * this hook needs the member's auth token to ask for them.
 */
export type TextLayerPhase =
  | { kind: "idle" }
  | { kind: "working"; message: string }
  | { kind: "done" }
  | { kind: "failed"; message: string };

const IDLE: TextLayerPhase = { kind: "idle" };

export function useTextLayer() {
  const saveExtractedText = useMutation(api.papers.saveExtractedText);
  const markIngestFailed = useMutation(api.papers.markIngestFailed);

  // The token's *value* is held in a ref rather than closed over, so that a
  // rotation does not change `read`'s identity — `PdfPanel` starts extraction
  // from an effect that depends on `read`, and a `read` that changed under it
  // would ask again.
  //
  // Its *presence* is a different question and is deliberately not hidden in
  // the ref: `read` refuses to start without one, so it must get a new
  // identity when auth arrives or the paper that was skipped is never picked
  // up. Presence flips once per sign-in; the value changes every hour.
  const token = useAuthToken();
  const hasToken = token !== null;
  const tokenRef = useRef(token);
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  /**
   * A phase per paper, not one for the hook.
   *
   * Two reads can be in flight at once — paste a DOI, then paste another while
   * the first paper's pages are still going through pdf.js — and a single
   * unkeyed phase would let whichever finished first speak for whichever the
   * screen is currently showing. That is not a cosmetic mix-up: the DOI panel
   * turns "done" into a link straight to the reader, so the wrong paper would
   * be declared ready and opened before its own text layer existed.
   */
  const [phases, setPhases] = useState<ReadonlyMap<string, TextLayerPhase>>(
    new Map(),
  );

  const phaseFor = useCallback(
    (paperId: Id<"papers">): TextLayerPhase => phases.get(paperId) ?? IDLE,
    [phases],
  );

  // Stable, so `read` is too — `PdfPanel` starts extraction from an effect and
  // a `read` that changed identity every render would be a loop.
  const setPhase = useCallback((paperId: Id<"papers">, phase: TextLayerPhase) => {
    setPhases((previous) => new Map(previous).set(paperId, phase));
  }, []);

  // Extraction is idempotent but not cheap — eighteen pages of pdf.js — and
  // the callers below are reactive, so they will ask more than once for the
  // same paper. One attempt each.
  const attempted = useRef<Set<string>>(new Set());

  const read = useCallback(
    /** `force` is somebody pressing the button again; the guard is for the
     *  callers that ask automatically. */
    async (paperId: Id<"papers">, force = false): Promise<boolean> => {
      /**
       * No token yet means "not signed in *yet*", not "cannot be read".
       *
       * This runs from an effect the moment a paper with no text layer comes
       * on screen, and on a cold load that can be a beat before Convex Auth
       * has a token. Falling through would fetch without one, land in the
       * catch, and call `markIngestFailed` — writing "this PDF cannot be
       * read" onto a file nothing has even looked at, permanently, since
       * nothing retries a paper that has already failed.
       *
       * So: bail before `attempted` records anything, leaving this paper
       * untouched and its phase idle. `hasToken` is in this callback's deps,
       * so `read` gets a new identity the moment auth arrives and the
       * caller's effect fires again — that run is the real first attempt.
       */
      if (!hasToken) {
        if (force) {
          // Except when somebody pressed the button, where silence would read
          // as a dead control. A phase, deliberately — it says so in the
          // panel without touching the paper's stored ingest state, because
          // there is still nothing wrong with the file.
          setPhase(paperId, {
            kind: "failed",
            message: "Still signing you in. Try that again in a moment.",
          });
        }
        return false;
      }

      if (!force && attempted.current.has(paperId)) {
        return false;
      }
      attempted.current.add(paperId);

      try {
        setPhase(paperId, { kind: "working", message: "Fetching the PDF…" });
        const data = await fetchPdfBytes(paperId, tokenRef.current);
        const extraction = await extractPdf(data, {
          onProgress: (pagesDone, pages) =>
            setPhase(paperId, {
              kind: "working",
              message: `Reading page ${pagesDone} of ${pages}…`,
            }),
        });
        await saveExtractedText({ paperId, pages: extraction.pages });
        setPhase(paperId, { kind: "done" });
        return true;
      } catch (caught) {
        // A session that expired between the guard above and the fetch is the
        // same story as one that had not started: the file is fine, and
        // recording an ingest failure would condemn it over an hour of
        // reading rather than anything about the PDF. It carries its own
        // sentence too — the generic classifiers below would flatten "your
        // session has expired" into "that PDF wouldn't open", which is the
        // one reading that sends a member off to re-upload a working file.
        if (caught instanceof PdfAuthError) {
          setPhase(paperId, { kind: "failed", message: caught.message });
          return false;
        }

        // A stored file can be password-protected or damaged too — every
        // open-access copy fetched by DOI lands here unread. Same order as the
        // attach flows: the pdf.js classifier speaks for the failures it
        // recognises, and everything else keeps the fallback.
        const message =
          describePdfOpenError(caught) ??
          readableError(caught, "That PDF wouldn't open.");
        setPhase(paperId, { kind: "failed", message });

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
    [hasToken, saveExtractedText, markIngestFailed, setPhase],
  );

  return { phaseFor, read };
}
