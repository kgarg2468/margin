"use client";

import { keycapClass } from "@/lib/ui";

/**
 * The library's keys, and the small brass label that says what they are.
 *
 * A shortcut nobody has been told about is a feature that does not exist — the
 * same argument the ⌘K affordance in the rail is built on, applied to a page
 * where the keys are single letters and therefore even less guessable. So the
 * list is one keystroke away (`?`), the affordance that opens it carries the
 * key that opens it, and every control the keys duplicate names its own key in
 * a `title`.
 *
 * Deliberately not a modal: it is a legend, and a legend that takes the page
 * hostage while you read it is a legend you close before you have used the
 * thing it describes.
 */

/** Single letters only, and never with a modifier — ⌘K belongs to the palette. */
export const libraryShortcuts: { keys: string[]; does: string }[] = [
  { keys: ["/"], does: "jump to the filter box" },
  { keys: ["↑", "↓"], does: "move down the shelf" },
  { keys: ["↵"], does: "open the marked paper" },
  { keys: ["t"], does: "tag and shelve the marked paper" },
  { keys: ["a"], does: "add a paper" },
  { keys: ["esc"], does: "put it all away" },
];

export function ShortcutHint({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="relative flex flex-col items-end">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls="library-shortcuts"
        title="Keyboard shortcuts (?)"
        className={`${keycapClass} tap-target hover:border-ink-faint hover:text-ink-muted`}
      >
        ?
      </button>

      {open && (
        <dl
          id="library-shortcuts"
          className="pop-in absolute top-8 right-0 z-20 flex w-60 flex-col gap-1.5 rounded-md border border-rule bg-surface p-4 shadow-[var(--shadow-lift)]"
        >
          {libraryShortcuts.map(({ keys, does }) => (
            <div key={does} className="flex items-baseline gap-2">
              <dt className="flex shrink-0 gap-1">
                {keys.map((key) => (
                  <kbd key={key} className={keycapClass}>
                    {key}
                  </kbd>
                ))}
              </dt>
              <dd className="font-sans text-xs text-ink-muted">{does}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
