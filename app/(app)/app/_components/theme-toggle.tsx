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
    setPreference(
      readPreference(window.localStorage.getItem(THEME_STORAGE_KEY)),
    );
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
              // pointerdown, not click: the press grammar acknowledges within
              // a frame, and a class swap has nothing to wait for. Enter and
              // Space never fire a pointer event, so the keyboard is handled
              // below rather than left to a click that would arrive twice.
              onPointerDown={() => apply(option.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  apply(option.value);
                }
              }}
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
