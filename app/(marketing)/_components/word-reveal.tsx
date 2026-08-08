"use client";

import styles from "./showcase.module.css";

/**
 * Text that writes itself.
 *
 * Each word is a span whose opacity flips on with a delay proportional to
 * its position, so a sentence arrives the way typing does — in order, at a
 * hand's pace — while staying one node of real text to selection, findbar
 * and screen reader. Off state and transitions live in the CSS module;
 * reduced motion never switches the words off in the first place.
 */
export function WordReveal({
  text,
  active,
  step = 0.03,
  delay = 0,
}: {
  text: string;
  active: boolean;
  /** seconds between words */
  step?: number;
  /** seconds before the first word */
  delay?: number;
}) {
  return (
    <span>
      {text.split(" ").map((word, i) => (
        <span
          // Position is identity here: the text never reorders.
          key={i}
          data-active={active}
          className={styles.word}
          style={{ transitionDelay: active ? `${delay + i * step}s` : "0s" }}
        >
          {word}
          {" "}
        </span>
      ))}
    </span>
  );
}
