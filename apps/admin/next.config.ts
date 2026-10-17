import type { NextConfig } from "next";

// Cost: no image optimization (it bills), no rewrites.
const nextConfig: NextConfig = {
  images: { unoptimized: true },
  transpilePackages: ["@clinic/ui", "@clinic/api"],
  // Lets pages answer 403 with forbidden() and render forbidden.tsx.
  experimental: { authInterrupts: true },
};

export default nextConfig;
