"use client";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { relativeWhen } from "@/lib/sessions-ui";
import { eyebrowClass } from "@/lib/ui";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { readableError } from "./errors";

type Notification = FunctionReturnType<typeof api.notifications.listMine>[number];

/**
 * Your pigeonhole.
 *
 * Margin does not do badges. A red dot with a number in it is the grammar of a
 * product that wants to be opened, and this one is a notebook — the equivalent
 * gesture in a notebook is a slip left in a pigeonhole, or a corner turned
 * down on the page you were asked about. So the rail carries no bell and no
 * dot: it carries the same left rule every other item in the rail uses to say
 * "here", inked in the accent when something is waiting, and a count set in
 * tabular figures where the section note usually sits.
 *
 * The panel is a short stack of slips. An outstanding one keeps its accent
 * rule; one you have dealt with loses it and settles back into the paper,
 * still legible, because an inbox that erases what you just clicked leaves
 * "which paper was that?" unanswerable.
 *
 * ## The line this component does not cross
 *
 * Opening the panel acknowledges nothing. Scrolling it acknowledges nothing.
 * There is no timer, no intersection observer, and no effect that marks
 * anything on mount. `acknowledge` is called from exactly two places, and both
 * of them are a person doing something: clicking through to the paper, and
 * pressing "I'm caught up". That is what makes the field on the row honestly
 * called `acknowledgedAt` rather than the read receipt the privacy
 * constitution forbids.
 */
