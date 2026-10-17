import type { NextConfig } from "next";

// Cost: no image optimization (it bills), no rewrites.
const nextConfig: NextConfig = {
  images: { unoptimized: true },
  transpilePackages: ["@clinic/ui"],
};

export default nextConfig;
