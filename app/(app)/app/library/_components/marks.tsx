"use client";

import { readableError } from "@/app/(app)/app/_components/errors";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { TagCount } from "@/lib/library/tags";
import {
  MAX_TAGS_PER_PAPER,
  normalizeTag,
  parseTagInput,
  suggestTags,
} from "@/lib/library/tags";
import { errorClass, eyebrowClass } from "@/lib/ui";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * How a paper is filed: the marks the lab has put on it.
 *
 * Both halves are drawn as marks rather than as controls, because that is what
 * they are — a librarian's pencil note in the corner of a card, not metadata in
 * a form. Tags are set lowercase in the chrome typeface and sit at the weight of
 * the byline they follow; a collection reads as the drawer the card was filed
 * in. Neither shouts, and neither is allowed to compete with the title.
 *
 * The one visual difference between them is the one that matters: a tag is a
 * word the lab chose, so it takes the accent when it is doing something (being
 * filtered on); a collection is a place, so it takes the same left rule the
 * sidebar and the palette use to mean "here".
 */

/** One tag, as a mark. `onClick` makes it a filter control; without it it is a label. */
export function TagMark({
  tag,
  active = false,
  onClick,
  onRemove,
  title,
}: {
  tag: string;
  active?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
  title?: string;
}) {
  const shell =
    "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-sans text-xs lowercase " +
    "motion-safe:transition-[color,background-color,border-color] motion-safe:duration-200 " +
    (active
      ? "border-accent bg-surface text-accent"
      : "border-rule bg-surface-sunken text-ink-muted");

  const label = (
    <>
      {/* The mark itself: a pencil tick, not an icon. */}
      <span aria-hidden className="text-ink-faint">
        ·
      </span>
      {tag}
    </>
  );

  return (
    <span className={shell}>
      {onClick === undefined ? (
        label
      ) : (
        <button
          type="button"
          onClick={onClick}
          title={title}
          aria-pressed={active}
          className="tap-target inline-flex items-center gap-1 hover:text-accent"
        >
          {label}
        </button>
      )}
      {onRemove !== undefined && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove the tag ${tag}`}
          className="tap-target text-ink-faint transition-colors hover:text-accent-strong"
        >
          ×
        </button>
      )}
    </span>
  );
}

/**
 * Add and remove a paper's tags, autocompleting over what the lab already says.
 *
 * The suggestion list is the point of the whole control. Left to a bare text
 * box a lab invents "methods", "method" and "methodology" inside a week, and
 * the vocabulary stops being one. So what already exists is offered first, in
 * order of how much the lab uses it, and typing a new label is still one
 * keystroke away for the case where none of them is right.
 */
export function TagEditor({
  paperId,
  tags,
  vocabulary,
  autoFocus = false,
  onDone,
}: {
  paperId: Id<"papers">;
  tags: readonly string[];
  vocabulary: readonly TagCount[];
  autoFocus?: boolean;
  onDone?: () => void;
}) {
  const tagPaper = useMutation(api.papers.tagPaper);
  const untagPaper = useMutation(api.papers.untagPaper);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (autoFocus) {
      inputRef.current?.focus();
    }
  }, [autoFocus]);

  const suggestions = suggestTags(vocabulary, text, { exclude: tags });
  const full = tags.length >= MAX_TAGS_PER_PAPER;

  async function add(candidate: string) {
    const parsed = parseTagInput(candidate);
    if (parsed.length === 0) {
      return;
    }
    setError(null);
    setText("");
    try {
      // One mutation per tag: pasting "methods, stats" is two facts, and the
      // ledger should read as two.
      for (const tag of parsed) {
        await tagPaper({ paperId, tag });
      }
    } catch (caught) {
      setError(readableError(caught, "That tag wouldn't stick."));
    }
  }

  async function remove(tag: string) {
    setError(null);
    try {
      await untagPaper({ paperId, tag });
    } catch (caught) {
      setError(readableError(caught, "That tag wouldn't come off."));
    }
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    // The library binds single letters at the window; anything typed in here is
    // a tag, not a shortcut.
    event.stopPropagation();

    if (event.key === "Enter") {
      event.preventDefault();
      void add(text);
      return;
    }
    const best = suggestions[0];
    if (event.key === "Tab" && best !== undefined && text.trim().length > 0) {
      // Completion, not navigation: the obvious label is one key away.
      event.preventDefault();
      setText(best);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onDone?.();
      return;
    }
    const last = tags[tags.length - 1];
    if (event.key === "Backspace" && text.length === 0 && last !== undefined) {
      // The gesture every tag field has: an empty box eats the last mark.
      event.preventDefault();
      void remove(last);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((tag) => (
          <TagMark key={tag} tag={tag} onRemove={() => void remove(tag)} />
        ))}
        {tags.length === 0 && (
          <span className="font-sans text-xs text-ink-faint">No tags yet</span>
        )}
      </div>

      {full ? (
        <p className="font-sans text-xs text-ink-faint">
          Twelve tags is the budget — take one off to add another.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <input
            ref={inputRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            aria-label="Add a tag"
            placeholder="Tag this paper…"
            className="w-full max-w-xs rounded-sm border-b border-rule bg-transparent px-0 py-1 font-sans text-sm lowercase text-ink placeholder:normal-case placeholder:text-ink-faint focus:border-accent focus:outline-none"
          />
          {suggestions.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {suggestions.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => void add(tag)}
                  className="tap-target rounded-sm border border-dashed border-rule px-1.5 py-0.5 font-sans text-xs lowercase text-ink-faint transition-colors hover:border-accent hover:text-accent"
                >
                  {tag}
                </button>
              ))}
            </div>
          )}
          {normalizeTag(text).length > 0 && suggestions.length === 0 && (
            <span className="font-sans text-xs text-ink-faint">
              New label — press enter to write it in.
            </span>
          )}
        </div>
      )}

      {error !== null && (
        <p role="alert" className={errorClass}>
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Everything about how one paper is filed, in one panel: its tags, and the
 * collections it sits in.
 *
 * One panel rather than two sections because it answers one question — "where
 * does this live?" — and because it is what the `t` key opens on the library's
 * focused row. A member who came here to tag something very often meant to
 * shelve it as well.
 */
export function FiledAs({
  paperId,
  labId,
  tags,
  autoFocus = false,
  onDone,
}: {
  paperId: Id<"papers">;
  labId: Id<"labs">;
  tags: readonly string[];
  autoFocus?: boolean;
  onDone?: () => void;
}) {
  const vocabulary = useQuery(api.papers.listTags, { labId }) ?? [];
  const collections = useQuery(api.collections.listCollections, { labId });
  const setPaperInCollection = useMutation(api.collections.setPaperInCollection);
  const [error, setError] = useState<string | null>(null);

  async function shelve(collectionId: Id<"collections">, inCollection: boolean) {
    setError(null);
    try {
      await setPaperInCollection({ collectionId, paperId, inCollection });
    } catch (caught) {
      setError(readableError(caught, "That shelf wouldn't take it."));
    }
  }

  return (
    <div className="flex flex-col gap-5 border-l-2 border-accent py-1 pl-4">
      <section className="flex flex-col gap-2">
        <h3 className={eyebrowClass}>Tags</h3>
        <TagEditor
          paperId={paperId}
          tags={tags}
          vocabulary={vocabulary}
          autoFocus={autoFocus}
          onDone={onDone}
        />
      </section>

      <section className="flex flex-col gap-2">
        <h3 className={eyebrowClass}>Collections</h3>
        {collections === undefined ? (
          <span className="font-sans text-xs text-ink-faint">Reading the shelves…</span>
        ) : collections.length === 0 ? (
          <span className="font-sans text-xs text-ink-faint">
            No collections in this lab yet.
          </span>
        ) : (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {collections.map((collection) => {
              const holds = collection.paperIds.includes(paperId);
              return (
                <label
                  key={collection._id}
                  className="tap-target flex cursor-pointer items-center gap-2 font-sans text-sm text-ink-muted transition-colors hover:text-ink"
                >
                  <input
                    type="checkbox"
                    checked={holds}
                    onChange={() => void shelve(collection._id, !holds)}
                    className="size-3.5 accent-[var(--accent)]"
                  />
                  {collection.name}
                </label>
              );
            })}
          </div>
        )}
      </section>

      {error !== null && (
        <p role="alert" className={errorClass}>
          {error}
        </p>
      )}

      {onDone !== undefined && (
        <button
          type="button"
          onClick={onDone}
          className="tap-target self-start font-sans text-sm text-accent underline-offset-4 hover:underline"
        >
          Done
        </button>
      )}
    </div>
  );
}
