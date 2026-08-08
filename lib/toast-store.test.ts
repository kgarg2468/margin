import { describe, expect, it, vi } from "vitest";
import { createToastStore } from "./toast-store";

describe("toast store", () => {
  it("pushes and notifies subscribers", () => {
    const store = createToastStore();
    const seen: unknown[] = [];
    store.subscribe((toasts) => seen.push(toasts.map((t) => t.message)));
    store.push({ message: "Saved" });
    expect(seen.at(-1)).toEqual(["Saved"]);
  });

  it("dismisses by id", () => {
    const store = createToastStore();
    const id = store.push({ message: "One" });
    store.dismiss(id);
    let current: unknown;
    store.subscribe((toasts) => (current = toasts));
    expect(current).toEqual([]);
  });

  it("caps visible toasts at three, dropping the oldest", () => {
    const store = createToastStore();
    ["a", "b", "c", "d"].forEach((message) => store.push({ message }));
    let current: { message: string }[] = [];
    store.subscribe((toasts) => (current = toasts));
    expect(current.map((t) => t.message)).toEqual(["b", "c", "d"]);
  });

  it("forgets the timer of a toast the cap dropped", () => {
    vi.useFakeTimers();
    const store = createToastStore();
    // "a" is dropped by the cap half a second before its own timer would have
    // fired; that timer must go with it, or it wakes up later and emits for a
    // toast that has not been on screen since.
    store.push({ message: "a", durationMs: 1000 });
    ["b", "c", "d"].forEach((message) =>
      store.push({ message, durationMs: 9000 }),
    );

    let emissions = 0;
    store.subscribe(() => emissions++);
    expect(emissions).toBe(1); // the list as it stands on subscription

    vi.advanceTimersByTime(1500);
    expect(emissions).toBe(1);
    vi.useRealTimers();
  });

  it("auto-dismisses after the tone's duration", () => {
    vi.useFakeTimers();
    const store = createToastStore();
    store.push({ message: "gone", tone: "default" });
    vi.advanceTimersByTime(5001);
    let current: unknown[] = [{}];
    store.subscribe((toasts) => (current = toasts));
    expect(current).toEqual([]);
    vi.useRealTimers();
  });
});
