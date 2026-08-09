"use client";

import { Popover as Base } from "@base-ui/react/popover";
import { useState } from "react";
import type { ReactNode } from "react";

/**
 * A sheet held above the page, anchored to the thing that opened it.
 *
 * Margin has exactly one popover, and this is it: the reader's composer, a
 * date picker, anything that has to appear beside a control rather than in the
 * middle of the screen. The positioning, the focus return, the Escape and the
 * ARIA wiring are Base UI's — they are the parts that are tedious to get right
 * and invisible when they are wrong. What lives here is the paper: the app's
 * own surface tokens, and the app's own entrance.
 *
 * `trigger` is the *content* of the trigger button, not a button itself —
 * Base UI renders the `<button>` — so pass a label or an icon, and reach for
 * `triggerClassName` to dress it.
 */
export function Popover({
  trigger,
  children,
  side = "bottom",
  align = "center",
  sideOffset = 8,
  triggerClassName,
  className,
}: {
  trigger: ReactNode;
  children: ReactNode;
  /** Which side of the trigger to open on. Flips if it doesn't fit. */
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  /** Gap between trigger and sheet, in pixels. */
  sideOffset?: number;
  triggerClassName?: string;
  /** Extra classes on the sheet — sizing, mostly. */
  className?: string;
}) {
  const [instant, setInstant] = useState(false);

  return (
    <Base.Root
      onOpenChange={(open, details) => {
        if (open) {
          setInstant(openedFromKeyboard(details.event));
        }
      }}
    >
      <Base.Trigger className={triggerClassName}>{trigger}</Base.Trigger>
      <Base.Portal>
        <Base.Positioner
          side={side}
          align={align}
          sideOffset={sideOffset}
          // Flip to the far side when the near one won't fit; slide along the
          // other axis rather than flipping, so a sheet anchored to something
          // near the edge of the window stays where the eye left it.
          collisionAvoidance={{ side: "flip", align: "shift" }}
          className="z-50 outline-none"
        >
          <Base.Popup
            className={
              "rounded-md border border-rule bg-surface p-4 font-sans " +
              "shadow-[var(--shadow-sheet)] outline-none " +
              // Opacity alone on the way out, and shorter than the way in:
              // leaving should not make you wait. `animate-none` cancels a
              // still-running entrance so a sheet dismissed in its first
              // frames fades rather than snapping.
              "transition-opacity duration-[var(--dur-exit)] ease-out " +
              "data-[ending-style]:animate-none data-[ending-style]:opacity-0 " +
              (instant ? "" : "pop-in ") +
              (className ?? "")
            }
          >
            {children}
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}

/**
 * Whether the interaction that opened a surface came from the keyboard.
 *
 * The motion budget says keyboard-triggered surfaces render instantly (see
 * `docs/superpowers/specs/2026-08-08-product-feel-overhaul-design.md`): a
 * pointer takes time to arrive and the entrance covers that travel, but a
 * keystroke is instantaneous and an animation after it is just latency you
 * added yourself. Someone holding down Tab through a form should not be
 * watching sheets bloom.
 *
 * Lives here rather than in `lib/ui.ts` because it is about behaviour, not
 * classes, and this is the first of the three surfaces that needs it — the
 * confirm dialog and the select import it from the popover for the same
 * reason they all import `pop-in`: there is meant to be one answer.
 *
 * Enter and Space on a focused button still dispatch a `click`, which is why
 * the `KeyboardEvent` check is not enough on its own; the browser marks those
 * synthesized clicks with a `detail` of `0`, which a real press never has.
 */
export function openedFromKeyboard(event: Event | undefined): boolean {
  if (event === undefined) {
    return false;
  }
  if (typeof KeyboardEvent !== "undefined" && event instanceof KeyboardEvent) {
    return true;
  }
  return (
    typeof MouseEvent !== "undefined" &&
    event instanceof MouseEvent &&
    event.detail === 0
  );
}
