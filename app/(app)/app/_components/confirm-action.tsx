"use client";

import { useState } from "react";

/**
 * Destructive actions are quiet text, not red buttons — but they arm before
 * they fire, so nothing irreversible is ever one stray click away.
 *
 * Two tones, because "quiet" means different things in the two places this is
 * used. On the lab page a destructive action sits in a list of links and reads
 * as one of them. In a margin card it sits under a note the reader is trying
 * to look past, where `Reply` and `Edit` are already faint and the last thing
 * that should be the loudest word on the card is the one that removes it.
 * Either way the armed state gains contrast rather than colour.
 *
 * Two sizes for the same reason: `xs` beside chrome, `sm` beside prose.
 */
const disabledClass = "disabled:cursor-not-allowed disabled:opacity-50";

const toneClass = {
  accent: {
    idle: `text-accent underline-offset-4 hover:underline ${disabledClass}`,
    armed: `font-medium text-accent-strong underline underline-offset-4 ${disabledClass}`,
  },
  faint: {
    idle: `text-ink-faint underline-offset-4 hover:text-ink-muted hover:underline ${disabledClass}`,
    armed: `font-medium text-ink underline underline-offset-4 ${disabledClass}`,
  },
} as const;

const sizeClass = { xs: "text-xs", sm: "text-sm" } as const;

/**
 * A two-step affordance for anything that can't be undone: the first click
 * arms it, the second one commits.
 *
 * `confirmLabel` is the whole point of the pattern and should restate what is
 * about to happen rather than say "Confirm" — it is the only sentence anyone
 * reads before the thing is gone.
 */
export function ConfirmAction({
  label,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "accent",
  size = "xs",
  disabled = false,
  run,
}: {
  label: string;
  confirmLabel: string;
  /**
   * Only worth setting where the surrounding UI already has a Cancel — an
   * armed note card has one for the edit it is sitting inside, and two
   * controls with the same accessible name in the same card is a coin toss
   * for anyone not looking at it.
   */
  cancelLabel?: string;
  tone?: keyof typeof toneClass;
  size?: keyof typeof sizeClass;
  disabled?: boolean;
  run: () => Promise<void>;
}) {
  const [armed, setArmed] = useState(false);
  const [pending, setPending] = useState(false);
  const classes = toneClass[tone];
  const scale = sizeClass[size];

  if (!armed) {
    return (
      <button
        type="button"
        disabled={disabled}
        className={`font-sans ${scale} ${classes.idle} tap-target`}
        onClick={() => setArmed(true)}
      >
        {label}
      </button>
    );
  }

  return (
    // The armed pair settles in rather than teleporting into the row: the
    // question deserves the reader's eye, and the entrance is what brings it.
    <span className="pop-in flex items-baseline gap-3">
      <button
        type="button"
        disabled={disabled || pending}
        className={`font-sans ${scale} ${classes.armed} tap-target`}
        onClick={async () => {
          setPending(true);
          try {
            await run();
          } finally {
            setPending(false);
            setArmed(false);
          }
        }}
      >
        {pending ? "Working…" : confirmLabel}
      </button>
      <button
        type="button"
        disabled={pending}
        className={`font-sans ${scale} ${classes.idle} tap-target`}
        onClick={() => setArmed(false)}
      >
        {cancelLabel}
      </button>
    </span>
  );
}
