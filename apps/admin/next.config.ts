import type { NextConfig } from "next";
import { SECURITY_HEADERS } from "../../packages/ui/src/lib/csp";

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
  // The e2e error fixture (src/app/e2e-shell/error/page.e2e.tsx) is a route only when the build is made
  // with SHELL_E2E=1, so it can not exist in a real build.
  pageExtensions: [
    "tsx",
    "ts",
    "jsx",
    "js",
    ...(process.env.SHELL_E2E === "1" ? ["e2e.tsx"] : []),
  ],
  transpilePackages: ["@clinic/ui", "@clinic/api"],
  // Lets pages answer 403 with forbidden() and render forbidden.tsx.
  experimental: {
    authInterrupts: true,
    // Server actions answer only the app's own host (and the same origin), stated rather than left
    // to the default. Keep in step with SITE.url in src/lib/site.ts (a test checks it).
    serverActions: { allowedOrigins: ["clinic-admin.ericgitangu.com"] },
  },
  // The Content-Security-Policy is set per request in proxy.ts (every page here is rendered per
  // request, so each can carry a nonce). These go on pages, not on _next/* or anything with a file
  // extension (a header on every asset costs bytes). The invite link carries a secret in its path:
  // it keeps its own Referrer-Policy (none at all), stays out of every cache and out of search.
  async headers() {
    return [
      {
        source: "/((?!_next(?:/|$)|invite(?:/|$)|.*\\.).*)",
        headers: [...SECURITY_HEADERS],
      },
      {
        source: "/invite/:token",
        headers: [
          ...INVITE_HEADERS,
          ...SECURITY_HEADERS.filter((h) => h.key !== "Referrer-Policy"),
        ],
      },
    ];
  },
};

export default nextConfig;
