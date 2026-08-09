"use client";

import { openedFromKeyboard } from "@/lib/ui";
import { Popover as Base } from "@base-ui/react/popover";
import { useState } from "react";
import type { ComponentProps, ReactNode } from "react";

/**
 * Why Base UI wants to close, and the escape hatch for a caller that would
 * rather ask first.
 *
 * Structural rather than imported from Base UI's internals: the reasons are
 * strings (`"escape-key"`, `"outside-press"`, …) and the only capability worth
 * exposing is the one the reader's composer needs — stop the dismissal, put a
 * question on screen, and let the person who is halfway through a note decide.
 */
export type PopoverDismissal = {
  reason: string;
  cancel: () => void;
  /** The native event behind the dismissal, when an event caused it. */
  event?: Event;
  /**
   * Let the event that caused this dismissal keep bubbling. Base UI stops it
   * by default; a caller that cancelled the dismissal because the event
   * belongs to a surface above (the ⌘K palette over the composer) calls this
   * so that surface still hears it. Both fields are on every details object
   * Base UI builds; the optionality is this type's caution, not a real maybe.
   */
  allowPropagation?: () => void;
};

/**
 * A sheet held above the page, anchored to the thing that opened it.
 *
 * Margin has exactly one popover, and this is it: the reader's composer, a date
 * picker, anything that has to appear beside a control rather than in the
 * middle of the screen. The positioning, the focus return, the Escape and the
 * ARIA wiring are Base UI's — they are the parts that are tedious to get right
 * and invisible when they are wrong. What lives here is the paper: the app's
 * own surface tokens, and the app's own entrance.
 *
 * Two shapes, because the composer needs the second one. Uncontrolled with a
 * `trigger`: pass the *content* of the trigger button, not a button — Base UI
 * renders the `<button>`. Controlled with `open` and `anchor`: no trigger at
 * all, and the thing being pointed at is a rectangle rather than a control (see
 * `boxAnchor` in `lib/ui.ts`), which is the only way to anchor a sheet to a run
 * of selected text.
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
  open,
  onOpenChange,
  anchor,
  initialFocus,
}: {
  /** Omit for a controlled popover with an `anchor`. */
  trigger?: ReactNode;
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
  /** Which side of the anchor to open on. Flips if it doesn't fit. */
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  /** Gap between anchor and sheet, in pixels. */
  sideOffset?: number;
  triggerClassName?: string;
  /** Extra classes on the sheet — sizing, mostly. */
  className?: string;
  /** Controlled open. Leave undefined and the trigger owns it. */
  open?: boolean;
  /**
   * Called when Base UI wants the sheet opened or closed. `details.cancel()`
   * refuses the dismissal, which is how a caller gets to ask "discard this?"
   * before Escape takes a half-written note away.
   */
  onOpenChange?: (open: boolean, details: PopoverDismissal) => void;
  /** What to position against, when it isn't the trigger. */
  anchor?: ComponentProps<typeof Base.Positioner>["anchor"];
  /** `false` leaves focus where it is, for a sheet whose own field autofocuses. */
  initialFocus?: ComponentProps<typeof Base.Popup>["initialFocus"];
}) {
  const [instant, setInstant] = useState(false);

  return (
    <Base.Root
      {...(open === undefined ? {} : { open })}
      onOpenChange={(next, details) => {
        if (next) {
          setInstant(openedFromKeyboard(details.event));
        }
        onOpenChange?.(next, details);
      }}
    >
      {trigger !== undefined && (
        <Base.Trigger className={triggerClassName}>{trigger}</Base.Trigger>
      )}
      <Base.Portal>
        <Base.Positioner
          side={side}
          align={align}
          sideOffset={sideOffset}
          {...(anchor === undefined ? {} : { anchor })}
          // Flip to the far side when the near one won't fit; slide along the
          // other axis rather than flipping, so a sheet anchored to something
          // near the edge of the window stays where the eye left it.
          collisionAvoidance={{ side: "flip", align: "shift" }}
          className="z-50 outline-none"
        >
          <Base.Popup
            aria-label={ariaLabel}
            {...(initialFocus === undefined ? {} : { initialFocus })}
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
