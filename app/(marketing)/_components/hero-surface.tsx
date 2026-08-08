"use client";

import type { ReactNode, RefObject } from "react";
import { useEffect, useRef } from "react";

/**
 * The sheets of graph paper the page is ruled on, and the lamp over them.
 *
 * Two surfaces share one mechanism. `HeroSurface` is the masthead's sheet:
 * a strong grid that fades toward the fold, the reading lamp, and a pen —
 * the cursor leaves a line of accent ink on the ruling that fades the way
 * wet ink dries. `PageSurface` carries the rest of the page on a much
 * fainter ruling with the same lamp, so the sheet never ends where the
 * masthead does; the desk is one desk.
 *
 * The pointer writes custom properties straight onto the element inside
 * requestAnimationFrame; React is not in the loop and nothing re-renders.
 * Touch screens and prefers-reduced-motion get the matte sheets, full stop.
 */

const fineAndMoving = () =>
  !window.matchMedia("(prefers-reduced-motion: reduce)").matches &&
  window.matchMedia("(pointer: fine)").matches;

function useLamp(ref: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const element = ref.current;
    if (element === null || !fineAndMoving()) {
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
  }, [ref]);
}

/**
 * The pen. A transparent canvas over the sheet on which the cursor draws a
 * line of accent ink; each frame the whole drawing is faded a step toward
 * transparent (`destination-out`), so the tail of the line is always drying
 * while the tip is always wet. The loop only runs while there is ink.
 */
function PenTrail({ surface }: { surface: RefObject<HTMLDivElement | null> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    // The canvas sits inside a pointer-events-none decoration layer, so the
    // pen listens on the surface itself — the two share a box.
    const pad = surface.current;
    if (!canvas || !parent || !pad || !fineAndMoving()) {
      return;
    }
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      canvas.width = parent.clientWidth * dpr;
      canvas.height = parent.clientHeight * dpr;
    };
    resize();
    const sized = new ResizeObserver(resize);
    sized.observe(parent);

    let ink = "#4068a0";
    let frame = 0;
    let idle = 0;
    let previous: { x: number; y: number } | null = null;
    let pending: { x: number; y: number }[] = [];

    const loop = () => {
      // Dry the ink already on the page…
      context.globalCompositeOperation = "destination-out";
      context.fillStyle = "rgba(0, 0, 0, 0.03)";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.globalCompositeOperation = "source-over";

      // …then lay down whatever the hand did since the last frame.
      if (pending.length > 0 && previous !== null) {
        context.strokeStyle = ink;
        context.globalAlpha = 0.65;
        context.lineWidth = 1.6 * dpr;
        context.lineCap = "round";
        context.lineJoin = "round";
        context.beginPath();
        context.moveTo(previous.x, previous.y);
        for (const point of pending) {
          const mid = {
            x: (previous.x + point.x) / 2,
            y: (previous.y + point.y) / 2,
          };
          context.quadraticCurveTo(previous.x, previous.y, mid.x, mid.y);
          previous = point;
        }
        context.stroke();
        context.globalAlpha = 1;
        pending = [];
        idle = 0;
      } else {
        idle += 1;
      }

      // ~4s of fade after the hand stops is enough to clear the sheet.
      if (idle < 250) {
        frame = requestAnimationFrame(loop);
      } else {
        frame = 0;
        context.clearRect(0, 0, canvas.width, canvas.height);
        previous = null;
      }
    };

    const move = (event: PointerEvent) => {
      const box = parent.getBoundingClientRect();
      const point = {
        x: (event.clientX - box.left) * dpr,
        y: (event.clientY - box.top) * dpr,
      };
      if (previous === null) {
        previous = point;
      }
      pending.push(point);
      if (frame === 0) {
        // The pen writes in whatever the accent resolves to right now, so it
        // is the same ink in both colour schemes.
        ink =
          getComputedStyle(parent).getPropertyValue("--accent").trim() || ink;
        frame = requestAnimationFrame(loop);
      }
    };
    const leave = () => {
      previous = null;
    };

    pad.addEventListener("pointermove", move);
    pad.addEventListener("pointerleave", leave);
    return () => {
      pad.removeEventListener("pointermove", move);
      pad.removeEventListener("pointerleave", leave);
      sized.disconnect();
      if (frame !== 0) {
        cancelAnimationFrame(frame);
      }
    };
  }, [surface]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="absolute inset-0 h-full w-full"
    />
  );
}

function Ruling({
  grid,
  lit,
  glow,
  radius,
}: {
  /** opacity of the matte ruling */
  grid: number;
  /** how bright the lit ruling gets under the lamp */
  lit: number;
  /** strength of the lamplight wash */
  glow: number;
  /** lamp radius in px */
  radius: number;
}) {
  return (
    <>
      <div
        className="absolute inset-0"
        style={{
          opacity: grid,
          backgroundImage:
            "linear-gradient(to right, var(--rule) 1px, transparent 1px), linear-gradient(to bottom, var(--rule) 1px, transparent 1px)",
          backgroundSize: "34px 34px",
        }}
      />
      <div
        className="absolute inset-0 transition-opacity duration-500"
        style={{
          opacity: `calc(var(--lamp) * ${lit})`,
          backgroundImage:
            "linear-gradient(to right, color-mix(in oklab, var(--accent) 60%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in oklab, var(--accent) 60%, transparent) 1px, transparent 1px)",
          backgroundSize: "34px 34px",
          maskImage: `radial-gradient(${radius}px circle at var(--mx) var(--my), black, transparent 72%)`,
          WebkitMaskImage: `radial-gradient(${radius}px circle at var(--mx) var(--my), black, transparent 72%)`,
        }}
      />
      <div
        className="absolute inset-0 transition-opacity duration-500"
        style={{
          opacity: "var(--lamp)",
          background: `radial-gradient(${Math.round(radius * 1.4)}px circle at var(--mx) var(--my), color-mix(in oklab, var(--accent) ${glow}%, transparent), transparent 70%)`,
        }}
      />
    </>
  );
}

const SURFACE_VARS = {
  "--mx": "70%",
  "--my": "8rem",
  "--lamp": "0",
} as React.CSSProperties;

export function HeroSurface({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLamp(ref);

  return (
    <div ref={ref} className="relative overflow-hidden" style={SURFACE_VARS}>
      {/* One mask on the wrapper fades the whole apparatus out towards the
          fold, so neither the lit grid nor the ink can outlive the sheet
          they are ruled on. */}
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
        <Ruling grid={0.6} lit={0.75} glow={13} radius={240} />
      </div>
      {/* The pen sits outside the fold-fade: ink dries on its own clock and
          may run right to the edge of the sheet. Behind the text, always. */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <PenTrail surface={ref} />
      </div>
      {children}
    </div>
  );
}

export function PageSurface({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLamp(ref);

  return (
    <div ref={ref} className="relative" style={SURFACE_VARS}>
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <Ruling grid={0.18} lit={0.45} glow={8} radius={300} />
      </div>
      <div className="relative">{children}</div>
    </div>
  );
}
