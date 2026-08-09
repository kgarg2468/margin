import { describe, expect, it, vi } from "vitest";
import { runWithFeedback } from "./use-feedback-mutation";

describe("runWithFeedback", () => {
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
});
