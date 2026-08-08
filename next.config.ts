import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // default (auto) prefetches and non-full navigations reuse dynamic
    // entries for 30s; fully-prefetched sidebar links reuse entries via
    // the 300s static window. convex live queries keep data fresh once mounted.
    staleTimes: { dynamic: 30, static: 300 },
  },
};

export default nextConfig;
