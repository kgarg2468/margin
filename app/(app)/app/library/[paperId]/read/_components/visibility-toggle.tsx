"use client";

import type { Doc } from "@/convex/_generated/dataModel";

type Visibility = Doc<"annotations">["visibility"];

/**
 * Who can see this.
 *
 * Written as two labelled options rather than a switch because the two states
 * are not more and less of one thing — they are different promises, and the
 * one in force is worth reading before you type. The sentence under them says
 * what the choice means in words, since "private" is a claim Margin makes about
 * its own behaviour and a claim should be legible.
 */
export function VisibilityToggle({
  value,
  onChange,
  disabled = false,
  disabledReason,
}: {
  value: Visibility;
  onChange: (visibility: Visibility) => void;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div
        role="radiogroup"
        aria-label="Who can see this"
        className="inline-flex self-start overflow-hidden rounded-sm border border-rule"
      >
        {(["private", "lab"] as const).map((option) => {
          const selected = value === option;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange(option)}
              className={
                "px-2.5 py-1 font-sans text-[11px] uppercase tracking-[0.12em] transition-colors " +
                (selected
                  ? "bg-accent text-accent-contrast"
                  : "text-ink-faint hover:text-ink-muted") +
                (disabled ? " cursor-not-allowed opacity-60" : "")
              }
            >
              {option === "private" ? "Private" : "Lab"}
            </button>
          );
        })}
      </div>
      <p className="font-sans text-xs leading-relaxed text-ink-faint">
        {disabled && disabledReason !== undefined
          ? disabledReason
          : value === "private"
            ? "Only you. Nobody in the lab sees this, including the PI."
            : "Everyone in the lab, in the margin beside this passage."}
      </p>
    </div>
  );
}
