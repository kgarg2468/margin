import {
  convexAuthNextjsMiddleware,
  createRouteMatcher,
  nextjsMiddlewareRedirect,
} from "@convex-dev/auth/nextjs/server";

const isSignInPage = createRouteMatcher(["/signin"]);
const isProtectedRoute = createRouteMatcher(["/app(.*)"]);

/**
 * Everything under `/app` requires a session; `/signin` is pointless once you
 * have one. The Convex functions authorize independently — this is only here
 * so an unauthenticated visitor gets a redirect instead of an empty shell.
 */
export default convexAuthNextjsMiddleware(
  async (request, { convexAuth }) => {
    if (isSignInPage(request) && (await convexAuth.isAuthenticated())) {
      return nextjsMiddlewareRedirect(request, "/app");
    }
    if (isProtectedRoute(request) && !(await convexAuth.isAuthenticated())) {
      return nextjsMiddlewareRedirect(request, "/signin");
    }
  },
  {
    // Without this the auth cookie is a session cookie, so closing the browser
    // signs you out. A journal club runs on a weekly rhythm; being asked to
    // sign in every morning is friction with nothing to show for it. Thirty
    // days, and the refresh token behind it is still rotated on every use.
    cookieConfig: { maxAge: 60 * 60 * 24 * 30 },
  },
);

export const config = {
  // Only the routes that can have a session. The stock Convex Auth matcher
  // covers the whole site, so every hit on the landing page — a prerendered
  // file with no authenticated content — ran a token check and could come
  // back carrying `Set-Cookie` (verified: with an expired cookie present, `/`
  // answered with three), which is exactly what stops a CDN caching it.
  // Nothing is lost by dropping `/`: the middleware only reads the session to
  // pick a redirect, and `/` has no redirect to pick.
  // (`:path*` is zero-or-more, so this covers `/app` itself.)
  //
  // `/api/auth` is NOT optional: Convex Auth has no route file — the sign-in
  // proxy endpoint is served by this middleware, so the matcher must include
  // it or every sign-in/sign-up 404s (broke production on first deploy).
  matcher: ["/signin", "/app/:path*", "/api/auth"],
};
