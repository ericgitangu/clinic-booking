import type { NextConfig } from "next";

// Cost: no image optimization (it bills), no rewrites (the proxy is an explicit route).
const nextConfig: NextConfig = {
  images: { unoptimized: true },
  transpilePackages: ["@clinic/ui", "@clinic/api"],
};

export default nextConfig;
