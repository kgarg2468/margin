/**
 * Where a viewer whose only lab is their personal library belongs, and what
 * that arrival leaves behind.
 *
 * Extracted so the rule can be tested where a condition inside an effect could
 * not be — the same bargain `library/_components/upload-flow.ts` makes.
 *
 * The returned `justCreatedAfter` is the whole point. "This arrival is what
 * created the library" is true exactly once and has to be *spent* by the
 * redirect that honours it, because the provider holding it lives in the layout
 * and outlives the page: a newly provisioned member who closes the add panel,
 * reads something, and comes back to `/app` without reloading would otherwise
 * meet a signal that is still true, get sent to `?add=1` a second time, and
 * watch the panel they deliberately dismissed reopen over a library that by now
 * has papers on it.
 *
 * Returning the next state rather than mutating anything is what lets the
 * sequence be tested without a React tree: feed the answer back in and the
 * second arrival has to be an ordinary one.
 */
export function landOnShelf(justCreated: boolean): {
  destination: string;
  justCreatedAfter: boolean;
} {
  return {
    // Signing up is an errand — somebody has a paper they want to read — so the
    // add panel is open on the one visit where there is nothing else to have
    // come for. Every later visit lands on the shelf, which by then has
    // something on it.
    destination: justCreated ? "/app/library?add=1" : "/app/library",
    justCreatedAfter: false,
  };
}
