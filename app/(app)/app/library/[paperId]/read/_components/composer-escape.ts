/**
 * What Escape means in the composer, which depends entirely on what is on top.
 *
 * There used to be no answer to this — the composer bound a bubble-phase
 * `document` listener that closed itself on any Escape at all, and the mention
 * menu tried to defend against it with `stopPropagation`, which in React 19's
 * App Router stops nothing: the framework's delegated listener and the
 * composer's are siblings on the same node. So dismissing the roster threw away
 * the note under it, and there was no undo.
 *
 * Stated here as a function of what is open, so the order is a decision that
 * can be read and argued with rather than an accident of which effect ran
 * first. Innermost thing first, and a draft is never discarded without being
 * asked about.
 */

export type ComposerEscapeState = {
  /** The `@` roster is showing suggestions. */
  menuOpen: boolean;
  /** "Discard this note?" is already on screen. */
  confirming: boolean;
  /** What is in the note body right now. */
  body: string;
};

export type ComposerEscapeAction =
  | "close-menu"
  | "cancel-confirm"
  | "ask-before-discarding"
  | "close";

/**
 * Where an Escape was pressed, relative to the composer's sheet.
 *
 * `"page"` is the interesting one: the key was pressed with nothing layered
 * over the reader — focus on the body after an outside press, say — and that is
 * still the composer's to answer for, because it is the topmost thing open.
 */
export type EscapePressedIn = "composer" | "surface-above" | "page";

/**
 * Whether this Escape is the composer's to interpret at all.
 *
 * Asked before `composerEscape`, and it exists because Base UI's dismissal is a
 * bubble-phase listener on `document` with no target check: an Escape pressed
 * anywhere reaches the composer, and Base UI stops the event there whether or
 * not the dismissal was cancelled. So a composer that answered every Escape
 * would swallow the one meant for the ⌘K palette above it — the palette's own
 * listener sits on `window`, one bubble further out, and would never run again.
 *
 * The rule is the same one `composerEscape` states for the roster, one layer
 * up: the innermost open thing wins. What it is emphatically not is "was the
 * key pressed inside my sheet" — that answer strands a composer whose focus has
 * moved to the page.
 */
export function composerHandlesEscape(pressedIn: EscapePressedIn): boolean {
  return pressedIn !== "surface-above";
}

export function composerEscape(state: ComposerEscapeState): ComposerEscapeAction {
  if (state.menuOpen) {
    return "close-menu";
  }
  if (state.confirming) {
    return "cancel-confirm";
  }
  if (state.body.trim().length > 0) {
    return "ask-before-discarding";
  }
  return "close";
}
