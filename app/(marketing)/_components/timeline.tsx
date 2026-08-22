"use client";

import { motion, useScroll, useSpring } from "motion/react";
import type { ReactNode } from "react";
import { useRef } from "react";
import { useSettledReducedMotion } from "./reduced-motion";

/**
 * The § 2 timeline draws its own rule.
 *
 * A hairline of accent ink grows down the left edge as the reader moves
 * through the three layers, over the matte rule that was always there — the
 * line is literally being drawn at the pace it is being read. Scroll maps
 * to scale; a spring keeps the nib from teleporting on fast wheels.
 */
export function TimelineDraw({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useSettledReducedMotion();

  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start 0.8", "end 0.55"],
  });
  const scaleY = useSpring(scrollYProgress, { stiffness: 90, damping: 24 });

  return (
    <div ref={ref} className="relative">
      <span aria-hidden className="absolute inset-y-0 left-0 w-px bg-rule" />
      <motion.span
        aria-hidden
        className="absolute inset-y-0 left-0 w-px origin-top bg-accent"
        style={{ scaleY: reduce ? 1 : scaleY }}
      />
      {children}
    </div>
  );
}
