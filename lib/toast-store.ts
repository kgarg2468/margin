/**
 * The queue behind the toasts, with no React in it.
 *
 * A toast is the app's only interruption, so the rules about how many there
 * are and how long they stay are the part worth being sure of — and they are
 * exactly the part a browser cannot show you, because the failure is a stack
 * of six notices at 3am or an undo that expired before it was read. So the
 * rules live here, as a plain store over a list and a bag of timers, and the
 * component in `app/(app)/app/_components/toast.tsx` is left with nothing but
 * rendering.
 */

export type ToastInput = {
  message: string;
  tone?: "default" | "error";
  /** The undo half of "undo": a label and the work to put it back. */
  action?: { label: string; onAction: () => void };
  durationMs?: number;
};
export type Toast = ToastInput & { id: number };

/**
 * How long a toast is worth. An error is a sentence you have to read and
 * usually act on; a confirmation is one you glance at, so it leaves first.
 */
const DURATION: Record<"default" | "error", number> = {
  default: 5000,
  error: 8000,
};

/**
 * Three at once, oldest dropped. Past three the stack stops being a notice
 * and becomes a wall over the corner of the page — and nobody reads the
 * fourth one anyway.
 */
const MAX_VISIBLE = 3;

export function createToastStore() {
  let toasts: Toast[] = [];
  let nextId = 1;
  const listeners = new Set<(toasts: Toast[]) => void>();
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  const emit = () => listeners.forEach((fn) => fn(toasts));

  const dismiss = (id: number) => {
    const timer = timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(id);
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  };

  const push = (input: ToastInput) => {
    const id = nextId++;
    // The overflow is dropped by the same expression that adds the newcomer,
    // so there is no window in which four are live: whoever reads the next
    // emit sees at most three.
    toasts = [...toasts, { ...input, id }].slice(-MAX_VISIBLE);
    const ms = input.durationMs ?? DURATION[input.tone ?? "default"];
    timers.set(id, setTimeout(() => dismiss(id), ms));
    emit();
    return id;
  };

  return {
    push,
    dismiss,
    /**
     * Subscribing hands you the list as it stands right now, before anything
     * else happens — a late subscriber is the normal case (a provider mounts
     * after a push during hydration) and it should not have to wait for the
     * next toast to find out there are already two on screen. It also means
     * the only way to read the queue is to subscribe to it, which is why the
     * store needs no getter.
     */
    subscribe(fn: (toasts: Toast[]) => void): () => void {
      listeners.add(fn);
      fn(toasts);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
