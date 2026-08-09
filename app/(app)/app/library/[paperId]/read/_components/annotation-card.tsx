"use client";

import { ConfirmAction } from "@/app/(app)/app/_components/confirm-action";
import { readableError } from "@/app/(app)/app/_components/errors";
import { api } from "@/convex/_generated/api";
import { versionSummary } from "@/lib/annotation-history/history";
import { collectMentionedIds } from "@/lib/mentions";
import { errorClass } from "@/lib/ui";
import { useMutation } from "convex/react";
import { useState } from "react";
import { AnnotationHistory } from "./annotation-history";
import { StatusControl, StatusLine } from "./epistemic-status";
import type { PickedMention } from "./mention-field";
import { MentionedBody, MentionField } from "./mention-field";
import type { AnnotationType } from "./ontology";
import { typeStyle } from "./ontology";
import { Reactions } from "./reactions";
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
  const [showHistory, setShowHistory] = useState(false);
  const [draftBody, setDraftBody] = useState(annotation.body);
  const [replyBody, setReplyBody] = useState("");
  const [replyPicked, setReplyPicked] = useState<PickedMention[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const replyMentions = collectMentionedIds(replyBody, replyPicked);

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

  // How many states this note has been in, counting the one on screen. A note
  // nobody has edited sends nothing, and the card grows no control — which is
  // the point: history is a thing you can go and find, never a thing that
  // announces on every card that somebody changed their mind.
  //
  // The count comes with the note, so knowing a history exists costs no query;
  // reading it costs one, and only once somebody asks (see `AnnotationHistory`).
  // A withdrawn note has no count, because withdrawal takes the drafts too.
  const versionCount = annotation.versionCount ?? 1;
  const hasHistory = versionCount > 1 && !annotation.deleted;

  // Three replies is a conversation, not a pile: collapsing at that point costs
  // a click to read something that would have fitted anyway.
  const showReplies = expanded || replies.length <= 3;
  const visibleReplies = showReplies ? replies : replies.slice(0, 1);

  const sendReply = () =>
    void run(async () => {
      await reply({
        parentId: annotation._id,
        body: replyBody,
        ...(replyMentions.length > 0 ? { mentions: replyMentions } : {}),
      });
      setReplyBody("");
      setReplyPicked([]);
      setReplying(false);
      setExpanded(true);
    }, "That reply didn't send.");

  return (
    <article
      ref={(element) => registerElement?.(annotation._id, element)}
      onMouseEnter={() => onActivate(annotation._id)}
      onMouseLeave={() => onActivate(null)}
      onFocus={() => onActivate(annotation._id)}
      // Tabbing *within* a card — from Reply to Edit — is not leaving it.
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          onActivate(null);
        }
      }}
      style={{ borderLeftColor: style.ink }}
      // A card, not a slab: rounded, hairline-bordered, resting on the page
      // with a whisper of shadow — the Fig. 1 grammar. The type's ink keeps
      // the left rule; activation lifts the card rather than boxing it.
      // The one place `tap-target` is asked for less than it gives, and it is
      // asked here rather than in the utility because the utility is right
      // everywhere else. Its 44x44 `::after` is *centred*, so what it costs is
      // 14px of live hit area above and below a 16px control — and this card
      // is a column of 13-to-16px controls at a ~20px pitch: the marks row,
      // then Reply/Edit/Status under it. Measured, the collision was total.
      // "Edit" is later in DOM order, so its box took the overlap, and
      // `elementFromPoint` returned Edit at Mark's own centre; only a 6px
      // strip at the top of "Mark" still hit Mark, and a real click anywhere
      // else on it was intercepted. A shipped control was unreachable by
      // pointer.
      //
      // So down the column the reach is capped at 8px past each edge — under
      // half the gap to the next row, which is what keeps a hit box out of its
      // neighbour's centre — and across, where the card has the width, the
      // full 44px stands.
      className={
        "rounded-md border border-rule border-l-2 bg-surface py-2.5 pl-3 pr-2.5 " +
        "[&_.tap-target]:after:h-[calc(100%+1rem)] [&_.tap-target]:after:min-h-0 " +
        "motion-safe:transition-[box-shadow,translate] motion-safe:duration-[var(--dur-hover)] " +
        (active
          ? "shadow-[0_0_0_1px_var(--rule),var(--shadow-lift)] motion-safe:-translate-y-px"
          : "shadow-[var(--shadow-card)]")
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
        {/* Sits in the header rather than down in the action row because it is
            a fact about the note's provenance, in the line that already holds
            the other two — when it was written, and whether it has been
            rewritten. "· 3 versions" reads as the continuation of that
            sentence, and as a button it is the quietest one on the card. */}
        {hasHistory && (
          <button
            type="button"
            aria-expanded={showHistory}
            onClick={() => setShowHistory((was) => !was)}
            className="tap-target font-sans text-[11px] text-ink-faint underline-offset-4 transition-colors hover:text-accent hover:underline"
          >
            · {versionSummary(versionCount)}
          </button>
        )}
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
        <div className="pop-in mt-2 flex flex-col gap-2">
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
          <MentionedBody
            body={annotation.body}
            names={annotation.mentionNames}
            className="mt-1.5 whitespace-pre-wrap font-serif text-sm leading-relaxed text-ink"
          />
        )
      )}

      {/* Directly under the body, because it is the same body earlier: the
          panel unrolls beneath what the note says now and lists what it said
          before, in the same serif and the same column. Above the marks and
          the thread, which are what other people said *about* it. */}
      {hasHistory && (
        <AnnotationHistory annotation={annotation} open={showHistory} />
      )}

      {/* Under the note and above the marks, which is the order the three
          things happened in: somebody wrote this, then the lab ruled on it,
          then people said what they thought of it. A verdict placed down in
          the action row would read as another control; placed here it reads as
          what it is — a sentence about the sentence above it. */}
      <StatusLine annotation={annotation} />

      {/* Sits with the note rather than down in the action row, because a mark
          is a thing said *about the note* — and above the thread, because a
          reply answers the note too and the two should read in that order. A
          withdrawn note shows none: the tombstone says one thing and endorsements
          of a body nobody can read are not a second thing it should say. */}
      {!annotation.deleted && !editing && (
        <Reactions annotation={annotation} onError={setError} />
      )}

      {visibleReplies.length > 0 && (
        <ul className="mt-2 flex flex-col gap-2 border-l border-rule pl-2.5">
          {visibleReplies.map((child) => (
            <li key={child._id}>
              <p className="font-sans text-[11px] text-ink-faint">
                {child.mine ? "You" : child.authorName} · {when(child.createdAt)}
              </p>
              {child.deleted ? (
                <p className="font-serif text-sm leading-snug italic text-ink-faint">
                  Withdrawn.
                </p>
              ) : (
                <MentionedBody
                  body={child.body}
                  names={child.mentionNames}
                  className="whitespace-pre-wrap font-serif text-sm leading-snug text-ink"
                />
              )}
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
        <div className="pop-in mt-2 flex flex-col gap-2">
          <MentionField
            autoFocus
            paperId={annotation.paperId}
            value={replyBody}
            onChange={setReplyBody}
            onPick={(candidate) =>
              setReplyPicked((previous) =>
                previous.some((entry) => entry.id === candidate.id)
                  ? previous
                  : [...previous, candidate],
              )
            }
            rows={2}
            onSubmit={() => {
              if (!busy && replyBody.trim().length > 0) {
                sendReply();
              }
            }}
            placeholder="Answer this — type @ to bring somebody in"
            className="w-full resize-y rounded-sm border border-rule bg-page px-2 py-1.5 font-serif text-sm leading-relaxed text-ink placeholder:text-ink-faint"
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={busy || replyBody.trim().length === 0}
              onClick={sendReply}
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
        // hit boxes would otherwise reach well into each other. `mt-2.5` is
        // the same argument on the other axis — the marks row sits directly
        // above this one, and 6px between two 14px controls left nothing for
        // even the capped boxes to clear.
        <div className="mt-2.5 flex flex-wrap items-baseline gap-x-5">
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
          {/* Last in the row, and only for the two people who may use it. It
              is the one control here that is not about the caller's own
              writing — Reply and Edit are things you do to a margin, this is
              the lab ruling on one — so it goes at the end of the sentence
              rather than in among them. The panel it opens takes the line
              below, which is what the row's `flex-wrap` is for. */}
          <StatusControl annotation={annotation} onError={setError} />
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
