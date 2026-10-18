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
  transpilePackages: ["@clinic/ui", "@clinic/api"],
};

export default withSerwist(nextConfig);
