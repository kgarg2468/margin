"use client";

import { ConfirmAction } from "@/app/(app)/app/_components/confirm-action";
import { readableError } from "@/app/(app)/app/_components/errors";
import { api } from "@/convex/_generated/api";
import { errorClass } from "@/lib/ui";
import { useMutation } from "convex/react";
import { useState } from "react";
import type { AnnotationType } from "./ontology";
import { typeStyle } from "./ontology";
import { TypeChips } from "./type-chips";
import type { AnchorState, AnnotationId, AnnotationView } from "./types";
import { VisibilityToggle } from "./visibility-toggle";

/**
 * What a card says about how sure the reader is that this is the passage.
 *
 * Nothing at all in the ordinary case, which is almost every case: a note that
 * landed on its recorded offsets, or on the one copy of its quote, is simply
 * anchored and saying so would be noise. The three states worth a word are the
 * ones where the answer was reasoned rather than read.
 */
function anchorNote(
  state: AnchorState | undefined,
  orphaned: boolean,
): string | null {
  if (orphaned) {
    return "Unanchored";
  }
  if (state === undefined || state.method === "position" || state.method === "quote") {
    return null;
  }
  if (state.ambiguous) {
    return "Uncertain";
  }
  return "Drifted";
}

/** Short, and pinned to one locale so the server and the client agree. */
function when(ms: number): string {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

/**
 * One note in the margin, and whatever the lab said back.
 *
 * The card carries its type's ink as a rule down its left edge — the same ink
 * the passage is underlined in — because that pairing is the only thing that
 * connects a card to a line of text once there are six of them on a page.
 * Colour alone would not be enough (and is not: hovering either one lights the
 * other), but as a second channel it is what makes a crowded margin scannable.
 */
export function AnnotationCard({
  annotation,
  replies,
  anchorState,
  orphaned = false,
  active,
  onActivate,
  registerElement,
}: {
  annotation: AnnotationView;
  replies: AnnotationView[];
  /** How the passage was found again, once its page has resolved. */
  anchorState?: AnchorState;
  /** Its passage is not in this file at all. */
  orphaned?: boolean;
  active: boolean;
  onActivate: (id: AnnotationId | null) => void;
  registerElement?: (id: AnnotationId, element: HTMLElement | null) => void;
}) {
  const style = typeStyle(annotation.type);
  const anchoring = anchorNote(anchorState, orphaned);
  const updateBody = useMutation(api.annotations.updateBody);
  const setType = useMutation(api.annotations.setType);
  const setVisibility = useMutation(api.annotations.setVisibility);
  const remove = useMutation(api.annotations.remove);
  const reply = useMutation(api.annotations.reply);

  const [editing, setEditing] = useState(false);
  const [replying, setReplying] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [draftBody, setDraftBody] = useState(annotation.body);
  const [replyBody, setReplyBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<unknown>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(readableError(caught, fallback));
    } finally {
      setBusy(false);
    }
  }

  // A note with replies cannot be taken away without taking the answers with
  // it, so it is withdrawn — body gone, tombstone and thread left standing.
  // One without them is simply deleted.
  const threaded = annotation.replyCount > 0;

  const lockedPublic =
    annotation.visibility === "lab" &&
    annotation.replyCount > 0 &&
    annotation.parentId === undefined;

  // Three replies is a conversation, not a pile: collapsing at that point costs
  // a click to read something that would have fitted anyway.
  const showReplies = expanded || replies.length <= 3;
  const visibleReplies = showReplies ? replies : replies.slice(0, 1);

  return (
    <article
      ref={(element) => registerElement?.(annotation._id, element)}
      onMouseEnter={() => onActivate(annotation._id)}
      onMouseLeave={() => onActivate(null)}
      onFocus={() => onActivate(annotation._id)}
      style={{ borderLeftColor: style.ink }}
      className={
        "border-l-2 bg-surface py-2 pl-3 pr-2 transition-shadow " +
        (active ? "shadow-[0_0_0_1px_var(--rule)]" : "")
      }
    >
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span
          style={{ color: style.ink }}
          className="font-sans text-[10px] uppercase tracking-[0.14em]"
        >
          {style.label}
        </span>
        <span className="font-sans text-xs text-ink-muted">
          {annotation.mine ? "You" : annotation.authorName}
        </span>
        <span className="font-sans text-[11px] text-ink-faint">
          {when(annotation.createdAt)}
          {annotation.editedAt !== undefined ? " · edited" : ""}
        </span>
        {annotation.mine && annotation.visibility === "private" && (
          <span className="rounded-sm border border-rule px-1 font-sans text-[9px] uppercase tracking-[0.12em] text-ink-faint">
            Private
          </span>
        )}
        {anchoring !== null && (
          <span
            title={
              anchoring === "Unanchored"
                ? "The passage this was written on is not in this file."
                : anchoring === "Uncertain"
                  ? "This passage appears more than once and the note could belong to either."
                  : "The paper has changed since this was written; the passage was matched, not found."
            }
            className="rounded-sm border border-dashed border-rule px-1 font-sans text-[9px] uppercase tracking-[0.12em] text-ink-faint"
          >
            {anchoring}
          </span>
        )}
      </header>

      <blockquote className="mt-1.5 font-serif text-[13px] leading-snug text-ink-faint">
        <span
          className={`line-clamp-2 italic ${anchoring === null ? "" : "underline decoration-dashed decoration-from-font underline-offset-2"}`}
        >
          {annotation.anchor.quote}
        </span>
      </blockquote>

      {annotation.deleted ? (
        <p className="mt-1.5 font-serif text-sm italic text-ink-faint">
          Withdrawn by its author.
        </p>
      ) : editing ? (
        <div className="mt-2 flex flex-col gap-2">
          <TypeChips
            size="small"
            value={annotation.type}
            onChange={(type: AnnotationType) =>
              void run(
                () => setType({ annotationId: annotation._id, type }),
                "That type didn't stick.",
              )
            }
          />
          <textarea
            autoFocus
            rows={3}
            value={draftBody}
            onChange={(event) => setDraftBody(event.target.value)}
            className="w-full resize-y rounded-sm border border-rule bg-page px-2 py-1.5 font-serif text-sm leading-relaxed text-ink"
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await updateBody({
                    annotationId: annotation._id,
                    body: draftBody,
                  });
                  setEditing(false);
                }, "That edit didn't save.")
              }
              className="tap-target font-sans text-xs text-accent underline-offset-4 hover:underline disabled:opacity-50"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setDraftBody(annotation.body);
                setEditing(false);
              }}
              className="tap-target font-sans text-xs text-ink-faint underline-offset-4 hover:underline"
            >
              Cancel
            </button>
          </div>
          {annotation.parentId === undefined && (
            <VisibilityToggle
              value={annotation.visibility}
              disabled={lockedPublic}
              disabledReason="Someone has replied, so this stays with the lab. You can withdraw it instead."
              onChange={(visibility) =>
                void run(
                  () =>
                    setVisibility({
                      annotationId: annotation._id,
                      visibility,
                    }),
                  "That didn't change.",
                )
              }
            />
          )}
          {/* The only destructive action in Margin that used to fire on one
              click, sitting among compact edit controls where the click was
              easy to make by accident and impossible to take back.
              `confirmLabel` says which of the two things is about to happen,
              because they are genuinely different: a note with replies leaves
              the thread and a tombstone standing, and a note without them
              leaves nothing at all. */}
          <span className="self-start">
            <ConfirmAction
              tone="faint"
              disabled={busy}
              label={threaded ? "Withdraw note" : "Delete note"}
              confirmLabel={
                threaded
                  ? "Withdraw — the replies stay"
                  : "Delete — nothing is kept"
              }
              // The edit form around this already has a Cancel.
              cancelLabel="Keep it"
              run={() =>
                run(async () => {
                  await remove({ annotationId: annotation._id });
                  setEditing(false);
                }, "That didn't withdraw.")
              }
            />
          </span>
        </div>
      ) : (
        annotation.body.length > 0 && (
          <p className="mt-1.5 whitespace-pre-wrap font-serif text-sm leading-relaxed text-ink">
            {annotation.body}
          </p>
        )
      )}

      {visibleReplies.length > 0 && (
        <ul className="mt-2 flex flex-col gap-2 border-l border-rule pl-2.5">
          {visibleReplies.map((child) => (
            <li key={child._id}>
              <p className="font-sans text-[11px] text-ink-faint">
                {child.mine ? "You" : child.authorName} · {when(child.createdAt)}
              </p>
              <p className="whitespace-pre-wrap font-serif text-sm leading-snug text-ink">
                {child.deleted ? (
                  <span className="italic text-ink-faint">Withdrawn.</span>
                ) : (
                  child.body
                )}
              </p>
            </li>
          ))}
        </ul>
      )}

      {!showReplies && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="tap-target mt-1.5 font-sans text-xs text-accent underline-offset-4 hover:underline"
        >
          {replies.length - 1} more{" "}
          {replies.length - 1 === 1 ? "reply" : "replies"}
        </button>
      )}

      {replying ? (
        <div className="mt-2 flex flex-col gap-2">
          <textarea
            autoFocus
            rows={2}
            value={replyBody}
            onChange={(event) => setReplyBody(event.target.value)}
            placeholder="Answer this"
            className="w-full resize-y rounded-sm border border-rule bg-page px-2 py-1.5 font-serif text-sm leading-relaxed text-ink placeholder:text-ink-faint"
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={busy || replyBody.trim().length === 0}
              onClick={() =>
                void run(async () => {
                  await reply({ parentId: annotation._id, body: replyBody });
                  setReplyBody("");
                  setReplying(false);
                  setExpanded(true);
                }, "That reply didn't send.")
              }
              className="tap-target font-sans text-xs text-accent underline-offset-4 hover:underline disabled:opacity-50"
            >
              Reply
            </button>
            <button
              type="button"
              onClick={() => setReplying(false)}
              className="tap-target font-sans text-xs text-ink-faint underline-offset-4 hover:underline"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        // gap-x-5: `Reply` and `Edit` are 32px and 21px wide, so their 44px
        // hit boxes would otherwise reach well into each other.
        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-5">
          {annotation.visibility === "lab" && !annotation.deleted && (
            <button
              type="button"
              onClick={() => setReplying(true)}
              className="tap-target font-sans text-xs text-ink-faint underline-offset-4 hover:text-accent hover:underline"
            >
              Reply
            </button>
          )}
          {annotation.mine && !annotation.deleted && !editing && (
            <button
              type="button"
              onClick={() => {
                setDraftBody(annotation.body);
                setEditing(true);
              }}
              className="tap-target font-sans text-xs text-ink-faint underline-offset-4 hover:text-accent hover:underline"
            >
              Edit
            </button>
          )}
        </div>
      )}

      {error !== null && (
        <p role="alert" className={`${errorClass} mt-2`}>
          {error}
        </p>
      )}
    </article>
  );
}
