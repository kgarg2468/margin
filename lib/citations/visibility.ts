/**
 * Is this citation still something the lab is allowed to be shown?
 *
 * Three ways a note stops counting, and they are one condition rather than
 * three because a stored artifact cannot tell them apart and should not try:
 * the row is gone, it was withdrawn (`deletedAt`), or its author flipped it
 * back to `private`. The lab check is the same one the caller passed to get
 * here — a stored id is a claim about a row, and a claim is worth re-reading.
 *
 * Eight modules ask this question. It lives here, generic over the id type,
 * so `convex/delegations.ts` can ask it without importing the module that
 * owns the *other* model surface.
 */
export type ShareCheckable<L extends string> = {
  labId: L;
  visibility: "private" | "lab";
  deletedAt?: number;
};

export function isStillShared<L extends string>(
  row: ShareCheckable<L> | null | undefined,
  labId: L,
): boolean {
  return (
    row !== null &&
    row !== undefined &&
    row.deletedAt === undefined &&
    row.visibility === "lab" &&
    row.labId === labId
  );
}
