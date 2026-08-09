"use client";

import { readableError } from "@/app/(app)/app/_components/errors";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PdfAuthError, fetchPdfBytes } from "@/lib/pdf/delivery";
import { describePdfOpenError, extractPdf } from "@/lib/pdf/extract";
import type { Attempts } from "@/lib/pdf/text-layer-attempts";
import {
  NO_ATTEMPTS,
  decide,
  markAuthFailed,
  markRunning,
  markSettled,
} from "@/lib/pdf/text-layer-attempts";
import { useAuthToken } from "@convex-dev/auth/react";
import { useMutation } from "convex/react";
import { useCallback, useState } from "react";

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
 *
 * Deciding *whether* to read a given paper is not here. It is in
 * `lib/pdf/text-layer-attempts.ts`, as a pure function, because three
 * production bugs came out of that decision being tangled up with React's
 * effect wiring — and because the test suite covers `lib/` and cannot reach a
 * hook. What is left in this file is the doing: ask, act, report back.
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

  const token = useAuthToken();

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

  // Stable, so that a phase update is not by itself a reason for `read` to
  // change identity — `PdfPanel` starts extraction from an effect that
  // depends on `read`, and progress reports arrive once per page.
  const setPhase = useCallback((paperId: Id<"papers">, phase: TextLayerPhase) => {
    setPhases((previous) => new Map(previous).set(paperId, phase));
  }, []);

  /**
   * Who has had a go, in React state rather than a ref — see
   * `lib/pdf/text-layer-attempts.ts` for the rules and the invariant.
   *
   * State, specifically, is the mechanism. Every transition is a new map, so
   * every transition changes `read`'s identity, so every transition re-fires
   * the caller's effect and asks `decide` again. That is what makes a paper
   * released by an auth failure get picked up: the release *is* the signal.
   * Three bugs came out of the previous arrangement, where the retry rode on
   * some dependency happening to change at the right moment and the third
   * case was one where none did.
   */
  const [attempts, setAttempts] = useState<Attempts>(NO_ATTEMPTS);

  const read = useCallback(
    /**
     * Ask whether this paper may be read, and if so read it.
     *
     * Callers ask freely and often — an effect re-runs on every attempt
     * transition — so most calls end at `decide`. `force` is somebody
     * pressing the button, which overrides "already had its turn" but not
     * "already running".
     */
    async (paperId: Id<"papers">, force = false): Promise<boolean> => {
      const decision = decide({ paperId, token, forced: force }, attempts);

      if (decision.kind === "skip") {
        return false;
      }
      if (decision.kind === "wait") {
        // Nothing is recorded about a paper we never looked at — that is the
        // whole point of `wait`, and `decide` will say `fetch` for it the
        // moment a session exists.
        if (force) {
          // Except that silence in answer to a press reads as a dead control.
          // A phase, deliberately: it says so in the panel without touching
          // the paper's stored ingest state, because there is still nothing
          // wrong with the file.
          setPhase(paperId, {
            kind: "failed",
            message: "Still signing you in. Try that again in a moment.",
          });
        }
        return false;
      }

      // Claim the paper before the first await, so the asks that arrive while
      // this runs are answered `skip` rather than starting a second pdf.js
      // over the same file.
      setAttempts((current) => markRunning(current, paperId));

      try {
        setPhase(paperId, { kind: "working", message: "Fetching the PDF…" });
        const data = await fetchPdfBytes(paperId, decision.token);
        const extraction = await extractPdf(data, {
          onProgress: (pagesDone, pages) =>
            setPhase(paperId, {
              kind: "working",
              message: `Reading page ${pagesDone} of ${pages}…`,
            }),
        });
        await saveExtractedText({ paperId, pages: extraction.pages });
        setAttempts((current) => markSettled(current, paperId));
        setPhase(paperId, { kind: "done" });
        return true;
      } catch (caught) {
        // A session that died under this attempt is not a verdict on the
        // file, so the paper goes back to `auth-failed` rather than `settled`
        // — recorded against the token that failed, which is what lets a
        // refreshed session try again and an unchanged one not spin. It
        // carries its own sentence too: the generic classifiers below would
        // flatten "your session has expired" into "that PDF wouldn't open",
        // the one reading that sends a member off to re-upload a good file.
        if (caught instanceof PdfAuthError) {
          setAttempts((current) =>
            markAuthFailed(current, paperId, decision.token),
          );
          setPhase(paperId, { kind: "failed", message: caught.message });
          return false;
        }

        // Everything else *is* a verdict on the file, and the paper has had
        // its turn.
        setAttempts((current) => markSettled(current, paperId));

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
    // Every input `decide` reads is a dependency here, which is the property
    // the whole arrangement rests on: there is no change to the token or to
    // the attempts map that fails to re-ask the question.
    [attempts, token, saveExtractedText, markIngestFailed, setPhase],
  );

  return { phaseFor, read };
}
