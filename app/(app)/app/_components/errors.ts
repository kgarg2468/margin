import { ConvexError } from "convex/values";

/**
 * Turn a failed mutation into a sentence we can put in front of a researcher.
 *
 * Convex redacts plain `Error`s thrown by a function to "Server Error" in
 * production — deliberately, so an unhandled crash can't leak internals. The
 * flip side is that only `ConvexError` survives the trip, so every message the
 * backend intends a human to read is thrown as one and arrives here as
 * `error.data`. Anything else is a genuine surprise and gets the fallback.
 */
export function readableError(error: unknown, fallback: string): string {
  const message = convexErrorData(error);
  if (typeof message === "string" && message.length > 0) {
    return message;
  }
  return fallback;
}

/**
 * The sentence a backend meant a human to read, whichever shape it came in.
 *
 * Most functions throw `ConvexError("…")` and the sentence *is* the payload.
 * A few need the client to branch on *why*, not just to print it — an invite
 * that was revoked has to be told apart from one that failed to reach the
 * server — so they throw an object with a `kind` and carry the sentence in a
 * `message` field beside it. Both are read here so no caller has to care.
 */
function convexErrorData(error: unknown): string | undefined {
  if (!(error instanceof ConvexError)) {
    return undefined;
  }
  const data: unknown = error.data;
  if (typeof data === "string") {
    return data;
  }
  if (typeof data === "object" && data !== null && "message" in data) {
    const message: unknown = (data as { message: unknown }).message;
    return typeof message === "string" ? message : undefined;
  }
  return undefined;
}

/**
 * Whether the server refused an invite code for a reason that will still be
 * true later — revoked, expired, full, or simply not a code.
 *
 * Deliberately answers `false` for everything it does not positively
 * recognise, including a `ConvexError` from an authorization helper: "you are
 * not signed in" is a statement about the session, not about the invitation,
 * and the code is still worth keeping. Guessing "permanent" here throws away
 * a live invitation; guessing "transient" costs a retry that fails again.
 */
export function isPermanentInviteRefusal(error: unknown): boolean {
  if (!(error instanceof ConvexError)) {
    return false;
  }
  const data: unknown = error.data;
  return (
    typeof data === "object" &&
    data !== null &&
    "kind" in data &&
    (data as { kind: unknown }).kind === "invite-refused"
  );
}
