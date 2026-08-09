"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnnotationCard } from "./annotation-card";
import { typeStyle } from "./ontology";
import { DEFAULT_GAP, relaxColumn } from "@/lib/rail/relax";
import { eyebrowClass, skeletonClass } from "@/lib/ui";
import type { AnchorState, AnnotationId, AnnotationView } from "./types";

/**
 * How a note takes and leaves its place in the margin: the entrance the
 * app's small surfaces share (rise, settle), a plain fade out. Applied
 * through `AnimatePresence` with `initial={false}`, so the first paint
 * composes at rest and only notes that arrive *while you watch* — a
 * colleague writing during a session, a filter letting one back in — get
 * the entrance.
 */
const CARD_ENTER = {
  initial: { opacity: 0, y: 6, scale: 0.985 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, transition: { duration: 0.15 } },
  transition: { duration: 0.24, ease: [0.16, 1, 0.3, 1] as const },
};

export type RailCard = {
  annotation: AnnotationView;
  replies: AnnotationView[];
  /** Where the passage is, in the reader's content coordinates. */
  top: number;
  /** How its passage was found again, when the page it is on has resolved. */
  state?: AnchorState;
  /**
   * The page the passage actually turned up on, when that is not the page the
   * note was written on. Set only for a note recovered from a neighbouring
   * page; absent — which is almost always — the note is where it says it is.
   */
  foundOnPage?: number;
};

/** Breathing room between two cards that want the same line. */
const GAP = DEFAULT_GAP;

/**
 * The height a card is assumed to have for the single frame between its first
 * render and the layout effect that measures it.
 *
 * It is never painted: the measuring pass is a `useLayoutEffect`, so the state
 * it sets re-renders before the browser draws anything. Zero rather than an
 * average, because an unmeasured card that claimed 90px of space — the number
 * that used to be here — pushed everything below it down and then pulled it
 * back once the real height arrived, on the one frame a reader is most likely
 * to be looking at the rail.
 */
const UNMEASURED = 0;

/**
 * How far a card has to be pushed before the gap between it and its passage
 * needs explaining. Below this it still reads as "beside", and a tether would
 * be a line drawn to somewhere the eye already was.
 */
const TETHER_MIN = 12;

/**
 * The margin.
 *
 * Cards line up with the passages they are about, which is the whole point of
 * the layout and also the only hard part of it: two notes on adjacent lines
 * want the same forty pixels. `lib/rail/relax.ts` settles that — it places a
 * crowded run so the displacement is shared rather than handed to whichever
 * note happens to be last, which means a card may sit slightly above its
 * passage as well as below it.
 *
 * It needs measured heights, which a ResizeObserver supplies plus one
 * synchronous read for cards it has not seen yet: a card's height does not
 * depend on where it ended up, so measuring and placing never chase each other.
 */
