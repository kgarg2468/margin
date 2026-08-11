"use client";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { GOLD_PAIRS } from "@/lib/digest/engine";
import { relativeWhen } from "@/lib/sessions-ui";
import { errorClass, eyebrowClass, skeletonClass } from "@/lib/ui";
import type { FunctionReturnType } from "convex/server";
import { useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { inboxState } from "./digest-state";
import { readableError } from "./errors";

type Digest = FunctionReturnType<typeof api.digests.listMine>[number];
type DigestItem = Digest["items"][number];

/**
 * A digest is one person's mail.
 *
 * `digests.listMine` starts at the signed-in user's id, so there is no argument
 * that could return somebody else's — and this component is the only thing that
 * renders one. Nothing aggregates digests, nothing compares them, and there is
 * no view anywhere that says who has read theirs. The line saying so is on the
 * screen because a promise the product keeps silently is a promise nobody
 * knows about.
 *
 * ## Two kinds of line, drawn differently
 *
 * The `digest_gold5` policy makes exactly two shapes (see
 * `lib/digest/engine.ts`): a **collision**, where somebody landed on a passage
 * the recipient themselves annotated and the two types make one of the five
 * gold pairs — and a **coalesced** line, which is everything else on a paper
 * summed into a sentence. The first is the reason the digest exists; the second
 * is context. They are drawn to say that: a collision carries a rule and the
 * name of the pair, a coalesced line is a quiet bullet.
 *
 * A collision can span two papers (`otherPaperId`), which is the same shape
 * with a second way in rather than a third kind of line.
 */
const BOUNDARY_LABEL: Record<Digest["boundary"], string> = {
  "session-prep": "Before the session",
  "session-start": "As the session started",
  "since-away": "Since you were away",
};

/**
 * The prep digest for one session — the personal half of a session page.
 */
export function SessionDigest({
  labId,
  sessionId,
}: {
  labId: Id<"labs">;
  sessionId: Id<"sessions">;
}) {
  const digests = useQuery(api.digests.listMine, { labId });
  const reduce = useReducedMotion();
  const mine = (digests ?? []).filter(
    (digest) => digest.sessionId === sessionId,
  );

  // Nothing on this page builds a prep digest, so the subscription is the only
  // late path — and for a session with none, which is most of them, the whole
  // effect of the answer arriving is to take this slot away. It used to take it
  // between two frames, and it sits between the presenter's brief and the
  // manage panel: the controls under the cursor moved before the reader did.
  // So the ghost folds shut, and the presence stays mounted through the empty
  // state or there would be nothing left to run the exit. It folds to nothing
  // rather than to a shell because a session scheduled for next week has no
  // prep yet, and an empty "Your prep" heading over a blank box is worse than
  // the absence of one. What the fold does not own is the page's gap between
  // siblings, which still closes in one frame once the span unmounts — the
  // same tail the inbox's section leaves.
  if (mine.length === 0) {
    return (
      <AnimatePresence initial={false}>
        {digests === undefined && (
          <motion.span
            key="prep-ghost"
            aria-label="Loading"
            role="status"
            exit={
              reduce === true
                ? { opacity: 0, transition: { duration: 0 } }
                : { opacity: 0, height: 0, transition: { duration: 0.28 } }
            }
            style={{ overflow: "hidden" }}
            className={`${skeletonClass} h-6 w-56`}
          />
        )}
      </AnimatePresence>
    );
  }

  // Prep to show is the one arrival that does not fold: the presence goes with
  // the same render that brings the section, so the ghost is gone rather than
  // shrinking underneath the very thing it was standing in for. Kept inside the
  // presence it would exit while the section entered, and the reader would get
  // the cards, then a settle, then the gap's snap — three movements to say one
  // digest turned up.
  return (
    <section className="flex flex-col gap-4">
      <h2 className={eyebrowClass}>Your prep</h2>
      <p className="max-w-prose font-sans text-xs text-ink-faint">
        Written for you from what the lab wrote after you last looked. Only you
        see this.
      </p>
      <div className="flex flex-col gap-6">
        {mine.map((digest) => (
          <DigestCard key={digest._id} digest={digest} labId={labId} />
        ))}
      </div>
    </section>
  );
}

/**
 * "Since you were away" on the lab's home page: the digests that have arrived
 * and not been acknowledged, whatever boundary made them.
 *
 * Acknowledged ones drop out rather than greying out. This is an inbox, and an
 * inbox that keeps everything forever is a list nobody opens.
 */
export function DigestInbox({ labId }: { labId: Id<"labs"> }) {
  const digests = useQuery(api.digests.listMine, { labId });
  const catchUp = useMutation(api.digests.catchUp);
  const reduce = useReducedMotion();
  const unread = (digests ?? []).filter(
    (digest) => digest.acknowledgedAt === undefined,
  );

  // Arriving is the boundary. Nothing on the server can know a member was away
  // until they turn up — Margin keeps no last-active stamp to poll, by
  // constitution — so the mount is the trigger, and `catchUp` decides. Almost
  // every call decides nothing: it is idempotent, it never stacks a second
  // card, and it never moves a cursor. The ref keeps a re-render from asking
  // twice, and a failure clears it again: a lab's home page must not turn into
  // an error because a digest could not be built. Clearing the ref is not a
  // retry — nothing re-runs this effect on its own — it means the next run,
  // a return to the page or a switch back to this lab, asks fresh instead of
  // remembering the failure forever.
  //
  // `settledFor` is separate from the ref because it is about the page rather
  // than about the request: until the answer comes back, the section does not
  // yet know whether it exists, and it holds a slot rather than guessing empty.
  // It records *which* lab it settled for rather than a bare yes, because this
  // page stays mounted when the sidebar switches labs. A bare flag would still
  // read true from the lab just left — and the outgoing lab's request, landing
  // a moment later, would set it true all over again. Either one collapses the
  // slot while the new lab's catch-up is still out, which is the exact pop this
  // component exists to prevent. Compared against the current `labId`, both of
  // those stale writes are simply false.
  //
  // And a stale completion must not *write* at all, being false is not enough:
  // if the lab just left settles after the current one, its unguarded write
  // would replace the current lab's answer — an answer nothing will ever give
  // again, because that request already ran. `live` names the lab the page is
  // on when a completion lands; a request that outlived its lab settles
  // nothing.
  const asked = useRef<string | null>(null);
  const live = useRef(labId);
  const [settledFor, setSettledFor] = useState<Id<"labs"> | null>(null);
  useEffect(() => {
    live.current = labId;
    if (asked.current === labId) return;
    asked.current = labId;
    void catchUp({ labId })
      .catch(() => {
        if (asked.current === labId) asked.current = null;
      })
      .finally(() => {
        if (live.current === labId) setSettledFor(labId);
      });
  }, [labId, catchUp]);

  const state = inboxState({
    loaded: digests !== undefined,
    catchUpSettled: settledFor === labId,
    unreadCount: unread.length,
  });

  // The reserved slot: one line, the same ghost the roster and the calendar
  // use, sized to nothing in particular because a heading over an unknown is
  // worse than a blank. Returning before the presence below can cut an exit
  // short in exactly one race: mail already showing while catch-up is still
  // out, and another device acknowledges the last card in that window. The
  // slot drops back to a ghost until the answer lands — transient, and honest,
  // since with the mail gone this lab genuinely does not know yet whether it
  // is empty. Absent that race, both of the answers this state waits on move
  // only forwards. Switching labs does come back, and means to — the cards
  // below belong to the lab the reader just left, and holding them on screen
  // while the new lab's mail is still out would be showing them another lab's
  // inbox.
  if (state === "reserving") {
    return (
      <span
        aria-label="Loading"
        role="status"
        className={`${skeletonClass} h-6 w-56`}
      />
    );
  }

  // "Caught up" is a put-away, and it should read as one: the acknowledged
  // card folds closed and the page settles, instead of everything below it
  // snapping up a card-height. The outer presence does the same for the
  // whole section when the last card goes. `AnimatePresence` stays mounted
  // through the empty state, or there would be nothing to run the exit.
  return (
    <AnimatePresence initial={false}>
      {unread.length > 0 && (
        <motion.section
          key="inbox"
          exit={
            reduce === true
              ? { opacity: 0, transition: { duration: 0 } }
              : { opacity: 0, height: 0, transition: { duration: 0.28 } }
          }
          style={{ overflow: "hidden" }}
          className="flex flex-col gap-4"
        >
          <h2 className={eyebrowClass}>Since you were away</h2>
          <p className="max-w-prose font-sans text-xs text-ink-faint">
            Delivered at a boundary — before a session, as it starts, and when
            you come back after time away — never on every write. Only you see
            this.
          </p>
          <div className="flex flex-col gap-6">
            <AnimatePresence initial={false}>
              {unread.map((digest) => (
                <motion.div
                  key={digest._id}
                  layout={reduce !== true}
                  exit={
                    reduce === true
                      ? { opacity: 0, transition: { duration: 0 } }
                      : {
                          opacity: 0,
                          scale: 0.985,
                          transition: { duration: 0.2 },
                        }
                  }
                >
                  <DigestCard digest={digest} labId={labId} />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  );
}

function DigestCard({
  digest,
  labId,
}: {
  digest: Digest;
  labId: Id<"labs">;
}) {
  const markDigestSeen = useMutation(api.digests.markDigestSeen);
  const markSeen = useMutation(api.digests.markSeen);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const dropped = digest.droppedCount ?? 0;
  const acknowledged = digest.acknowledgedAt !== undefined;

  return (
    <article className="flex flex-col gap-3 rounded-md border border-rule bg-surface p-5 shadow-[var(--shadow-card)]">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="font-serif text-lg text-ink-strong">
          {BOUNDARY_LABEL[digest.boundary]}
        </h3>
        <span className="font-sans text-xs text-ink-faint">
          {relativeWhen(digest.generatedAt)}
        </span>
      </header>

      <ul className="flex flex-col gap-3">
        {digest.items.map((item, index) => (
          <DigestLine key={`${item.paperId}-${index}`} item={item} />
        ))}
      </ul>

      {dropped > 0 && (
        <p className="font-sans text-xs text-ink-faint tabular-nums">
          +{dropped} more {dropped === 1 ? "annotation" : "annotations"} the cap
          held back.
        </p>
      )}

      {/*
       * The cursor only ever moves because somebody said it should. Margin
       * stores no dwell time and no read receipt, so "caught up" is a button
       * with a person behind it, not a timer that fires when a panel scrolls
       * into view.
       */}
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          disabled={pending || acknowledged}
          className="font-sans text-sm text-accent underline-offset-4 hover:underline disabled:cursor-not-allowed disabled:text-ink-faint disabled:no-underline"
          onClick={async () => {
            setError(null);
            setPending(true);
            try {
              await markDigestSeen({ digestId: digest._id });
              // Advance the cursors this digest was written against, so the
              // next one starts where this one stopped. Passing `digestId`
              // is what makes that true: the mutation stamps the cursor with
              // the digest's own boundary rather than the clock at the moment
              // of the click, so anything written between the two still shows
              // up in the next digest instead of falling behind the cursor.
              const papers = [...new Set(digest.items.map((i) => i.paperId))];
              for (const paperId of papers) {
                await markSeen({ paperId, digestId: digest._id });
              }
              if (digest.sessionId !== undefined) {
                await markSeen({
                  sessionId: digest.sessionId,
                  digestId: digest._id,
                });
              }
              // A "since you were away" digest is about an absence from the
              // lab, not from a paper, so clearing it is what moves the
              // lab-wide cursor — and that cursor is the only thing that
              // decides when the next absence starts.
              if (digest.boundary === "since-away") {
                await markSeen({ labId, digestId: digest._id });
              }
            } catch (caught) {
              setError(readableError(caught, "That didn't go through."));
            } finally {
              setPending(false);
            }
          }}
        >
          {acknowledged
            ? "Caught up"
            : pending
              ? "Marking…"
              : "I'm caught up"}
        </button>
      </div>

      {error !== null && (
        <p role="alert" aria-live="polite" className={errorClass}>
          {error}
        </p>
      )}
    </article>
  );
}

function DigestLine({ item }: { item: DigestItem }) {
  const href = `/app/library/${item.paperId}/read`;

  if (item.kind === "collision") {
    const label =
      item.pairType !== undefined ? GOLD_PAIRS[item.pairType] : undefined;
    return (
      <li className="border-l-2 border-accent-strong pl-3">
        {label !== undefined && (
          <span className="font-sans text-[10px] uppercase tracking-[0.14em] text-accent-strong">
            {label}
          </span>
        )}
        <p className="font-serif text-base leading-relaxed text-ink">
          {item.line}
        </p>
        {/*
         * A cross-paper collision has two sides, so it gets two ways in — and
         * they are not equals. `item.paperId` is the paper the reader
         * annotated themselves, which is why it keeps the accent link and why
         * it is the only one "I'm caught up" advances a cursor on. The far
         * paper is somewhere they may never have been, so it gets the quiet
         * register: available, not urged. Its title is not a stored field on
         * the item, but it does not need to be — the line directly above names
         * both papers, so the label only has to say which of the two this is.
         */}
        <span className="flex flex-wrap items-baseline gap-x-4">
          <Link
            href={href}
            className="font-sans text-xs text-accent underline-offset-4 hover:underline"
          >
            Read the passage
          </Link>
          {item.otherPaperId !== undefined && (
            <Link
              href={`/app/library/${item.otherPaperId}/read`}
              className="font-sans text-xs text-ink-faint underline-offset-4 hover:text-accent hover:underline"
            >
              Read the other paper
            </Link>
          )}
        </span>
      </li>
    );
  }

  return (
    <li className="flex gap-2.5 pl-0.5">
      <span aria-hidden="true" className="font-sans text-ink-faint">
        ·
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="font-serif text-base leading-relaxed text-ink-muted">
          {item.line}
        </span>
        <Link
          href={href}
          className="self-start font-sans text-xs text-ink-faint underline-offset-4 hover:text-accent hover:underline"
        >
          In the margin
        </Link>
      </span>
    </li>
  );
}
