import type { NextConfig } from "next";
// Relative on purpose: this file is loaded before the workspace packages are set up for the app.
import { buildCsp } from "../../packages/ui/src/lib/csp";

// The staff app talks only to itself; sign-in is a form post that ends at Google, and the avatar is a
// Google profile picture.
const CSP = buildCsp({
  dev: process.env.NODE_ENV !== "production",
  img: ["https://lh3.googleusercontent.com"],
  form: ["https://accounts.google.com"],
});

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
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [{ key: "Content-Security-Policy", value: CSP }],
      },
    ];
  },
  // Lets pages answer 403 with forbidden() and render forbidden.tsx.
  experimental: { authInterrupts: true },
};

export default nextConfig;
