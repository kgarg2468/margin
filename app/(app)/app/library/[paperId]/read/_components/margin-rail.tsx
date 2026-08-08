"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnnotationCard } from "./annotation-card";
import { eyebrowClass } from "@/lib/ui";
import type { AnnotationId, AnnotationView } from "./types";

export type RailCard = {
  annotation: AnnotationView;
  replies: AnnotationView[];
  /** Where the passage is, in the reader's content coordinates. */
  top: number;
};

/** Breathing room between two cards that want the same line. */
const GAP = 10;

/**
 * The margin.
 *
 * Cards line up with the passages they are about, which is the whole point of
 * the layout and also the only hard part of it: two notes on adjacent lines
 * want the same forty pixels. The pass below is the one a typesetter would do —
 * take them in document order and push each one down until it clears the last —
 * so a card never sits above its passage, only below it, and the reading order
 * of the margin always matches the reading order of the page.
 *
 * It needs measured heights, which a ResizeObserver supplies: a card's height
 * does not depend on where it ended up, so measuring and placing never chase
 * each other.
 */
export function MarginRail({
  cards,
  unanchored,
  aligned,
  originTop,
  height,
  activeId,
  onActivate,
  onFocusPassage,
}: {
  cards: RailCard[];
  unanchored: RailCard[];
  /** Wide enough to place cards against passages. Narrow screens get a list. */
  aligned: boolean;
  /** The y the reader's page column starts at, which is the rail's own origin. */
  originTop: number;
  height: number;
  activeId: AnnotationId | null;
  onActivate: (id: AnnotationId | null) => void;
  onFocusPassage: (annotation: AnnotationView) => void;
}) {
  const elements = useRef(new Map<AnnotationId, HTMLElement>());
  const sizes = useRef<ResizeObserver | null>(null);
  const [heights, setHeights] = useState<Map<AnnotationId, number>>(new Map());

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

  const placed: { card: RailCard; top: number }[] = [];
  if (aligned) {
    let floor = 0;
    for (const card of [...cards].sort((a, b) => a.top - b.top)) {
      const top = Math.max(card.top - originTop, floor);
      placed.push({ card, top });
      floor = top + (heights.get(card.annotation._id) ?? 90) + GAP;
    }
  }

  function card(entry: RailCard) {
    return (
      <div
        onClick={(event) => {
          if (
            (event.target as HTMLElement).closest("button, textarea, a") === null
          ) {
            onFocusPassage(entry.annotation);
          }
        }}
      >
        <AnnotationCard
          annotation={entry.annotation}
          replies={entry.replies}
          active={activeId === entry.annotation._id}
          onActivate={onActivate}
          registerElement={register}
        />
      </div>
    );
  }

  return (
    <div className="w-full shrink-0 lg:w-80">
      {aligned ? (
        <div className="relative" style={{ height: Math.max(height, 1) }}>
          {placed.map(({ card: entry, top }) => (
            <div
              key={entry.annotation._id}
              className="absolute inset-x-0"
              style={{ top }}
            >
              {card(entry)}
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {cards.map((entry) => (
            <div key={entry.annotation._id}>{card(entry)}</div>
          ))}
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
                active={activeId === entry.annotation._id}
                onActivate={onActivate}
              />
            </div>
          ))}
        </section>
      )}

      {cards.length === 0 && unanchored.length === 0 && (
        <p className="max-w-prose font-serif text-sm leading-relaxed text-ink-faint">
          Nothing in the margin yet. Select a passage to write the first thing.
        </p>
      )}
    </div>
  );
}
