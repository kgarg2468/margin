/**
 * Shared control classes.
 *
 * These live in one place so the sign-in page and the app shell cannot drift
 * apart, and so every control keeps referencing the semantic tokens from
 * `app/globals.css` rather than raw colour. Chrome is sans; anything you read
 * or write is serif.
 *
 * Two grammars run through all of it, both inherited from the landing page:
 * shadows come from the elevation tokens (`--shadow-card` / `-lift` /
 * `-sheet`) and never from literals, and anything pressable acknowledges the
 * press — colours ease over 200ms and the control gives a hair under the
 * finger. Both are motion-safe; reduced motion keeps the colour changes and
 * loses the movement.
 */

/** The press grammar every button shares. */
const pressable =
  "motion-safe:transition-[color,background-color,border-color,transform] " +
  "motion-safe:duration-200 motion-safe:active:scale-[0.98] transition-colors";

export const labelClass =
  "font-sans text-xs uppercase tracking-[0.14em] text-ink-faint";

export const inputClass =
  "w-full rounded-sm border border-rule bg-surface px-3 py-2 font-sans text-sm text-ink " +
  "placeholder:text-ink-faint transition-colors hover:border-ink-faint";

/** What gets written is read later: notes are set in serif, like the paper. */
export const textareaClass =
  "w-full resize-none rounded-sm border border-rule bg-surface px-3 py-2 font-serif text-sm " +
  "leading-relaxed text-ink placeholder:text-ink-faint transition-colors hover:border-ink-faint";

/**
 * A native select in the notebook's chrome: the OS arrow is replaced with a
 * quiet chevron (one mid-tone that reads on both grounds — a background
 * image cannot follow `light-dark()`), and the option list stays native,
 * which `color-scheme` already themes.
 */
export const selectClass =
  inputClass +
  " appearance-none pr-9 bg-[position:right_0.65rem_center] bg-no-repeat " +
  'bg-[image:url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20width=%2710%27%20height=%276%27%3E%3Cpath%20d=%27M1%201l4%204%204-4%27%20stroke=%27%238a7a6c%27%20stroke-width=%271.5%27%20fill=%27none%27%20stroke-linecap=%27round%27/%3E%3C/svg%3E")]';

export const primaryButtonClass =
  "inline-flex items-center justify-center rounded-sm bg-accent px-4 py-2 font-sans text-sm " +
  `text-accent-contrast hover:bg-accent-strong ${pressable} ` +
  "disabled:cursor-not-allowed disabled:opacity-50";

export const secondaryButtonClass =
  "inline-flex items-center justify-center rounded-sm border border-rule bg-surface px-4 py-2 " +
  `font-sans text-sm text-ink hover:border-ink-faint ${pressable} ` +
  "disabled:cursor-not-allowed disabled:opacity-50";

export const linkButtonClass =
  "font-sans text-sm text-accent underline-offset-4 hover:underline";

/** A sheet resting on the desk. */
export const cardClass =
  "rounded-md border border-rule bg-surface p-6 shadow-[var(--shadow-card)]";

/**
 * A sheet that has just been put down: a card plus the entrance the app's
 * small surfaces share. For panels that appear on demand — an add-paper
 * form, a reschedule sheet — not for anything present from first paint.
 */
export const panelClass = `${cardClass} pop-in`;

/**
 * A block of what-is-coming: sunken, shaped like the content, breathing
 * slowly (see `margin-breathe`). Size it with width/height utilities.
 */
export const skeletonClass =
  "rounded-sm bg-surface-sunken " +
  "motion-safe:animate-[margin-breathe_1.8s_ease-in-out_infinite]";

/** An erratum in the margin: a rule down the left, plain ink, no shouting. */
export const errorClass =
  "border-l-2 border-accent-strong pl-3 font-sans text-sm text-ink";

/** A state marker in the chrome typeface: a librarian's pencil note, not a badge. */
export const chipClass =
  "inline-flex items-center rounded-sm border border-rule px-1.5 py-0.5 " +
  "font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint";

export const eyebrowClass =
  "font-sans text-xs font-medium uppercase tracking-[0.18em] text-ink-faint";

/**
 * A key, drawn as a key: the brass label on a catalogue drawer rather than a
 * badge. Used for the ⌘K affordance in the rail and for the legend along the
 * bottom of the palette, which is why it lives here and not in either of them.
 *
 * Not `chipClass`: a chip states a fact about a thing on the page, a keycap
 * names something you can press. Tabular figures and a hair of extra tracking
 * so `⌘K` and `esc` sit at the same optical weight.
 */
export const keycapClass =
  "inline-flex min-w-5 items-center justify-center rounded-[3px] border border-rule " +
  "bg-surface-sunken px-1.5 py-0.5 font-sans text-[10px] tabular-nums " +
  "tracking-[0.06em] text-ink-faint";
