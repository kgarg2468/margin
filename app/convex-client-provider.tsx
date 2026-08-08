"use client";

import { ConvexAuthNextjsProvider } from "@convex-dev/auth/nextjs";
import { ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";

/**
 * The client is constructed at module scope, which means `next build` runs it
 * during prerender — and CI builds without a provisioned deployment. Falling
 * back to a placeholder origin keeps the build green; at runtime a missing
 * `NEXT_PUBLIC_CONVEX_URL` simply leaves every query in its loading state
 * instead of crashing the page.
 */
const convexUrl =
  process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://not-configured.convex.cloud";

const convex = new ConvexReactClient(convexUrl);

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  return (
    <ConvexAuthNextjsProvider client={convex}>
      {children}
    </ConvexAuthNextjsProvider>
  );
}
