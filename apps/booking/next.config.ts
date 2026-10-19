import { withSerwist } from "@serwist/turbopack";
import type { NextConfig } from "next";

// Cost: no image optimization (it bills), no rewrites (the proxy is an explicit route).
const nextConfig: NextConfig = {
  images: {
    unoptimized: true,
    // Google profile pictures (the signed-in person's avatar).
    remotePatterns: [
      { protocol: "https", hostname: "lh3.googleusercontent.com" },
    ],
  },
  // The avatars are static files with stable names: let the browser keep them for a day and revalidate
  // in the background, so a swapped portrait shows within a day without a hashed file name.
  async headers() {
    return [
      {
        source: "/doctors/:file",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=86400, stale-while-revalidate=604800",
          },
        ],
      },
    ];
  },
  transpilePackages: ["@clinic/ui", "@clinic/api"],
};

export default withSerwist(nextConfig);
