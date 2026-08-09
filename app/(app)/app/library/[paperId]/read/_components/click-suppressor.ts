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
 * Two ways out, and both matter:
 *
 * - the click itself removes the listener, so one gesture buys one swallow;
 * - the next `pointerdown` removes it too, so a drag that somehow never
 *   produces its click cannot leave a trap behind that eats a genuine outside
 *   press an hour later. `pointerdown` opens every gesture, so the stale
 *   listener is gone before the click that would have hit it.
 *
 * Written against the two methods it actually uses rather than against
 * `Document`, so the lifecycle above can be tested without a DOM.
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
 * Swallow the next click, once.
 *
 * Returns the same teardown the listeners call on themselves, so a component
 * unmounting mid-gesture takes its listener with it.
 */
export function suppressNextClick(host: ListenerHost): () => void {
  let armed = true;

  const disarm = () => {
    if (!armed) {
      return;
    }
    armed = false;
    host.removeEventListener("click", onClick, true);
    host.removeEventListener("pointerdown", onPointerDown, true);
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
  return disarm;
}
