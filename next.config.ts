import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Dynamic routes default to staleTime 0 — every nav refetches.
    // 30s keeps within-session hops instant; Convex live queries keep
    // the data itself fresh once mounted.
    staleTimes: { dynamic: 30, static: 180 },
  },
};

export default nextConfig;
