import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // default (auto) prefetches and non-full navigations reuse dynamic
    // entries for 30s; fully-prefetched sidebar links reuse entries via
    // the 300s static window. convex live queries keep data fresh once mounted.
    staleTimes: { dynamic: 30, static: 300 },
  },

  /**
   * Share links are unlisted, and the header is the half of saying so that a
   * crawler cannot skip.
   *
   * The page already carries `<meta name="robots">` from the `(public)` route
   * group's layout, but a fetcher that reads headers and never parses the HTML
   * — and every crawler does this on the cheap pass — would see nothing. These
   * pages exist because somebody sent a link to a colleague; a link that turns
   * up in a search result is a link its lab did not agree to publish.
   */
  async headers() {
    return [
      {
        source: "/s/:token*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          /**
           * The URL of this page *is* the capability, and a `Referer` header
           * is how a browser hands the current URL to somewhere else. Every
           * link on a share page is therefore a way out for the token: the
           * DOI that leaves for a publisher, the sign-in door, and whatever
           * the next surface built here happens to add. `rel="noreferrer"` on
           * the one link that exists today closes one of those; the header
           * closes all of them, including the ones nobody has written yet.
           */
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
