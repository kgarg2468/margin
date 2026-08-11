"use client";

import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  readPreference,
  themeClass,
  type ThemePreference,
} from "@/lib/theme";
import { labelClass } from "@/lib/ui";
import { useEffect, useState } from "react";

const OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/**
 * Three words in the rail's footer, beside the account.
 *
 * State starts at the default and is corrected in an effect rather than read
 * during render: `localStorage` does not exist on the server, and rendering
 * the stored answer on the client would be a hydration mismatch on the one
 * control whose whole job is to say which theme you are in. The *page* is
 * never wrong in the meantime — the boot script in `app/layout.tsx` put the
 * class on <html> before anything painted — only this control's own marked
 * option, and only for a frame.
 *
 * Applying a choice is a class swap on <html> and a write to storage, in that
 * order: the swap is what the reader sees and costs one style recalculation,
 * the write is only what the next visit reads. No context and no provider,
 * because there is exactly one consumer of this state and it is CSS.
 */
export function ThemeToggle() {
  const [preference, setPreference] = useState<ThemePreference>(DEFAULT_THEME);

  useEffect(() => {
    // Guarded like every other storage touch in this feature: with site data
    // blocked the `localStorage` accessor itself throws, and the control
    // should fall back to the default it already shows, not take the shell
    // down over a preference it cannot read.
    try {
      setPreference(
        readPreference(window.localStorage.getItem(THEME_STORAGE_KEY)),
      );
    } catch {
      // DEFAULT_THEME is already in state, and the boot script came to the
      // same answer the same way.
    }
  }, []);

  function apply(next: ThemePreference) {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    const className = themeClass(next);
    if (className !== null) {
      root.classList.add(className);
    }
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Site data can be blocked. The theme still changes for this visit; it
      // simply will not be remembered, which is the better half to lose.
    }
    setPreference(next);
  }

  return (
    <div className="flex flex-col gap-2">
      <span id="theme-label" className={labelClass}>
        Theme
      </span>
      <div
        role="radiogroup"
        aria-labelledby="theme-label"
        className="inline-flex self-start overflow-hidden rounded-sm border border-rule"
      >
        {OPTIONS.map((option) => {
          const selected = option.value === preference;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              // The press grammar's within-a-frame acknowledgement is
              // `pressable`'s compositor work; activation is `click`, like
              // every other control here (the visibility radiogroup this
              // mirrors included). Pointerdown would answer secondary mouse
              // buttons and miss click-only assistive tech, and a native
              // button already turns Enter and Space into this click.
              onClick={() => apply(option.value)}
              className={
                "pressable px-2.5 py-1 font-sans text-[11px] uppercase tracking-[0.12em] " +
                (selected
                  ? "bg-accent text-accent-contrast"
                  : "text-ink-faint hover:text-ink-muted")
              }
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