export function NotificationRail({ labId }: { labId: Id<"labs"> }) {
  const outstanding = useQuery(api.notifications.outstandingCount, { labId });
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();

  const count = outstanding?.count ?? 0;
  const capped = outstanding?.capped ?? false;
  const waiting = count > 0;

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // Escape closes, and a click anywhere else does too. Both are scoped to
  // while the panel is open so the app is not listening to every click in the
  // product for the sake of a panel nobody has opened.
  useEffect(() => {
    if (!open) {
      return;
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        close();
      }
    }
    function onPointer(event: MouseEvent) {
      const root = containerRef.current;
      if (root !== null && !root.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [open, close]);

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((previous) => !previous)}
        // The rail's own grammar, unchanged: an accent rule down the left is
        // how every item here says "this one" — the same mark an annotation
        // puts beside a passage. Waiting mail earns it; nothing else about the
        // row moves, which is the whole idea of a quiet indicator.
        className={
          "-mx-3 flex w-[calc(100%+1.5rem)] flex-col gap-0.5 rounded-r-sm border-l-2 px-3 py-2 text-left " +
          "motion-safe:transition-[background-color,border-color] motion-safe:duration-200 " +
          (waiting || open
            ? "border-accent bg-surface"
            : "border-transparent hover:bg-surface/70")
        }
      >
        <span
          className={
            "font-sans text-sm " +
            (waiting ? "text-ink-strong" : "text-ink-muted")
          }
        >
          For you
        </span>
        <span className="font-sans text-xs text-ink-faint">
          {waiting ? (
            <>
              <span className="tabular-nums text-accent">
                {count}
                {capped ? "+" : ""}
              </span>{" "}
              waiting
            </>
          ) : (
            "Mentions and replies"
          )}
        </span>
      </button>

      <AnimatePresence>
        {open && (
          <NotificationPanel
            id={panelId}
            labId={labId}
            onClose={close}
            onNavigate={() => setOpen(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function NotificationPanel({
  id,
  labId,
  onClose,
  onNavigate,
}: {
  id: string;
  labId: Id<"labs">;
  onClose: () => void;
  onNavigate: () => void;
}) {
  const items = useQuery(api.notifications.listMine, { labId });
  const acknowledgeAll = useMutation(api.notifications.acknowledgeAll);
  const reduce = useReducedMotion();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const outstanding = (items ?? []).filter(
    (item) => item.acknowledgedAt === undefined,
  );

  return (
    <motion.div
      id={id}
      initial={reduce === true ? { opacity: 0 } : { opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce === true ? { opacity: 0 } : { opacity: 0, y: -4 }}
      transition={{ duration: reduce === true ? 0 : 0.18 }}
      // Wider than the rail on purpose: a snippet set at 256px is a column of
      // two words. It lifts off the rail as a sheet, over the page it is about.
      className={
        "absolute left-0 top-full z-40 mt-2 w-[min(22rem,calc(100vw-3rem))] " +
        "overflow-hidden rounded-md border border-rule bg-surface shadow-[var(--shadow-sheet)]"
      }
    >
      <div className="flex items-baseline justify-between gap-3 border-b border-rule px-4 py-3">
        <span className={eyebrowClass}>For you</span>
        <span className="font-sans text-[11px] text-ink-faint">
          Only you see this
        </span>
      </div>

      <div className="max-h-[min(26rem,60vh)] overflow-y-auto overscroll-contain">
        {items === undefined ? (
          <p className="px-4 py-6 font-sans text-sm text-ink-faint">Looking…</p>
        ) : items.length === 0 ? (
          <p className="px-4 py-6 font-serif text-sm leading-relaxed text-ink-muted">
            Nothing is waiting on you. When a labmate names you in a margin, or
            answers one of your notes, it lands here.
          </p>
        ) : (
          <ul>
            {items.map((item) => (
              <NotificationSlip
                key={item._id}
                item={item}
                onNavigate={onNavigate}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-rule px-4 py-3">
        {/*
         * The cursor only ever moves because somebody said it should — the
         * same rule the digest keeps. There is no timer behind this button.
         */}
        <button
          type="button"
          disabled={busy || outstanding.length === 0}
          onClick={async () => {
            setError(null);
            setBusy(true);
            try {
              await acknowledgeAll({ labId });
            } catch (caught) {
              setError(readableError(caught, "That didn't go through."));
            } finally {
              setBusy(false);
            }
          }}
          className="font-sans text-xs text-accent underline-offset-4 hover:underline disabled:cursor-not-allowed disabled:text-ink-faint disabled:no-underline"
        >
          {outstanding.length === 0 ? "All caught up" : "I'm caught up"}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="font-sans text-xs text-ink-faint underline-offset-4 hover:text-ink hover:underline"
        >
          Close
        </button>
      </div>

      {error !== null && (
        <p role="alert" className="border-t border-rule px-4 py-2 font-sans text-xs text-ink">
          {error}
        </p>
      )}
    </motion.div>
  );
}

/**
 * One slip.
 *
 * A link rather than a button with a `router.push` in it, so the ordinary
 * things a link can do — middle-click, ⌘-click, copy the address — still work
 * on a notification, and so the destination is visible in the status bar
 * before it is clicked. The acknowledgement rides along on the plain click,
 * which is the act that says "I have dealt with this".
 */
function NotificationSlip({
  item,
  onNavigate,
}: {
  item: Notification;
  onNavigate: () => void;
}) {
  const acknowledge = useMutation(api.notifications.acknowledge);
  const router = useRouter();
  const href = `/app/library/${item.paperId}/read?note=${item.annotationId}`;
  const outstanding = item.acknowledgedAt === undefined;

  return (
    <li className="border-b border-rule last:border-b-0">
      <a
        href={href}
        onClick={(event) => {
          // Leave the modified clicks to the browser: a ⌘-click opening a new
          // tab has not dealt with anything yet.
          if (
            event.defaultPrevented ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey ||
            event.button !== 0
          ) {
            return;
          }
          event.preventDefault();
          void acknowledge({ notificationId: item._id }).catch(() => {
            // Navigating matters more than the bookkeeping; the item stays
            // outstanding and can be cleared again from the panel.
          });
          onNavigate();
          router.push(href);
        }}
        className={
          "block border-l-2 px-4 py-3 motion-safe:transition-colors motion-safe:duration-200 hover:bg-surface-sunken/60 " +
          (outstanding ? "border-accent" : "border-transparent")
        }
      >
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span
            className={
              "font-sans text-xs " +
              (outstanding ? "text-ink-strong" : "text-ink-muted")
            }
          >
            {item.actorName}{" "}
            {item.kind === "mention" ? "mentioned you" : "replied to your note"}
          </span>
          <span className="font-sans text-[11px] text-ink-faint">
            {relativeWhen(item.createdAt)}
          </span>
        </p>

        <p
          className={
            "mt-1 line-clamp-2 font-serif text-sm leading-snug " +
            (outstanding ? "text-ink" : "text-ink-muted")
          }
        >
          {item.snippet}
        </p>

        <p className="mt-1 truncate font-sans text-[11px] italic text-ink-faint">
          {item.paperTitle}
        </p>
      </a>
    </li>
  );
}
