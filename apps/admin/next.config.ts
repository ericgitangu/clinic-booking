import type { NextConfig } from "next";

// Cost: no image optimization (it bills), no rewrites.
const nextConfig: NextConfig = {
  images: {
    unoptimized: true,
    // Google profile pictures (the signed-in person's avatar).
    remotePatterns: [
      { protocol: "https", hostname: "lh3.googleusercontent.com" },
    ],
  },
  transpilePackages: ["@clinic/ui", "@clinic/api"],
  // Lets pages answer 403 with forbidden() and render forbidden.tsx.
  experimental: { authInterrupts: true },
};

export default nextConfig;
