"use client";

import type { ReactNode } from "react";
import { useEffect, useRef } from "react";

/**
 * The masthead's sheet of graph paper, and the reading lamp over it.
 *
 * The base grid is the same one the page has always had. What is new is a
 * second copy of it drawn in the accent ink, plus a soft wash of the same,
 * both clipped to a circle that follows the pointer — so the sheet stays
 * matte until a cursor moves across it, and then the squares under the hand
 * light up the way ruling does under a desk lamp. The pointer writes two
 * custom properties straight onto the element inside requestAnimationFrame;
 * React is not in the loop and nothing re-renders.
 *
 * Touch screens and prefers-reduced-motion get the matte sheet, full stop.
 */
export function HeroSurface({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    if (
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      !window.matchMedia("(pointer: fine)").matches
    ) {
      return;
    }

    let frame = 0;
    let x = 0;
    let y = 0;

    const move = (event: PointerEvent) => {
      x = event.clientX;
      y = event.clientY;
      if (frame !== 0) {
        return;
      }
      frame = requestAnimationFrame(() => {
        frame = 0;
        const box = element.getBoundingClientRect();
        element.style.setProperty("--mx", `${x - box.left}px`);
        element.style.setProperty("--my", `${y - box.top}px`);
        element.style.setProperty("--lamp", "1");
      });
    };
    const leave = () => {
      element.style.setProperty("--lamp", "0");
    };

    element.addEventListener("pointermove", move);
    element.addEventListener("pointerleave", leave);
    return () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerleave", leave);
      if (frame !== 0) {
        cancelAnimationFrame(frame);
      }
    };
  }, []);

  return (
    <div
      ref={ref}
      className="relative overflow-hidden"
      style={
        {
          "--mx": "70%",
          "--my": "8rem",
          "--lamp": "0",
        } as React.CSSProperties
      }
    >
      {/* One mask on the wrapper fades the whole apparatus out towards the
          fold, so the lit grid can never outlive the sheet it is ruled on. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          maskImage:
            "linear-gradient(to bottom, rgba(0,0,0,0.9), transparent 78%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, rgba(0,0,0,0.9), transparent 78%)",
        }}
      >
        {/* the sheet */}
        <div
          className="absolute inset-0 opacity-60"
          style={{
            backgroundImage:
              "linear-gradient(to right, var(--rule) 1px, transparent 1px), linear-gradient(to bottom, var(--rule) 1px, transparent 1px)",
            backgroundSize: "34px 34px",
          }}
        />
        {/* the lit ruling under the lamp */}
        <div
          className="absolute inset-0 transition-opacity duration-500"
          style={{
            opacity: "calc(var(--lamp) * 0.75)",
            backgroundImage:
              "linear-gradient(to right, color-mix(in oklab, var(--accent) 60%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in oklab, var(--accent) 60%, transparent) 1px, transparent 1px)",
            backgroundSize: "34px 34px",
            maskImage:
              "radial-gradient(240px circle at var(--mx) var(--my), black, transparent 72%)",
            WebkitMaskImage:
              "radial-gradient(240px circle at var(--mx) var(--my), black, transparent 72%)",
          }}
        />
        {/* the lamplight itself */}
        <div
          className="absolute inset-0 transition-opacity duration-500"
          style={{
            opacity: "var(--lamp)",
            background:
              "radial-gradient(340px circle at var(--mx) var(--my), color-mix(in oklab, var(--accent) 13%, transparent), transparent 70%)",
          }}
        />
      </div>
      {children}
    </div>
  );
}
