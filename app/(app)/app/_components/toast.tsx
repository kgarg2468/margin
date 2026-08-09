"use client";

import { createToastStore } from "@/lib/toast-store";
import type { Toast, ToastInput } from "@/lib/toast-store";
import { errorClass, linkButtonClass } from "@/lib/ui";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";

/**
 * The app's one interruption, and the place undo lives.
 *
 * Margin's destructive actions arm before they fire (`ConfirmAction`), but the
 * ordinary ones — archiving a paper, deleting a note you meant to keep — should
 * not each grow a confirmation step. The alternative is to let them happen and
 * hand back the way out for a few seconds, which is what the `action` on a
 * toast is for. That is why the queue is a shared layer rather than per-page
 * state: the undo has to outlive whatever surface was clicked, including a
 * surface that unmounted itself on the way out.
 *
 * The rules about how many toasts and how long they stay are in
 * `lib/toast-store.ts`, under test. What is left here is the rendering — and
 * the one thing React has to do that the store cannot: hold a departed toast on
 * screen long enough for it to fade.
 */

type ToastStore = ReturnType<typeof createToastStore>;

const ToastContext = createContext<((input: ToastInput) => void) | null>(null);

/**
 * How long a leaving toast is kept mounted, matching `--dur-exit` — the CSS
 * below is what actually draws the fade, this is only the deadline for taking
 * the node out of the tree. Exits are shorter than entrances everywhere in the
 * app: leaving should not make you wait.
 */
const EXIT_MS = 120;

/** A stable empty list, so the pre-subscription snapshot never re-renders. */
const NONE: Toast[] = [];

export function ToastProvider({ children }: { children: ReactNode }) {
  // One store per mounted provider, created lazily and never replaced — the
  // timers in it are the toasts' lifetimes, so a store that got rebuilt on a
  // re-render would silently strand every notice on screen.
  const [store] = useState(createToastStore);

  // The public surface is deliberately narrower than the store's: a caller
  // announces something, it does not manage it. Dismissal is the reader's,
  // or the clock's.
  const push = useCallback(
    (input: ToastInput) => {
      store.push(input);
    },
    [store],
  );

  return (
    <ToastContext.Provider value={push}>
      {children}
      <ToastViewport store={store} />
    </ToastContext.Provider>
  );
}

export function useToast(): (input: ToastInput) => void {
  const push = useContext(ToastContext);
  if (push === null) {
    throw new Error("useToast must be used inside the /app layout.");
  }
  return push;
}

function ToastViewport({ store }: { store: ToastStore }) {
  const live = useLiveToasts(store);

  // A toast that has left the store still has 120ms of fading to do, so what
  // is on screen is the union: the queue, plus whoever just left it. Both ways
  // out — the ✕ and the store's own timer — land here, so there is one exit
  // animation rather than one per way of leaving.
  //
  // The union is worked out *during* render rather than in an effect, and that
  // is the whole trick. An effect commits one render too late: React would
  // paint the card gone, then put a fresh one back wearing `data-leaving`, and
  // a node that is inserted already transparent has no previous opacity to
  // travel from — measured, it snapped to 0 and left an invisible card sitting
  // there for 120ms. Keeping the same element across the commit is what turns
  // the attribute flip into a fade.
  const [shown, setShown] = useState<Toast[]>(live);
  const [previousLive, setPreviousLive] = useState<Toast[]>(live);

  let rendered = shown;
  if (previousLive !== live) {
    const departed = shown.filter(
      (toast) => !live.some((t) => t.id === toast.id),
    );
    // Sorted by id, which is chronological: a toast on its way out keeps the
    // place it had rather than jumping to the end of the stack as it fades.
    rendered = [...live, ...departed].sort((a, b) => a.id - b.id);
    setPreviousLive(live);
    setShown(rendered);
  }

  const forget = useCallback((id: number) => {
    setShown((current) => current.filter((toast) => toast.id !== id));
  }, []);

  return (
    // Bottom right, out of the reading column. `pointer-events-none` on the
    // stack itself so the gaps between cards — and the box a one-toast stack
    // still occupies — never eat a click meant for the page underneath.
    //
    // Rendered even when there is nothing to show, which is not a detail: the
    // live region below has to be in the document *before* the text it is
    // going to announce, and a viewport that unmounted itself when the stack
    // emptied would take it with it.
    // Above the dialogs, not level with them: Base UI portals a popup to the
    // end of <body> at z-50, so a toast sharing that layer loses on source
    // order and fades in behind whatever sheet is open. The one flow that
    // needs a toast most — confirm, then undo — is exactly the flow with a
    // dialog on screen when it fires.
    <div className="pointer-events-none fixed right-6 bottom-6 z-[60] flex max-w-[calc(100vw-3rem)] flex-col gap-2">
      <Announcer toasts={live} />
      {rendered.map((toast) => (
        <ToastCard
          key={toast.id}
          toast={toast}
          leaving={!live.some((t) => t.id === toast.id)}
          onDismiss={() => store.dismiss(toast.id)}
          onGone={forget}
        />
      ))}
    </div>
  );
}

