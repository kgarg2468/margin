"use client";

import { inputClass } from "@/lib/ui";
import { Select as Base } from "@base-ui/react/select";
import { useState } from "react";
import { openedFromKeyboard } from "./popover";

/**
 * A select that belongs to the notebook.
 *
 * The native control had one virtue — the OS draws its option list, so it was
 * themed and keyboard-complete for free — and one problem: that list is the
 * OS's, not the app's. It arrives in the system font on the system's own
 * ground, at the one moment the reader is being asked to make a choice, and
 * `selectClass` could only ever dress the closed state. So the list is drawn
 * here now, on the app's paper, and Base UI supplies what the platform used
 * to: the listbox roles, arrows, Home/End, typeahead, Escape, and focus back
 * on the trigger when it closes.
 *
 * `options` is the whole content of the list, which is deliberate — anything
 * that wants groups or icons wants a menu, not a select. For lists long enough
 * to want filtering, this is the wrong control entirely.
 */
export function Select<Value extends string>({
  value,
  onValueChange,
  options,
  "aria-label": ariaLabel,
}: {
  /** `null` only while there is nothing to select; the trigger reads empty. */
  value: Value | null;
  onValueChange: (value: Value) => void;
  options: readonly { value: Value; label: string }[];
  /**
   * Required, because a select in Margin's chrome never has a visible label
   * beside it — the eyebrow above the rail is a heading, not a `<label>`.
   */
  "aria-label": string;
}) {
  const [instant, setInstant] = useState(false);

  return (
    <Base.Root<Value>
      value={value}
      // `null` reaches here only if a list ever carries a null item, which
      // this one cannot: every option comes from `options`.
      onValueChange={(next) => {
        if (next !== null) {
          onValueChange(next);
        }
      }}
      // Lets `<Base.Value>` render the chosen option's label rather than its
      // raw value — which for a lab is a Convex id.
      items={options}
      onOpenChange={(open, details) => {
        if (open) {
          setInstant(openedFromKeyboard(details.event));
        }
      }}
    >
      <Base.Trigger
        aria-label={ariaLabel}
        className={`${inputClass} flex items-center justify-between gap-3 text-left data-[popup-open]:border-ink-faint`}
      >
        <Base.Value className="truncate" />
        <Base.Icon className="shrink-0 text-ink-faint transition-transform duration-[var(--dur-hover)] ease-out data-[popup-open]:rotate-180">
          {/* The same chevron `selectClass` paints as a background image, but
              as a real element, so it can take `currentColor` on both grounds
              and turn over when the list is open. */}
          <svg width="10" height="6" viewBox="0 0 10 6" aria-hidden fill="none">
            <path
              d="M1 1l4 4 4-4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </Base.Icon>
      </Base.Trigger>

      <Base.Portal>
        <Base.Positioner
          sideOffset={4}
          // Base UI's default is to overlap the trigger so the chosen item's
          // text lands on the trigger's — a macOS habit. Margin's chrome reads
          // top-to-bottom, so the list hangs below the field instead, which is
          // also what lets it have an entrance at all.
          alignItemWithTrigger={false}
          className="z-50 outline-none"
        >
          <Base.Popup
            className={
              "min-w-[var(--anchor-width)] max-h-[var(--available-height)] overflow-y-auto " +
              "rounded-md border border-rule bg-surface p-1 font-sans " +
              "shadow-[var(--shadow-sheet)] outline-none " +
              "transition-opacity duration-[var(--dur-exit)] ease-out " +
              "data-[ending-style]:animate-none data-[ending-style]:opacity-0 " +
              (instant ? "" : "pop-in")
            }
          >
            <Base.List>
              {options.map((option) => (
                <Base.Item
                  key={option.value}
                  value={option.value}
                  className={
                    "pressable grid grid-cols-[0.75rem_1fr] items-baseline gap-2 rounded-sm " +
                    "px-2 py-1.5 text-sm text-ink outline-none " +
                    "data-[highlighted]:bg-surface-sunken data-[disabled]:opacity-50"
                  }
                >
                  {/* A tick in its own column rather than a bold label: the
                      list should read as a list, and the row that is already
                      chosen should not also be the loudest one. */}
                  <Base.ItemIndicator className="text-xs text-ink-faint">
                    ✓
                  </Base.ItemIndicator>
                  <Base.ItemText className="col-start-2">
                    {option.label}
                  </Base.ItemText>
                </Base.Item>
              ))}
            </Base.List>
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}
