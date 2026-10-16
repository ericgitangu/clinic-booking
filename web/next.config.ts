import type { NextConfig } from "next";

// $0 audit: no image optimization (bills), no rewrites (the proxy is an explicit route).
const nextConfig: NextConfig = {
  images: { unoptimized: true },
};

export default nextConfig;