function ToastCard({
  toast,
  leaving,
  onDismiss,
  onGone,
}: {
  toast: Toast;
  leaving: boolean;
  onDismiss: () => void;
  onGone: (id: number) => void;
}) {
  // The unmount is owned by the card that is fading rather than by a timer in
  // the viewport: this effect's cleanup only runs when *this* card goes, so a
  // toast pushed mid-fade cannot cancel someone else's removal and leave an
  // invisible card sitting in the tree forever.
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => onGone(toast.id), EXIT_MS);
    return () => clearTimeout(timer);
  }, [leaving, onGone, toast.id]);

  const isError = toast.tone === "error";

  return (
    <div
      // An error is worth interrupting a screen reader for, so it carries the
      // assertive role on the card itself; an `alert` is announced reliably
      // even when the element carrying it was only just inserted. Everything
      // quieter is announced politely by `Announcer`, and so takes no role
      // here — two live regions for one message would say it twice.
      //
      // Visually the two are the same card: the tone is carried by the rule
      // down the left, not by colour or by an icon.
      role={isError ? "alert" : undefined}
      data-leaving={leaving ? "" : undefined}
      className={
        "pointer-events-auto pop-in w-full max-w-sm rounded-md border border-rule bg-surface " +
        "px-4 py-3 shadow-[var(--shadow-sheet)] transition-opacity duration-[var(--dur-exit)] " +
        // Opacity alone on the way out: the entrance can afford to travel,
        // the exit is over before a translation would read as anything but a
        // twitch. `animate-none` cancels a still-running `pop-in` so a toast
        // dismissed in its first frames fades rather than snapping.
        "ease-out data-[leaving]:pointer-events-none data-[leaving]:animate-none data-[leaving]:opacity-0"
      }
    >
      <div className="flex items-start gap-4">
        <p className={isError ? errorClass : "font-sans text-sm text-ink"}>
          {toast.message}
        </p>
        <div className="ml-auto flex shrink-0 items-center gap-4">
          {toast.action ? (
            <button
              type="button"
              className={`${linkButtonClass} tap-target`}
              onClick={() => {
                toast.action?.onAction();
                onDismiss();
              }}
            >
              {toast.action.label}
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Dismiss"
            className="pressable tap-target font-sans text-sm text-ink-faint hover:text-ink-muted"
            onClick={onDismiss}
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * What a screen reader hears.
 *
 * A toast card is inserted into the page already carrying its text, and a
 * polite live region that is *created* with its content is one NVDA and JAWS
 * routinely miss — the region has to be there first, so that what changes is
 * the text inside it and not the region itself. So this sits in the viewport
 * permanently, empty, and the messages are written into it.
 *
 * Errors do not come through here; they are `role="alert"` on the card, which
 * is assertive and is announced on insertion (see `ToastCard`).
 */
function Announcer({ toasts }: { toasts: Toast[] }) {
  const [announcement, setAnnouncement] = useState("");
  const announced = useRef(0);

  useEffect(() => {
    const fresh = toasts.filter(
      (toast) => toast.id > announced.current && toast.tone !== "error",
    );
    for (const toast of toasts) {
      announced.current = Math.max(announced.current, toast.id);
    }
    if (fresh.length > 0) {
      setAnnouncement(fresh.map((toast) => toast.message).join(". "));
    }
  }, [toasts]);

  // Emptied again once it has been read. A live region only announces what
  // *changed*, so without this the second "Saved" in a row is identical text
  // and is never spoken at all.
  useEffect(() => {
    if (announcement === "") return;
    const timer = setTimeout(() => setAnnouncement(""), 1000);
    return () => clearTimeout(timer);
  }, [announcement]);

  return (
    <div aria-live="polite" aria-atomic="true" className="sr-only">
      {announcement}
    </div>
  );
}

/**
 * The store's list, as React state.
 *
 * `useSyncExternalStore` wants a snapshot it can read during render, and the
 * store deliberately has no getter — subscribing *is* how you read it, since
 * `subscribe` hands over the current list on the spot. So the listener keeps
 * the latest list in a ref and that ref is the snapshot: stable between emits,
 * a new array on every one, which is exactly the identity contract the hook
 * checks against.
 */
function useLiveToasts(store: ToastStore): Toast[] {
  const snapshot = useRef<Toast[]>(NONE);
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      store.subscribe((toasts) => {
        snapshot.current = toasts;
        onStoreChange();
      }),
    [store],
  );

  return useSyncExternalStore(
    subscribe,
    () => snapshot.current,
    // Nothing has been pushed on the server, and a toast is a reaction to
    // something the reader did, so the first paint is always an empty stack.
    () => NONE,
  );
}
