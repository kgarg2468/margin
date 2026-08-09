"use client";

import { ConvexAuthNextjsProvider } from "@convex-dev/auth/nextjs";
import { useConvexAuth } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import { ConvexQueryCacheProvider } from "convex-helpers/react/cache/provider";
import { useState } from "react";
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

/**
 * Convex tears a query's subscription down the moment its last subscriber
 * unmounts, so a route the router serves instantly from its cache still
 * re-fetches and flashes its skeleton. `ConvexQueryCacheProvider` holds the
 * subscription open for `expiration` after the last unmount, so a remounting
 * `useQuery` — the one from `convex-helpers/react/cache/hooks`, which is what
 * the app's call sites import — has its data on first render. Five minutes
 * comfortably outlives the router's own 30s dynamic window. It must sit inside
 * the auth provider: it reads the client through `useConvex`.
 */
const QUERY_CACHE_EXPIRATION_MS = 300_000;

/**
 * A warm cache must not outlive the identity that filled it.
 *
 * `convex` is a module singleton and the registry is memoised on it, so
 * without this both would survive a sign-out — which is a client-side
 * `router.push`, not a reload. `clearAuth()` only sends an `Authenticate`
 * message; it does not clear the client's stored query results. So the server
 * re-runs every still-subscribed query with no identity, `requireUserId`
 * throws, and the failures sit in the store under those tokens. The cache hook
 * rethrows a stored `Error` during render, so the next mount of a cached query
 * can blow up in a component that did nothing wrong.
 *
 * Re-keying on the identity gives each session its own registry, so nothing a
 * signed-out session recorded is ever read by the next one.
 *
 * The epoch, rather than the flag itself, is the key because `isAuthenticated`
 * is false while the token is still being read. Keying on that directly would
 * remount the whole app tree once on every page load — the exact skeleton
 * flash this cache exists to prevent. Only a change *between settled* answers
 * counts as a new session; the first settle is the answer to "who is this?",
 * not a transition. Adjusting state during render is the supported React
 * pattern for this and re-renders before the children commit.
 */
function AuthScopedQueryCache({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const [session, setSession] = useState<{
    identity: boolean | null;
    epoch: number;
  }>({ identity: null, epoch: 0 });

  if (!isLoading && session.identity !== isAuthenticated) {
    setSession((prev) => ({
      identity: isAuthenticated,
      epoch: prev.identity === null ? prev.epoch : prev.epoch + 1,
    }));
  }

  return (
    <ConvexQueryCacheProvider
      key={session.epoch}
      expiration={QUERY_CACHE_EXPIRATION_MS}
    >
      {children}
    </ConvexQueryCacheProvider>
  );
}

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  return (
    <ConvexAuthNextjsProvider client={convex}>
      <AuthScopedQueryCache>{children}</AuthScopedQueryCache>
    </ConvexAuthNextjsProvider>
  );
}
