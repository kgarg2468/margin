"use client";

import { ConvexAuthNextjsProvider } from "@convex-dev/auth/nextjs";
import { ConvexReactClient } from "convex/react";
import { ConvexQueryCacheProvider } from "convex-helpers/react/cache/provider";
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
 * Nothing here scopes the cache to a session, and that is deliberate.
 *
 * The registry is memoised on a module-singleton client, so it would outlive a
 * sign-out — and a stale session's failed query results are read straight out
 * of the client-global store by query token, without the registry being
 * consulted at all (`BaseConvexClient.localQueryResult`). Re-keying this
 * provider therefore protects nothing: the fresh registry just refcounts back
 * onto a token that is still subscribed. The eviction has to happen a level
 * down, so signing out is a document navigation instead — see the rail's
 * `Sign out`. That drops the client, its result store and every pending
 * timer at once.
 */
export function ConvexClientProvider({ children }: { children: ReactNode }) {
  return (
    <ConvexAuthNextjsProvider client={convex}>
      <ConvexQueryCacheProvider expiration={QUERY_CACHE_EXPIRATION_MS}>
        {children}
      </ConvexQueryCacheProvider>
    </ConvexAuthNextjsProvider>
  );
}