export function MarginRail({
  cards,
  unanchored,
  loading,
  truncated,
  aligned,
  columnHeight,
  activeId,
  onActivate,
  onFocusPassage,
}: {
  cards: RailCard[];
  unanchored: RailCard[];
  /** The margin has not arrived yet, which is not the same as it being empty. */
  loading: boolean;
  /** The query hit its ceiling: this is some of the margin, not all of it. */
  truncated: boolean;
  /** Wide enough to place cards against passages. Narrow screens get a list. */
  aligned: boolean;
  /** How tall the pages are, which is the least the rail can be. */
  columnHeight: number;
  activeId: AnnotationId | null;
  onActivate: (id: AnnotationId | null) => void;
  onFocusPassage: (annotation: AnnotationView) => void;
}) {
  const elements = useRef(new Map<AnnotationId, HTMLElement>());
  const sizes = useRef<ResizeObserver | null>(null);
  const [heights, setHeights] = useState<Map<AnnotationId, number>>(new Map());
  const rootRef = useRef<HTMLDivElement | null>(null);
  const spacerRef = useRef<HTMLDivElement | null>(null);
  /**
   * The rail's own top-left inside the reader's content box.
   *
   * Measured, not inherited. The old pass took the page column's `offsetTop`
   * and used it as the rail's origin, which was only ever true because both
   * columns were flex children of the same row with the same padding — so a
   * toolbar or a heading added to either one silently moved every card in the
   * margin. This asks the spacer where it actually is.
   */
  const [origin, setOrigin] = useState({ top: 0, left: 0 });
  const reduce = useReducedMotion();
  const entrance = reduce === true ? {} : CARD_ENTER;

  // A ResizeObserver rather than a measure-on-every-render pass: a card grows
  // when its thread is expanded or its editor opens, and the cards below it
  // have to move on the same frame or they overlap the passage they belong to.
  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      setHeights((previous) => {
        const next = new Map(previous);
        let changed = false;
        for (const entry of entries) {
          const element = entry.target as HTMLElement;
          const id = element.dataset.annotation as AnnotationId | undefined;
          if (id === undefined) {
            continue;
          }
          if (next.get(id) !== element.offsetHeight) {
            next.set(id, element.offsetHeight);
            changed = true;
          }
        }
        return changed ? next : previous;
      });
    });
    sizes.current = observer;
    // Cards registered before this effect ran (the first paint) are already in
    // the map and would otherwise never be measured.
    for (const element of elements.current.values()) {
      observer.observe(element);
    }
    return () => {
      observer.disconnect();
      sizes.current = null;
    };
  }, []);

  const register = useCallback((id: AnnotationId, element: HTMLElement | null) => {
    const previous = elements.current.get(id);
    if (previous !== undefined && previous !== element) {
      sizes.current?.unobserve(previous);
    }
    if (element === null) {
      elements.current.delete(id);
      return;
    }
    element.dataset.annotation = id;
    elements.current.set(id, element);
    sizes.current?.observe(element);
  }, []);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null) {
      return;
    }
    const measure = () => {
      const spacer = spacerRef.current;
      setOrigin((previous) => {
        const top = spacer?.offsetTop ?? 0;
        const left = spacer?.offsetLeft ?? 0;
        return previous.top === top && previous.left === left
          ? previous
          : { top, left };
      });
    };
    measure();
    // Anything that can move the spacer changes the size of something above or
    // around it, which is what this catches. `aligned` is a dependency because
    // the spacer does not exist at all in the narrow layout.
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [aligned]);

  // The ResizeObserver above only reports a card once it has been observed for
  // a frame, so a card's first render used to be placed against a made-up
  // height and corrected afterwards — a visible overlap on the frame a reader
  // most notices. This reads the real height before the browser paints.
  //
  // Only for cards with no measurement yet: everything already in the map is
  // the observer's business, and reading `offsetHeight` for a thousand cards on
  // every commit would be a forced reflow per scroll frame.
  //
  // No dependency array on purpose — it has to see every commit, because that
  // is when a newly registered element first exists. It cannot chain: the
  // updater returns `previous` unchanged once every card has been measured, and
  // React bails out of re-rendering on an unchanged state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    setHeights((previous) => {
      let next = previous;
      for (const [id, element] of elements.current) {
        if (previous.has(id)) {
          continue;
        }
        if (next === previous) {
          next = new Map(previous);
        }
        next.set(id, element.offsetHeight);
      }
      return next;
    });
  });

  const byId = useMemo(() => {
    const map = new Map<AnnotationId, RailCard>();
    for (const entry of cards) {
      map.set(entry.annotation._id, entry);
    }
    return map;
  }, [cards]);

  // `relaxColumn` orders by `wanted` alone — it carries no document ordinal,
  // which is sound here because this rail is a single column whose anchor y
  // *is* the document order of the page.
  const layout = useMemo(() => {
    if (!aligned) {
      return { placements: [], contentHeight: 0 };
    }
    return relaxColumn(
      cards.map((entry) => ({
        id: entry.annotation._id,
        wanted: entry.top - origin.top,
        height: heights.get(entry.annotation._id) ?? UNMEASURED,
      })),
      { gap: GAP, floor: 0 },
    );
  }, [aligned, cards, heights, origin.top]);

  const placed = layout.placements.flatMap((placement) => {
    const entry = byId.get(placement.id as AnnotationId);
    return entry === undefined ? [] : [{ card: entry, ...placement }];
  });

  function card(entry: RailCard) {
    return (
      <div
        // The measured element is the wrapper rather than the card itself,
        // because a note recovered from a neighbouring page carries a line of
        // explanation underneath it, and the typesetting pass above has to
        // count that line or the card below lands on top of it.
        ref={(element) => register(entry.annotation._id, element)}
        className="relative"
        onClick={(event) => {
          if (
            (event.target as HTMLElement).closest("button, textarea, a") === null
          ) {
            onFocusPassage(entry.annotation);
          }
        }}
      >
        {/* Clicking anywhere on a card jumps to its passage, which is the
            right affordance for a pointer and reachable by nothing else. The
            same action as a real control, out of the way until it is tabbed
            to — a card is full of buttons already and cannot become one. */}
        <button
          type="button"
          onClick={() => onFocusPassage(entry.annotation)}
          className="sr-only focus:not-sr-only focus:absolute focus:right-1 focus:top-1 focus:z-10 focus:rounded-sm focus:border focus:border-rule focus:bg-surface focus:px-1.5 focus:py-0.5 focus:font-sans focus:text-[10px] focus:uppercase focus:tracking-[0.12em] focus:text-accent"
        >
          Go to passage
        </button>
        <AnnotationCard
          annotation={entry.annotation}
          replies={entry.replies}
          anchorState={entry.state}
          active={activeId === entry.annotation._id}
          onActivate={onActivate}
        />
        {/* The paper repaginated and the passage turned up next door. The mark
            is drawn on the sentence in the ordinary way, because that is where
            the sentence is — but the margin says so out loud rather than
            quietly relocating somebody's note to a page they never opened.
            Both numbers: "found on page 8" alone is not the interesting half,
            and the page it was written on is the one the lab remembers. */}
        {entry.foundOnPage !== undefined && (
          <p
            title="This copy of the paper paginates differently from the one the note was written on. Nothing about the note itself has changed."
            className="mt-1 pl-3 font-sans text-[11px] leading-snug text-ink-faint"
          >
            Found on page {entry.foundOnPage + 1}, noted on page{" "}
            {entry.annotation.anchor.pageIndex + 1}.
          </p>
        )}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="w-full shrink-0 lg:w-80">
      {aligned ? (
        // The spacer is only as tall as the pages when there is something to
        // place against them; an empty rail must not push its own empty state
        // eighteen pages down.
        <div
          ref={spacerRef}
          className="relative"
          style={{
            height:
              placed.length === 0
                ? 0
                : Math.max(columnHeight, layout.contentHeight, 1),
          }}
        >

          <AnimatePresence initial={false}>
            {placed.map(({ card: entry, top }) => (
              <motion.div
                key={entry.annotation._id}
                {...entrance}
                // The typesetting pass moves cards when a thread expands or a
                // filter changes; easing `top` turns those jumps into the
                // margin re-flowing, which is what actually happened. Motion
                // owns transform and opacity; `top` stays with CSS.
                className="absolute inset-x-0 motion-safe:transition-[top] motion-safe:duration-300 motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)]"
                style={{ top }}
              >
                {card(entry)}
              </motion.div>
            ))}
          </AnimatePresence>

          {/* A tether for a card that could not have the line it asked for.
              A crowded passage pushes later cards a long way down — far enough
              that "the note beside the passage" stops being literally true and
              type colour is left doing all the work. This runs in the card's
              own ink from the line it belongs to down to where it ended up.

              In the gutter, and drawn after the cards, because the space it
              has to cross is by definition occupied: the reason a card moved
              is that another one is sitting where it wanted to be, and a
              tether at the cards' own left edge is hidden behind exactly the
              card that displaced it. Decorative — the card already quotes its
              passage in words, and clicking it still goes there. */}
          {placed.map(({ card: entry, top, wanted, drift }) =>
            Math.abs(drift) < TETHER_MIN ? null : (
              <span
                key={`${entry.annotation._id}-tether`}
                aria-hidden
                // Eased on the same curve and over the same 300ms as the card
                // it belongs to. Set inline and untransitioned, it jumped to
                // its new length the instant a thread expanded while the card
                // was still sliding — a line drawn to where the note was about
                // to be.
                className="pointer-events-none absolute -left-2 w-px motion-safe:transition-[top,height,opacity] motion-safe:duration-300 motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)]"
                style={{
                  top: Math.min(top, wanted),
                  height: Math.abs(drift),
                  backgroundColor: typeStyle(entry.annotation.type).ink,
                  opacity: activeId === entry.annotation._id ? 0.8 : 0.3,
                }}
              />
            ),
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          <AnimatePresence initial={false}>
            {cards.map((entry) => (
              <motion.div
                key={entry.annotation._id}
                {...entrance}
                layout={reduce !== true}
              >
                {card(entry)}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      {unanchored.length > 0 && (
        <section className="mt-6 flex flex-col gap-2.5 border-t border-rule pt-4">
          <h2 className={eyebrowClass}>Unanchored</h2>
          <p className="max-w-prose font-sans text-xs leading-relaxed text-ink-faint">
            The passage {unanchored.length === 1 ? "this note was" : "these notes were"}{" "}
            written on isn&rsquo;t in this file any more — a different version of
            the paper, most likely. The words are kept below.
          </p>
          {unanchored.map((entry) => (
            <div key={entry.annotation._id}>
              <AnnotationCard
                annotation={entry.annotation}
                replies={entry.replies}
                orphaned
                active={activeId === entry.annotation._id}
                onActivate={onActivate}
              />
            </div>
          ))}
        </section>
      )}

      {truncated && (
        <p className="mt-4 max-w-prose font-sans text-xs leading-relaxed text-ink-faint">
          This paper has more notes on it than the margin will show at once.
          These are the ones it could fetch.
        </p>
      )}

      {cards.length === 0 &&
        unanchored.length === 0 &&
        // "Nothing in the margin yet" while the margin is still on its way is
        // the wrong sentence, and it is the one a reader would believe.
        (loading ? (
          // Ghosts of two notes rather than a sentence: the rail composes at
          // its final shape, and cards landing replace like for like.
          <div role="status" aria-label="Reading the margin" className="flex flex-col gap-2.5">
            {[0, 1].map((i) => (
              <div
                key={i}
                className="flex flex-col gap-2 rounded-md border border-rule border-l-2 bg-surface py-2.5 pl-3 pr-2.5"
              >
                <span
                  aria-hidden
                  className={`${skeletonClass} h-4 w-24`}
                  style={{ animationDelay: `${i * 160}ms` }}
                />
                <span
                  aria-hidden
                  className={`${skeletonClass} h-3.5 w-full`}
                  style={{ animationDelay: `${i * 160 + 80}ms` }}
                />
                <span
                  aria-hidden
                  className={`${skeletonClass} h-3.5 w-2/3`}
                  style={{ animationDelay: `${i * 160 + 160}ms` }}
                />
              </div>
            ))}
          </div>
        ) : (
          <p className="max-w-prose font-serif text-sm leading-relaxed text-ink-faint">
            Nothing in the margin yet. Select a passage to write the first
            thing.
          </p>
        ))}
    </div>
  );
}
