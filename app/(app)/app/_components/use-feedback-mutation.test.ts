import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithFeedback } from "./use-feedback-mutation";

describe("runWithFeedback", () => {
  // Every failing case below logs the real error on purpose, so the console is
  // stubbed rather than left to scribble over the suite's output — and the stub
  // doubles as the assertion that the logging happens at all.
  let logged: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logged = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logged.mockRestore();
  });

  it("returns the mutation result on success and stays silent", async () => {
    const toast = vi.fn();
    const result = await runWithFeedback(() => Promise.resolve("id123"), {
      errorMessage: "Couldn't save",
      toast,
    });
    expect(result).toBe("id123");
    expect(toast).not.toHaveBeenCalled();
  });

  it("toasts and reports rollback on failure instead of throwing", async () => {
    const toast = vi.fn();
    const onRolledBack = vi.fn();
    const result = await runWithFeedback(
      () => Promise.reject(new Error("server")),
      { errorMessage: "Couldn't save", toast, onRolledBack },
    );
    expect(result).toBeUndefined();
    expect(onRolledBack).toHaveBeenCalledOnce();
    expect(toast).toHaveBeenCalledWith({
      message: "Couldn't save",
      tone: "error",
    });
  });

  // The bad-optimistic-update case. Convex does not catch a throwing
  // `optimisticUpdate`; it comes back out of the mutation call, and because
  // `withOptimistic(args)` is invoked *inside* `run`, it can arrive as a
  // synchronous throw rather than a rejected promise. Same treatment either
  // way, and the log is the only trace of the actual bug.
  it("survives a synchronous throw and still leaves a trace", async () => {
    const toast = vi.fn();
    const onRolledBack = vi.fn();
    const boom = new Error("cannot read properties of undefined");
    const result = await runWithFeedback(
      () => {
        throw boom;
      },
      { errorMessage: "Couldn't save", toast, onRolledBack },
    );
    expect(result).toBeUndefined();
    expect(onRolledBack).toHaveBeenCalledOnce();
    expect(toast).toHaveBeenCalledWith({
      message: "Couldn't save",
      tone: "error",
    });
    expect(logged).toHaveBeenCalledWith("Mutation failed:", boom);
  });

  it("prefers a mutation's own refusal to the caller's fallback copy", async () => {
    const toast = vi.fn();
    const result = await runWithFeedback(
      () =>
        Promise.reject(
          new ConvexError("Only the person who wrote a note can change it."),
        ),
      { errorMessage: "Couldn't save your note", toast },
    );
    expect(result).toBeUndefined();
    expect(toast).toHaveBeenCalledWith({
      message: "Only the person who wrote a note can change it.",
      tone: "error",
    });
  });

  it("falls back to the caller's copy when the error carries no sentence", async () => {
    const toast = vi.fn();
    await runWithFeedback(() => Promise.reject(new Error("Server Error")), {
      errorMessage: "Couldn't save your note",
      toast,
    });
    expect(toast).toHaveBeenCalledWith({
      message: "Couldn't save your note",
      tone: "error",
    });
  });

  // Order matters on screen: the draft is back in the composer before the
  // notice about it appears, so the toast is read against a page that has
  // stopped moving.
  it("restores before it announces", async () => {
    const calls: string[] = [];
    await runWithFeedback(() => Promise.reject(new Error("server")), {
      errorMessage: "Couldn't save",
      toast: () => calls.push("toast"),
      onRolledBack: () => calls.push("onRolledBack"),
    });
    expect(calls).toEqual(["onRolledBack", "toast"]);
  });
});
