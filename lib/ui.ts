/**
 * Shared control classes.
 *
 * These live in one place so the sign-in page and the app shell cannot drift
 * apart, and so every control keeps referencing the semantic tokens from
 * `app/globals.css` rather than raw colour. Chrome is sans; anything you read
 * or write is serif.
 */

export const labelClass =
  "font-sans text-xs uppercase tracking-[0.14em] text-ink-faint";

export const inputClass =
  "w-full rounded-sm border border-rule bg-surface px-3 py-2 font-sans text-sm text-ink " +
  "placeholder:text-ink-faint hover:border-ink-faint";

export const primaryButtonClass =
  "inline-flex items-center justify-center rounded-sm bg-accent px-4 py-2 font-sans text-sm " +
  "text-accent-contrast transition-colors hover:bg-accent-strong " +
  "disabled:cursor-not-allowed disabled:opacity-50";

export const secondaryButtonClass =
  "inline-flex items-center justify-center rounded-sm border border-rule bg-surface px-4 py-2 " +
  "font-sans text-sm text-ink transition-colors hover:border-ink-faint " +
  "disabled:cursor-not-allowed disabled:opacity-50";

export const linkButtonClass =
  "font-sans text-sm text-accent underline-offset-4 hover:underline";

export const cardClass = "rounded-md border border-rule bg-surface p-6";

/** An erratum in the margin: a rule down the left, plain ink, no shouting. */
export const errorClass =
  "border-l-2 border-accent-strong pl-3 font-sans text-sm text-ink";

/** A state marker in the chrome typeface: a librarian's pencil note, not a badge. */
export const chipClass =
  "inline-flex items-center rounded-sm border border-rule px-1.5 py-0.5 " +
  "font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint";

export const eyebrowClass =
  "font-sans text-xs font-medium uppercase tracking-[0.18em] text-ink-faint";
