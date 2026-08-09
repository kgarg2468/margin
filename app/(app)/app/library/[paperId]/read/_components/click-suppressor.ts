/**
 * The click at the end of a drag, which nobody asked for and which used to
 * close the note the same drag had just opened.
 *
 * A mouse drag over the text layer ends in `mouseup`, the reader turns that
 * selection into a draft, the composer mounts — and then the browser fires the
 * gesture's trailing `click` on the page underneath. Base UI reads it as an
 * outside press and dismisses the sheet, twelve milliseconds after it appeared.
 * Measured: `mouseup 845495 → composer added 845521 → click 845523 → composer
 * removed 845533`. So drag-to-annotate, the primary gesture of the whole
 * reader, did not work with a real pointer at all.
 *
 * The click is not a press on anything. It is the tail of a press that already
 * happened, before the composer existed, and the fix is to say so: swallow
 * exactly one click, in the capture phase, before any of the listeners that
 * would interpret it can run.
 *
 * Three ways out, and all of them matter:
 *
 * - the click itself removes the listener, so one gesture buys one swallow;
 * - the end of this turn of the event loop removes it, because the trailing
 *   click — when there is one — is dispatched synchronously after the mouseup,
 *   in this same turn. A drag whose mousedown and mouseup land on different
 *   elements fires **no** click at all, which is exactly the drag this is armed
 *   for; without this the listener would stay armed for as long as the reader
 *   kept their hands off the mouse, and then swallow the next click it saw.
 *   The one that would be — Enter or Space on "Save note", which dispatches a
 *   click with no pointer event anywhere near it — is a keystroke that would
 *   silently do nothing;
 * - the next `pointerdown` removes it too, which is belt and braces now but
 *   costs nothing and states the intent: this belongs to one gesture.
 *
 * Written against the methods it actually uses rather than against `Document`
 * and `setTimeout`, so the lifecycle above can be tested without a DOM and
 * without waiting.
 */

/** A click as this file needs to see it: something it can stop. */
export type StoppableEvent = {
  stopPropagation: () => void;
  stopImmediatePropagation: () => void;
};

/** `document`, reduced to the part of it that is a listener registry. */
export type ListenerHost = {
  // Method syntax rather than function properties, so a real `Document` — whose
  // listener parameter is the whole `Event` union — still satisfies this.
  addEventListener(
    type: string,
    listener: (event: StoppableEvent) => void,
    capture: boolean,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: StoppableEvent) => void,
    capture: boolean,
  ): void;
};

/**
 * Somewhere to put "at the end of this turn", handed in so a test can run the
 * turn itself. Returns the way to call it off.
 */
export type Defer = (run: () => void) => () => void;

const afterThisTurn: Defer = (run) => {
  const timer = setTimeout(run, 0);
  return () => clearTimeout(timer);
};

/**
 * Swallow the next click, once, and only if it arrives in this turn.
 *
 * Returns the same teardown the listeners call on themselves, so a component
 * unmounting mid-gesture takes its listener with it.
 */
export function suppressNextClick(
  host: ListenerHost,
  defer: Defer = afterThisTurn,
): () => void {
  let armed = true;
  let cancelTurnEnd: (() => void) | null = null;

  const disarm = () => {
    if (!armed) {
      return;
    }
    armed = false;
    host.removeEventListener("click", onClick, true);
    host.removeEventListener("pointerdown", onPointerDown, true);
    cancelTurnEnd?.();
    cancelTurnEnd = null;
  };

  const onClick = (event: StoppableEvent) => {
    disarm();
    // Both, and deliberately: `stopPropagation` alone leaves every other
    // listener already registered on `document` — Base UI's among them — to
    // run anyway, because they are siblings on the same node.
    event.stopPropagation();
    event.stopImmediatePropagation();
  };

  // A new gesture. Whatever this one's click turns out to mean, it is not the
  // tail of the drag that armed this.
  const onPointerDown = () => disarm();

  host.addEventListener("click", onClick, true);
  host.addEventListener("pointerdown", onPointerDown, true);
  const stopWaiting = defer(disarm);
  if (armed) {
    cancelTurnEnd = stopWaiting;
  } else {
    // A `defer` that ran its callback there and then. Nothing is armed any
    // more, and the timer it handed back is already spent.
    stopWaiting();
  }
  return disarm;
}
