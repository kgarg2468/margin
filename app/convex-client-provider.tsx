"use client";

import { ConvexAuthNextjsProvider } from "@convex-dev/auth/nextjs";
import { ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";

/**
 * Convex Auth also reads `NEXT_PUBLIC_CONVEX_URL` directly (it namespaces
 * token storage by deployment), so there is no useful degraded mode without
 * it — better to say so plainly than to fail three layers down. Every route
 * in this app is dynamic, so this never runs at build time.
 */
const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;

if (!convexUrl) {
  throw new Error(
    "Missing NEXT_PUBLIC_CONVEX_URL. Run `npx convex dev` to create a deployment; it writes .env.local for you.",
  );
}

const convex = new ConvexReactClient(convexUrl);

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  return (
    <ConvexAuthNextjsProvider client={convex}>
      {children}
    </ConvexAuthNextjsProvider>
  );
}
