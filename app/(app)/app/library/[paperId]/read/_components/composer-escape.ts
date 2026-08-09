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
 * What the DOM has to say about where an Escape landed, reduced to the three
 * facts the answer turns on.
 */
export type EscapeSurroundings = {
  /** The key landed inside the composer's own sheet. */
  insideComposer: boolean;
  /** It landed inside some other layer over the page. */
  insideSurface: boolean;
  /** A layer other than the composer's sheet is open somewhere in the page. */
  otherSurfaceOpen: boolean;
};

/**
 * Which surface an Escape belongs to.
 *
 * `otherSurfaceOpen` is the part a "was it pressed in something?" question
 * misses. Focus is not always in the thing on top: click the ⌘K palette's own
 * padding and focus falls to `<body>`, which sits under no layer at all — and
 * a composer that read that as "the page, therefore mine" would answer the
 * palette's Escape and leave the palette with no way out but the mouse.
 *
 * The composer's own sheet wins first, and deliberately so. Everything below
 * it is inferred from what happens to be in the document, and a wrong inference
 * there must not be able to stop Escape working inside the box somebody is
 * typing in — that failure is silent, and it is the one this whole ordering was
 * written to prevent.
 */
export function escapeBelongsTo(where: EscapeSurroundings): EscapePressedIn {
  if (where.insideComposer) {
    return "composer";
  }
  if (where.insideSurface || where.otherSurfaceOpen) {
    return "surface-above";
  }
  return "page";
}

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

/**
 * Whether a dismissal has to ask before it takes the note with it.
 *
 * Base UI dismisses a popover for several reasons and names each one. Escape
 * is the one this file already has an ordering for; the composer answers it
 * above and this is never asked about it. Everything else — an outside press,
 * focus leaving the sheet, a reason shipped in some later version — is a
 * dismissal the person writing did not ask for, and a half-written note must
 * not go quietly with it.
 *
 * Stated as "everything asks, except the one that is answered elsewhere"
 * rather than as a list of the reasons that ask, because the reason is a
 * string: a list would have to be right about names this file does not own,
 * and being wrong about one of them costs somebody their writing. `focus-out`
 * is exactly that mistake, already made once.
 *
 * `focus-out` now has an answer of its own too — see `composerFocusOut`, which
 * needs to know *where* focus went and this cannot. The row below stands as
 * the fallback for a focus-out that never reaches it, and it errs the same way
 * everything here errs: it asks.
 */
export function dismissalAsksFirst(reason: string, body: string): boolean {
  if (reason === "escape-key") {
    return false;
  }
  return body.trim().length > 0;
}

export type ComposerFocusOutAction =
  | "stay"
  | "cancel-silently"
  | "ask-before-discarding"
  | "close";

/**
 * What it means when focus leaves the sheet.
 *
 * This was inverted in both directions at once, which is what made it one bug
 * rather than two. Tab-walking out of a composer with half a paragraph in it
 * reached `<body>` and never raised the question — the note survived, but
 * silently, and nothing told the reader the sheet was no longer theirs. And
 * pressing ⌘K raised "Throw this note away?" merely because focus had moved
 * into the palette, so the question arrived over a note nobody was leaving and
 * the next Escape spent itself taking it back.
 *
 * The rule is the one `escapeBelongsTo` already states, applied to focus
 * instead of to a key press: **the innermost open surface owns what just
 * happened.** Focus moving into another surface is not the reader abandoning
 * the note, it is a layer arriving on top of it — nothing to ask about, and
 * the draft stays exactly where it is. Focus leaving to the page underneath is
 * the reader walking away, and a note with writing in it does not go quietly.
 *
 * Taking `EscapePressedIn` rather than a type of its own is the point: one
 * reading of "where is this happening" answers both keys and focus, so the two
 * cannot drift apart.
 */
export function composerFocusOut(
  landedIn: EscapePressedIn,
  body: string,
): ComposerFocusOutAction {
  if (landedIn === "composer") {
    // Moving between the box and the chips is not leaving.
    return "stay";
  }
  if (landedIn === "surface-above") {
    return "cancel-silently";
  }
  return body.trim().length > 0 ? "ask-before-discarding" : "close";
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
