"use client";

import { Popover } from "@/app/(app)/app/_components/popover";
import type { PopoverDismissal } from "@/app/(app)/app/_components/popover";
import { readableError } from "@/app/(app)/app/_components/errors";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { collectMentionedIds } from "@/lib/mentions";
import { errorClass } from "@/lib/ui";
import { useMutation } from "convex/react";
import type { ComponentProps } from "react";
import { useCallback, useRef, useState } from "react";
import type { EscapePressedIn } from "./composer-escape";
import {
  composerEscape,
  composerHandlesEscape,
  dismissalAsksFirst,
  escapeBelongsTo,
} from "./composer-escape";
import type { PickedMention } from "./mention-field";
import { MentionField } from "./mention-field";
import type { AnnotationType } from "./ontology";
import { TypeChips } from "./type-chips";
import type { Draft } from "./types";
import { VisibilityToggle } from "./visibility-toggle";

type Visibility = Doc<"annotations">["visibility"];

/**
 * How every layer over the page announces itself: Base UI gives its popup the
 * role, the ⌘K palette sets it by hand, and a confirm dialog is the same thing
 * with a sharper name.
 */
const SURFACES = '[role="dialog"],[role="alertdialog"]';

/**
 * Which surface an Escape was pressed on, read off the event's own target and
 * off what else is open at the time.
 *
 * A target under no layer at all is *usually* the page, and the page is the
 * composer's to answer for. Usually, not always: a click on the palette's own
 * padding leaves focus on `<body>`, which is under nothing, while the palette
 * is still the thing on top. So the document is asked as well as the target —
 * see `escapeBelongsTo`.
 */
function pressedIn(
  target: EventTarget | null,
  within: Element | null,
): EscapePressedIn {
  const element = target instanceof Element ? target : null;
  // Up to the popup itself, not just the content: an Escape can land on Base
  // UI's dialog rather than on anything the composer rendered inside it.
  const sheet = within?.closest(SURFACES) ?? within;
  const root = within?.ownerDocument ?? null;
  return escapeBelongsTo({
    insideComposer:
      element !== null && sheet !== null && sheet.contains(element),
    insideSurface: element !== null && element.closest(SURFACES) !== null,
    otherSurfaceOpen:
      root !== null &&
      [...root.querySelectorAll(SURFACES)].some(
        (surface) => sheet === null || !sheet.contains(surface),
      ),
  });
}

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
 *
 * It sits in the shared `Popover` rather than in a hand-placed absolute box, so
 * a selection at the bottom of the window opens the sheet above it instead of
 * below the fold, and a selection at the right edge slides the sheet back into
 * the window instead of over the margin. What it gives up is nothing: the
 * anchor is the passage's own rectangle, re-measured by the page whenever the
 * page re-lays its text, so the sheet follows a zoom instead of being stranded
 * by it.
 */
