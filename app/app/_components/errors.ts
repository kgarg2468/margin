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
  if (error instanceof ConvexError) {
    const data: unknown = error.data;
    if (typeof data === "string" && data.length > 0) {
      return data;
    }
  }
  return fallback;
}
