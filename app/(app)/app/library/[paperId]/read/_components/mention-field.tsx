"use client";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  findMentionQuery,
  insertMention,
  mentionSegments,
  rankCandidates,
} from "@/lib/mentions";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

/** Somebody the author has actually chosen, kept until the note is saved. */
export type PickedMention = { id: Id<"users">; name: string };

/**
 * A note field that can name a labmate.
 *
 * Typing `@` opens the roster; typing more filters it; ↑/↓ move, Enter or Tab
 * pick, Escape dismisses. What lands in the body is the person's plain name —
 * "@Sara Chen", characters, no markup — and what is *remembered* is the id
 * behind the name they picked.
 *
 * That split is the entire point, and it is why this component holds `picked`
 * on behalf of its parent rather than deriving mentions from the text. The
 * server is never asked to work out who "@Sara Chen" is; it is told, by a
 * client that watched a person choose from a menu of their own labmates, and
 * it then checks the ids it was told are in the lab. Nothing regexes a name or
 * an email address out of prose, so an address quoted from a methods section
 * cannot become a message to a stranger.
 *
 * The list is reconciled against the body at save time, not here — see
 * `collectMentionedIds`. A name typed, picked, and then deleted again must not
 * notify anybody, and only the final text can say whether that happened.
 */
export function MentionField({
  paperId,
  value,
  onChange,
  onPick,
  rows = 3,
  placeholder,
  className,
  autoFocus = false,
  /** Fired on Enter when the picker is closed, so a parent can keep its shortcut. */
  onSubmit,
}: {
  paperId: Id<"papers">;
  value: string;
  onChange: (value: string) => void;
  onPick: (candidate: PickedMention) => void;
  rows?: number;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  onSubmit?: () => void;
}) {
  const candidates = useQuery(api.annotations.mentionCandidates, { paperId });
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  /**
   * The `@` position the author pressed Escape on.
   *
   * Dismissal has to be remembered against *which* mention was dismissed, or
   * the next keystroke re-opens the menu the author just closed — and closing
   * it again would be the only way to type a literal "@" anywhere.
   */
  const [dismissed, setDismissed] = useState<number | null>(null);
  /** Set after a pick so the caret can be restored once React has re-rendered. */
  const pendingCaret = useRef<number | null>(null);
  const listId = useId();

  const range = findMentionQuery(value, caret);
  const suggestions =
    range === null || range.start === dismissed || candidates === undefined
      ? []
      : rankCandidates(
          candidates.map((member) => ({
            id: member.userId,
            name: member.name,
          })),
          range.query,
        );
  const open = suggestions.length > 0;

  // Clamp rather than reset: the roster re-filters on every keystroke, and a
  // highlight that jumped back to the top each time would make ↓↓Enter select
  // whoever happened to be first.
  useEffect(() => {
    setActive((previous) =>
      suggestions.length === 0
        ? 0
        : Math.min(previous, suggestions.length - 1),
    );
  }, [suggestions.length]);

  // The caret belongs after the name that was just inserted, not at the end of
  // the body — otherwise naming somebody mid-paragraph throws the writer to the
  // bottom of it. Layout effect so it lands before the browser paints.
  useLayoutEffect(() => {
    const position = pendingCaret.current;
    const element = textareaRef.current;
    if (position === null || element === null) {
      return;
    }
    pendingCaret.current = null;
    element.setSelectionRange(position, position);
    setCaret(position);
  }, [value]);

  function choose(index: number) {
    const candidate = suggestions[index];
    if (candidate === undefined || range === null) {
      return;
    }
    const next = insertMention(value, range, candidate.name);
    pendingCaret.current = next.caret;
    onChange(next.text);
    onPick(candidate);
    setDismissed(null);
  }

  return (
    <div className="relative">
      <textarea
        ref={textareaRef}
        autoFocus={autoFocus}
        rows={rows}
        value={value}
        placeholder={placeholder}
        className={className}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        onChange={(event) => {
          setCaret(event.target.selectionStart);
          setDismissed(null);
          onChange(event.target.value);
        }}
        // Every way a caret can move without the text changing. Without these
        // the menu keeps answering a question about where the caret used to be.
        onKeyUp={(event) => setCaret(event.currentTarget.selectionStart)}
        onClick={(event) => setCaret(event.currentTarget.selectionStart)}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onBlur={() => setDismissed(null)}
        onKeyDown={(event) => {
          if (open) {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((previous) => (previous + 1) % suggestions.length);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive(
                (previous) =>
                  (previous - 1 + suggestions.length) % suggestions.length,
              );
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              choose(active);
              return;
            }
            if (event.key === "Escape") {
              // Stops the composer's own Escape handler from throwing away a
              // half-written note because the author dismissed a menu.
              event.preventDefault();
              event.stopPropagation();
              setDismissed(range?.start ?? null);
              return;
            }
          }
          if (
            onSubmit !== undefined &&
            event.key === "Enter" &&
            (event.metaKey || event.ctrlKey)
          ) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />

      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Lab members"
          className={
            "pop-in absolute left-0 top-full z-40 mt-1 max-h-48 w-full min-w-[12rem] overflow-y-auto " +
            "rounded-sm border border-rule bg-surface py-1 shadow-[var(--shadow-sheet)]"
          }
        >
          {suggestions.map((candidate, index) => (
            <li key={candidate.id}>
              <button
                id={`${listId}-${index}`}
                type="button"
                role="option"
                aria-selected={index === active}
                // The textarea must keep the caret: a blur here would collapse
                // the selection and insert the name in the wrong place.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(index)}
                className={
                  "flex w-full items-baseline gap-2 px-3 py-1.5 text-left font-sans text-sm " +
                  (index === active
                    ? "bg-surface-sunken text-ink-strong"
                    : "text-ink-muted")
                }
              >
                <span aria-hidden className="text-ink-faint">
                  @
                </span>
                <span className="truncate">{candidate.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A note's body with the names it addresses set in the accent ink.
 *
 * Rendered from the plain body plus the list of names, rather than from stored
 * markup — the prose in the database is exactly what its author typed, and this
 * is a reading of it. A mention whose person has since left the lab simply
 * stops being highlighted and stays as the words it always was.
 */
export function MentionedBody({
  body,
  names,
  className,
}: {
  body: string;
  names?: string[];
  className?: string;
}) {
  if (names === undefined || names.length === 0) {
    return <p className={className}>{body}</p>;
  }
  return (
    <p className={className}>
      {mentionSegments(body, names).map((segment, index) =>
        segment.mention ? (
          <span key={index} className="font-medium text-accent">
            {segment.text}
          </span>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </p>
  );
}
