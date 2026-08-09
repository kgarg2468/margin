"use client";

import { openedFromKeyboard } from "@/lib/ui";
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
  "aria-label": ariaLabel,
  side = "bottom",
  align = "center",
  sideOffset = 8,
  triggerClassName,
  className,
}: {
  trigger: ReactNode;
  children: ReactNode;
  /**
   * Required, because Base UI renders the sheet as a `role="dialog"` and a
   * dialog with no accessible name is announced as nothing at all. The sheets
   * this is for — a composer, a picker — carry no heading of their own, so
   * there is nothing for Base UI's `aria-labelledby` to point at; say here
   * what the sheet is for. (Anything that *does* want a visible heading wants
   * `Base.Title`, which this wrapper deliberately doesn't reach for yet.)
   */
  "aria-label": string;
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
            aria-label={ariaLabel}
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
