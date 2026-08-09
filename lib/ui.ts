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
 * press — colours ease over `--dur-hover` and the control gives a hair under
 * the finger over `--dur-press`. The movement is motion-safe; reduced motion
 * keeps the colour changes and loses it.
 */

/** The press grammar every control shares — see `@utility pressable`. */
const pressable = "pressable";

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
 * A block of what-is-coming: sunken, shaped like the content, with a sheen
 * passing over it (see `skeleton-shimmer`). A sweep reads as a shorter wait
 * than a pulse does. Size it with width/height utilities; stagger a list by
 * setting `animationDelay` on the block, which the sheen inherits.
 */
export const skeletonClass = "rounded-sm bg-surface-sunken skeleton-shimmer";

/** An erratum in the margin: a rule down the left, plain ink, no shouting. */
export const errorClass =
  "border-l-2 border-accent-strong pl-3 font-sans text-sm text-ink";

/** A state marker in the chrome typeface: a librarian's pencil note, not a badge. */
export const chipClass =
  "inline-flex items-center rounded-sm border border-rule px-1.5 py-0.5 " +
  "font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint";

/** A chip that is a real control (filter chips, type toggles). */
export const chipButtonClass = `${chipClass} ${pressable} hover:border-ink-faint hover:text-ink-muted`;

export const eyebrowClass =
  "font-sans text-xs font-medium uppercase tracking-[0.18em] text-ink-faint";

/**
 * Whether the interaction that opened a surface came from the keyboard.
 *
 * The motion budget says keyboard-triggered surfaces render instantly (see
 * `docs/superpowers/specs/2026-08-08-product-feel-overhaul-design.md`): a
 * pointer takes time to arrive and the entrance covers that travel, but a
 * keystroke is instantaneous and an animation after it is just latency you
 * added yourself. Someone holding Tab through a form should not be watching
 * sheets bloom.
 *
 * The one piece of behaviour in a file of class strings, and it earns the
 * exception the same way they do: it is the single answer to a question three
 * separate surfaces ask — the popover, the confirm dialog and the select.
 * Its first home was `popover.tsx`, which quietly meant every route rendering
 * a confirm dialog pulled the whole Base UI popover in for ten lines. Nothing
 * here imports a framework, so nothing here can drag one along.
 *
 * Enter and Space on a focused button still dispatch a `click`, which is why
 * the `KeyboardEvent` check is not enough on its own; the browser marks those
 * synthesized clicks with a `detail` of `0`, which a real press never has.
 */
export function openedFromKeyboard(event: Event | undefined): boolean {
  if (event === undefined) {
    return false;
  }
  if (typeof KeyboardEvent !== "undefined" && event instanceof KeyboardEvent) {
    return true;
  }
  return (
    typeof MouseEvent !== "undefined" &&
    event instanceof MouseEvent &&
    event.detail === 0
  );
}
