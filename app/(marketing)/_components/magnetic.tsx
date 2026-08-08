"use client";

import { motion, useMotionValue, useReducedMotion, useSpring } from "motion/react";
import type { ReactNode } from "react";

/**
 * A control that leans toward the hand.
 *
 * The wrapper tracks the pointer while it is over the control and translates
 * a few pixels toward it, spring-damped, so the button feels attached to the
 * cursor by something soft. The travel is deliberately small — a magnet,
 * not a chase — and mouse-only: on touch there is no approach to react to.
 */
export function Magnetic({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const x = useSpring(useMotionValue(0), { stiffness: 280, damping: 20 });
  const y = useSpring(useMotionValue(0), { stiffness: 280, damping: 20 });

  const pull = (event: React.PointerEvent<HTMLSpanElement>) => {
    if (reduce || event.pointerType !== "mouse") {
      return;
    }
    const box = event.currentTarget.getBoundingClientRect();
    x.set(((event.clientX - box.left) / box.width - 0.5) * 10);
    y.set(((event.clientY - box.top) / box.height - 0.5) * 8);
  };
  const release = () => {
    x.set(0);
    y.set(0);
  };

  return (
    <motion.span
      className={`inline-block ${className ?? ""}`}
      style={{ x, y }}
      onPointerMove={pull}
      onPointerLeave={release}
    >
      {children}
    </motion.span>
  );
}
