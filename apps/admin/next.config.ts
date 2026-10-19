import type { NextConfig } from "next";

export const INVITE_HEADERS = [
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Cache-Control", value: "no-store" },
  { key: "X-Robots-Tag", value: "noindex" },
];

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
  experimental: {
    authInterrupts: true,
    // Server actions answer only the app's own host (and the same origin), stated rather than left
    // to the default. Keep in step with SITE.url in src/lib/site.ts (a test checks it).
    serverActions: { allowedOrigins: ["clinic-admin.ericgitangu.com"] },
  },
  // The invite link carries a secret in its path. Keep it out of the Referer sent to any other site
  // and out of every cache.
  async headers() {
    return [
      {
        source: "/invite/:token",
        headers: INVITE_HEADERS,
      },
    ];
  },
};

export default nextConfig;
