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
