"use client";

import type { OptimisticUpdate } from "convex/browser";
import { useMutation } from "convex/react";
import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
} from "convex/server";
import { useCallback, useMemo } from "react";
import type { ToastInput } from "@/lib/toast-store";
import { useToast } from "./toast";

/**
 * A mutation that shows its work, including when the work comes undone.
 *
 * Convex already handles the mechanical half of an optimistic update: the
 * change is written over the local query results, and dropped again once the
 * mutation completes — on success the server's own value has landed underneath
 * it, and on failure what comes back is what was there before. The rollback is
 * not this helper's work and never was. What Convex cannot do is tell the
 * reader it happened: the note they watched appear simply stops being there, a
 * second later, with no account of why. On a slow connection that is
 * indistinguishable from the app losing their writing.
 *
 * So this helper's whole job is making the rollback *visible*. Two things,
 * neither of which Convex is in a position to decide: an error toast in the
 * caller's own words, and `onRolledBack` for the state that lives outside the
 * query store — the draft to put back in the composer, the panel to reopen.
 * The optimistic value itself needs no restoring; it was never the caller's to
 * hold.
 *
 * The returned function resolves to `undefined` on failure rather than
 * rejecting, because the calling convention is fire-and-forget: an optimistic
 * mutation whose UI already moved has nothing to await, and a floating promise
 * that can reject is an unhandled rejection waiting for the one server error
 * nobody tested. Callers that do want the result can check for `undefined`.
 */

/** Exported for tests: the catch-and-report core, free of React. */
export async function runWithFeedback<T>(
  run: () => Promise<T>,
  opts: {
    errorMessage: string;
    toast: (input: ToastInput) => void;
    onRolledBack?: () => void;
  },
): Promise<T | undefined> {
  try {
    return await run();
  } catch {
    // Restore first, announce second. `onRolledBack` puts the draft back on
    // screen, and the toast should be read against a page that has already
    // finished rearranging itself rather than one still moving under it.
    //
    // The error is swallowed rather than reported through `readableError`:
    // the copy here is the caller's, written for the specific thing that just
    // failed to happen, and it is better than any sentence the backend has.
    opts.onRolledBack?.();
    opts.toast({ message: opts.errorMessage, tone: "error" });
    return undefined;
  }
}

export function useFeedbackMutation<M extends FunctionReference<"mutation">>(
  mutation: M,
  opts: {
    optimisticUpdate?: OptimisticUpdate<FunctionArgs<M>>;
    /** Human copy, in the caller's words: "Couldn't save your note". */
    errorMessage: string;
    /** Restore drafts, reopen composers — the state Convex doesn't own. */
    onRolledBack?: () => void;
  },
) {
  const toast = useToast();
  const base = useMutation(mutation);

  // `withOptimisticUpdate` returns a fresh mutation object every call, so it
  // is held across renders — otherwise the `useCallback` below would have a
  // dependency that changes on every render and would hand back a new function
  // each time. Both memos are only as stable as what the caller passes in: an
  // `optimisticUpdate` written inline is a new function on every render and
  // defeats them, which is why callers that care about the identity of the
  // returned function should keep theirs in a `useCallback`.
  const withOptimistic = useMemo(
    () =>
      opts.optimisticUpdate
        ? base.withOptimisticUpdate(opts.optimisticUpdate)
        : base,
    [base, opts.optimisticUpdate],
  );

  return useCallback(
    (args: FunctionArgs<M>): Promise<FunctionReturnType<M> | undefined> =>
      runWithFeedback(() => withOptimistic(args), {
        errorMessage: opts.errorMessage,
        toast,
        onRolledBack: opts.onRolledBack,
      }),
    [withOptimistic, toast, opts.errorMessage, opts.onRolledBack],
  );
}