export function Composer({
  paperId,
  sessionId,
  draft,
  anchor,
  onClose,
}: {
  paperId: Id<"papers">;
  sessionId?: Id<"sessions">;
  draft: Draft;
  /** The passage, as something a positioner can point at. */
  anchor: ComponentProps<typeof Popover>["anchor"];
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

  /** The roster's state, held here because Escape has to be ordered. */
  const [menu, setMenu] = useState<{ open: boolean; at: number | null }>({
    open: false,
    at: null,
  });
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  /**
   * Anything that is reliably inside the sheet, so an Escape can be placed
   * against it. The quoted passage is the one element the composer always
   * renders, and `pressedIn` only ever walks up from here to the popup —
   * `Popover` hands back no ref of its own, and a wrapper `<div>` for the
   * purpose would be a DOM node earning nothing.
   */
  const insideSheet = useRef<HTMLParagraphElement | null>(null);

  /**
   * Stable, and it keeps the old state object when nothing actually moved.
   * The field reports its menu from an effect that depends on this callback, so
   * a fresh closure every render would re-fire the report, which would set
   * state, which would render again: a loop with no bottom to it.
   */
  const onMenuOpenChange = useCallback((open: boolean, at: number | null) => {
    setMenu((previous) =>
      previous.open === open && previous.at === at ? previous : { open, at },
    );
  }, []);

  /**
   * Everyone picked out of the `@` menu while this note was being written —
   * including names since deleted from the body, which is why the list is
   * reconciled against the final text at save time rather than sent as is.
   */
  const [picked, setPicked] = useState<PickedMention[]>([]);
  const mentions = collectMentionedIds(body, picked);

  async function save() {
    if (saving) {
      return;
    }
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

  /**
   * One Escape can arrive here twice: Base UI listens on `document` and its
   * popup's own `onKeyDown` is delegated by React to the same node, so they are
   * siblings and `stopPropagation` is not `stopImmediatePropagation`. Every
   * branch below happens to be idempotent against a repeat, which is what makes
   * that harmless — check the next one that gets added rather than assuming it.
   */
  function escape() {
    switch (composerEscape({ menuOpen: menu.open, confirming, body })) {
      case "close-menu":
        setDismissedAt(menu.at);
        return;
      case "cancel-confirm":
        setConfirming(false);
        return;
      case "ask-before-discarding":
        setConfirming(true);
        return;
      case "close":
        onClose();
    }
  }

  function dismissal(open: boolean, details: PopoverDismissal) {
    if (open) {
      return;
    }
    if (details.reason === "escape-key") {
      if (
        !composerHandlesEscape(
          pressedIn(details.event?.target ?? null, insideSheet.current),
        )
      ) {
        // Something is open over the sheet and this Escape is its business.
        // Cancel, so the composer neither closes nor asks anything — and hand
        // the event back its propagation, because Base UI otherwise stops it at
        // `document`, one bubble before the palette's `window` listener would
        // have seen it. Without this the topmost surface is the one thing on
        // screen Escape cannot close.
        details.cancel();
        details.allowPropagation?.();
        return;
      }
      // Base UI would close the sheet here. It does not get to decide what
      // Escape means while there is a roster open or a half-written note in
      // the box — see `composer-escape.ts`.
      details.cancel();
      escape();
      return;
    }
    if (dismissalAsksFirst(details.reason, body)) {
      details.cancel();
      setConfirming(true);
      return;
    }
    onClose();
  }

  return (
    <Popover
      open
      anchor={anchor}
      aria-label="New note"
      side="bottom"
      align="start"
      sideOffset={10}
      // Base UI would take focus to the sheet; the field below asks for it
      // first, and a reader who selected a passage wants the cursor in the box.
      initialFocus={false}
      // A pointer takes time to arrive and the entrance covers that travel; a
      // shift-arrow does not, and neither does Enter on "Annotate selection".
      instant={draft.fromKeyboard}
      onOpenChange={dismissal}
      className="w-80 max-w-[calc(100vw-3rem)]"
    >
      <p
        ref={insideSheet}
        className="mb-3 border-l-2 border-rule pl-2.5 font-serif text-sm leading-snug text-ink-muted"
      >
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
          dismissedAt={dismissedAt}
          onDismissedAtChange={setDismissedAt}
          onMenuOpenChange={onMenuOpenChange}
          onSubmit={() => void save()}
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

        {confirming ? (
          // In the sheet rather than in a dialog on top of it: a second modal
          // over a modal brings a second Escape owner, which is the class of
          // bug this whole task is about.
          <div className="flex flex-col gap-2 border-l-2 border-accent-strong pl-3">
            <p className="font-sans text-sm text-ink">
              Throw this note away?
            </p>
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={onClose}
                className="pressable inline-flex items-center justify-center rounded-sm border border-rule bg-surface px-3 py-1.5 font-sans text-sm text-ink hover:border-ink-faint"
              >
                Discard
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="font-sans text-sm text-accent underline-offset-4 hover:underline"
              >
                Keep writing
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-4">
            <button
              type="button"
              disabled={saving}
              onClick={() => void save()}
              className="pressable inline-flex items-center justify-center rounded-sm bg-accent px-3 py-1.5 font-sans text-sm text-accent-contrast hover:bg-accent-strong disabled:opacity-50"
            >
              {saving ? "Saving…" : body.trim().length > 0 ? "Save note" : "Highlight"}
            </button>
            <button
              type="button"
              onClick={escape}
              className="font-sans text-sm text-ink-faint underline-offset-4 hover:underline"
            >
              Cancel
            </button>
          </div>
        )}

        {error !== null && (
          <p role="alert" className={errorClass}>
            {error}
          </p>
        )}
      </div>
    </Popover>
  );
}
