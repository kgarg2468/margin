"use client";

import type { AnnotationType } from "./ontology";
import { ANNOTATION_TYPES } from "./ontology";

/**
 * The ontology as a row of chips.
 *
 * Typing is one tap and never required, so `note` sits first and is already
 * chosen — a member who ignores this row still gets a perfectly good
 * annotation. The chip carries its type's ink at the size the margin will use
 * it, which is the only way to learn the palette: by having chosen from it.
 */
export function TypeChips({
  value,
  onChange,
  size = "regular",
}: {
  value: AnnotationType;
  onChange: (type: AnnotationType) => void;
  size?: "regular" | "small";
}) {
  return (
    <div
      // Room between the rows for hit boxes that are taller than the chips.
      className="flex flex-wrap gap-x-1.5 gap-y-2"
      role="radiogroup"
      aria-label="Note type"
    >
      {ANNOTATION_TYPES.map((style) => {
        const selected = style.value === value;
        return (
          <button
            key={style.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(style.value)}
            style={{
              color: selected ? style.ink : undefined,
              borderColor: selected ? style.ink : undefined,
              background: selected ? style.wash : undefined,
            }}
            className={
              "tap-target rounded-sm border px-1.5 font-sans uppercase tracking-[0.1em] transition-colors " +
              (size === "small"
                ? "py-1 text-[9px] "
                : "py-1.5 text-[10px] ") +
              (selected
                ? "border-current"
                : "border-rule text-ink-faint hover:border-ink-faint hover:text-ink-muted")
            }
          >
            {style.label}
          </button>
        );
      })}
    </div>
  );
}
