import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * The route group for pages a stranger can open.
 *
 * Separate from `(app)` because of what it must not inherit: the auth
 * provider, the shell, the rail, and the assumption running through all of
 * them that there is a signed-in member and a current lab. A share page has
 * none of those and must not acquire one by being nested under something that
 * provides it.
 *
 * There is deliberately no Convex client under here either. The page reads its
 * artifact once, on the server, per request — see `s/[token]/page.tsx` — which
 * is both what makes revocation take effect on the next load and what keeps a
 * public reader from opening a live subscription to the deployment. A socket
 * per anonymous viewer is a connection record with the lab's name on it, and
 * the constitution's ban on read-tracking is easier to keep when there is
 * nothing there to track with.
 *
 * `robots` is declared here rather than per-page so a second public surface
 * cannot be added later without it. Nothing under this group is for a crawler:
 * these pages exist because somebody sent a link to a colleague, and a link
 * that turns up in a search result is a link its lab did not agree to publish.
 * The `X-Robots-Tag` in `next.config.ts` says the same thing to the crawlers
 * that read headers and never parse the markup.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

export default function PublicLayout({ children }: { children: ReactNode }) {
  return children;
}
