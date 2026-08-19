"use client";

import { motion, useScroll, useSpring } from "motion/react";
import { useSettledReducedMotion } from "./reduced-motion";

/**
 * A pen line across the top of the viewport that draws at reading pace —
 * the page's own scrollbar, in the page's own ink. Decorative; the real
 * scrollbar still exists.
 */
export function ReadingProgress() {
  const reduce = useSettledReducedMotion();
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, { stiffness: 140, damping: 28 });

  if (reduce) {
    return null;
  }
  return (
    <motion.div
      aria-hidden
      className="fixed inset-x-0 top-0 z-50 h-[2px] origin-left bg-accent"
      style={{ scaleX }}
    />
  );
}
