"use client";

import { readableError } from "@/app/(app)/app/_components/errors";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { collectMentionedIds } from "@/lib/mentions";
import { errorClass } from "@/lib/ui";
import { useMutation } from "convex/react";
import { useEffect, useRef, useState } from "react";
import type { PickedMention } from "./mention-field";
import { MentionField } from "./mention-field";
import type { AnnotationType } from "./ontology";
import { TypeChips } from "./type-chips";
import type { Draft } from "./types";
import { VisibilityToggle } from "./visibility-toggle";

type Visibility = Doc<"annotations">["visibility"];

/**
 * What happens when you let go of a selection.
 *
 * Everything in it is optional except the passage. Tap save with nothing typed
 * and you get a highlight — "this matters" — which is the cheapest true thing a
 * reader can record and the one most likely to actually get recorded. Type a
 * chip and it becomes a hypothesis or a critique; write a line and it becomes
 * an argument.
 *
 * The visibility default is the privacy constitution's, and it is *shown*
 * rather than applied quietly: lab when you arrived here from a session (prep
 * is inherently collaborative), private otherwise. Either way it is one tap to
 * flip before saving.
 */
export function Composer({
  paperId,
  sessionId,
  draft,
  onClose,
}: {
  paperId: Id<"papers">;
  sessionId?: Id<"sessions">;
  draft: Draft;
  onClose: () => void;
}) {
  const create = useMutation(api.annotations.create);
  const [type, setType] = useState<AnnotationType>("note");
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState<Visibility>(
    sessionId === undefined ? "private" : "lab",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  /**
   * Everyone picked out of the `@` menu while this note was being written —
   * including names since deleted from the body, which is why the list is
   * reconciled against the final text at save time rather than sent as is.
   */
  const [picked, setPicked] = useState<PickedMention[]>([]);
  const mentions = collectMentionedIds(body, picked);

  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await create({
        paperId,
        sessionId,
        type,
        body,
        anchor: draft.anchor,
        visibility,
        ...(mentions.length > 0 ? { mentions } : {}),
      });
      window.getSelection()?.removeAllRanges();
      onClose();
    } catch (caught) {
      setError(readableError(caught, "That note didn't save."));
      setSaving(false);
    }
  }

  return (
    <div
      ref={rootRef}
      style={{ top: draft.top, left: draft.left }}
      className="pop-in absolute z-30 w-80 max-w-[calc(100vw-3rem)] rounded-md border border-rule bg-surface p-4 shadow-[var(--shadow-sheet)]"
      // A click inside must not count as a click outside.
      onMouseDown={(event) => event.stopPropagation()}
      onMouseUp={(event) => event.stopPropagation()}
    >
      <p className="mb-3 border-l-2 border-rule pl-2.5 font-serif text-sm leading-snug text-ink-muted">
        <span className="line-clamp-3 italic">{draft.anchor.quote}</span>
      </p>

      <TypeChips value={type} onChange={setType} />

      <div className="mt-3">
        <MentionField
          autoFocus
          paperId={paperId}
          value={body}
          onChange={setBody}
          onPick={(candidate) =>
            setPicked((previous) =>
              previous.some((entry) => entry.id === candidate.id)
                ? previous
                : [...previous, candidate],
            )
          }
          rows={3}
          placeholder="Say something, or just save the highlight. Type @ to name a labmate."
          className="w-full resize-y rounded-sm border border-rule bg-page px-2.5 py-2 font-serif text-sm leading-relaxed text-ink placeholder:text-ink-faint hover:border-ink-faint"
        />
      </div>

      <div className="mt-3 flex flex-col gap-3">
        <VisibilityToggle value={visibility} onChange={setVisibility} />

        {/*
         * Said out loud, and only when it is actually true. A note kept
         * private is a note nobody is told about, however many names are in
         * it — so a composer that showed "Sara will be notified" beside a
         * private toggle would be promising something the server will refuse
         * to do. This is the one place a member can see which of the two
         * they are about to do.
         */}
        {mentions.length > 0 && (
          <p className="font-sans text-xs text-ink-faint">
            {visibility === "lab"
              ? `${mentions.length === 1 ? "1 person" : `${mentions.length} people`} will be told about this note.`
              : "Private, so nobody is told. Share it with the lab and the people you named hear about it then."}
          </p>
        )}

        <div className="flex items-center gap-4">
          <button
            type="button"
            disabled={saving}
            onClick={save}
            className="inline-flex items-center justify-center rounded-sm bg-accent px-3 py-1.5 font-sans text-sm text-accent-contrast transition-colors hover:bg-accent-strong disabled:opacity-50"
          >
            {saving ? "Saving…" : body.trim().length > 0 ? "Save note" : "Highlight"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="font-sans text-sm text-ink-faint underline-offset-4 hover:underline"
          >
            Cancel
          </button>
        </div>

        {error !== null && (
          <p role="alert" className={errorClass}>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
