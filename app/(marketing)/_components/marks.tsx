"use client";

import { useInView, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { useRef } from "react";
import styles from "./showcase.module.css";

/**
 * A highlighter pass that happens when the reader reaches it.
 *
 * Same grammar as the marks in Fig. 1 — wash sweeps left to right, the pen
 * underline settles a beat later — reused for lines elsewhere on the page,
 * so being marked always looks like one thing. The sweep runs once, when
 * the line is properly in view; reduced motion ships it already marked.
 */
export function SweepMark({
  ink,
  underline,
  delay = 0,
  children,
}: {
  /** one of the note inks, e.g. "critique" — colours wash and pen */
  ink: string;
  /** override the pen colour, e.g. "var(--accent)" */
  underline?: string;
  delay?: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const reduce = useReducedMotion();
  const inView = useInView(ref, { once: true, margin: "0px 0px -18% 0px" });
  const on = reduce === true || inView;

  return (
    <mark
      ref={ref}
      data-active={on}
      className={`${styles.mark} box-decoration-clone rounded-[0.15em] px-[0.15em] text-ink`}
      style={
        {
          backgroundColor: "transparent",
          backgroundImage: `linear-gradient(var(--note-${ink}-wash), var(--note-${ink}-wash))`,
          "--mark-ink": underline ?? `var(--note-${ink})`,
          transitionDelay: on ? `${delay}s` : "0s",
        } as React.CSSProperties
      }
    >
      {children}
    </mark>
  );
}
