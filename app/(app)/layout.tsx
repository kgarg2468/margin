import { ConvexAuthNextjsServerProvider } from "@convex-dev/auth/nextjs/server";
import type { ReactNode } from "react";
import { ConvexClientProvider } from "./convex-client-provider";

/**
 * Everything that can have a session: `/signin` and `/app`.
 *
 * ConvexAuthNextjsServerProvider reads the auth cookie on the server so the
 * client starts up already knowing whether there is one — which also opts
 * every route below it into dynamic rendering. That is correct here and wrong
 * for the landing page, which is why the two live in separate route groups
 * rather than sharing the root layout. Route groups do not appear in the URL,
 * so `/signin` and `/app` are unchanged.
 */
export default function AuthedLayout({ children }: { children: ReactNode }) {
  return (
    <ConvexAuthNextjsServerProvider>
      <ConvexClientProvider>{children}</ConvexClientProvider>
    </ConvexAuthNextjsServerProvider>
  );
}
