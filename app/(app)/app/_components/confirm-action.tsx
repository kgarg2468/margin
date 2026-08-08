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
 */
const toneClass = {
  accent: {
    idle:
      "font-sans text-xs text-accent underline-offset-4 hover:underline " +
      "disabled:cursor-not-allowed disabled:opacity-50",
    armed:
      "font-sans text-xs font-medium text-accent-strong underline underline-offset-4 " +
      "disabled:cursor-not-allowed disabled:opacity-50",
  },
  faint: {
    idle:
      "font-sans text-xs text-ink-faint underline-offset-4 hover:text-ink-muted " +
      "hover:underline disabled:cursor-not-allowed disabled:opacity-50",
    armed:
      "font-sans text-xs font-medium text-ink underline underline-offset-4 " +
      "disabled:cursor-not-allowed disabled:opacity-50",
  },
} as const;

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
  tone = "accent",
  disabled = false,
  run,
}: {
  label: string;
  confirmLabel: string;
  tone?: keyof typeof toneClass;
  disabled?: boolean;
  run: () => Promise<void>;
}) {
  const [armed, setArmed] = useState(false);
  const [pending, setPending] = useState(false);
  const classes = toneClass[tone];

  if (!armed) {
    return (
      <button
        type="button"
        disabled={disabled}
        className={`${classes.idle} tap-target`}
        onClick={() => setArmed(true)}
      >
        {label}
      </button>
    );
  }

  return (
    <span className="flex items-baseline gap-3">
      <button
        type="button"
        disabled={disabled || pending}
        className={`${classes.armed} tap-target`}
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
        className={`${classes.idle} tap-target`}
        onClick={() => setArmed(false)}
      >
        Cancel
      </button>
    </span>
  );
}
