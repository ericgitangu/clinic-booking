import { withSerwist } from "@serwist/turbopack";
import type { NextConfig } from "next";
// Relative on purpose: this file is loaded before the workspace packages are set up for the app.
import { ABLY_HOSTS, buildCsp } from "../../packages/ui/src/lib/csp";

// reCAPTCHA Enterprise loads its script from www.google.com, its helper code from www.gstatic.com, talks
// to both, and draws its (hidden) badge frame from www.google.com. The push service is Ably. Everything
// else, including the Go gateway, is reached through the same-origin /api proxy, so it needs no entry.
const CSP = buildCsp({
  dev: process.env.NODE_ENV !== "production",
  script: ["https://www.google.com", "https://www.gstatic.com"],
  connect: [
    "https://www.google.com",
    "https://www.gstatic.com",
    ...ABLY_HOSTS,
    // Set only when running the live-update scenarios against the local stand-in for the push
    // service (E2E_PUSH_LOCAL=1, e2e/support/fake-push.mjs); never in a real build.
    ...(process.env.CSP_EXTRA_CONNECT?.split(",").filter(Boolean) ?? []),
  ],
  frame: ["https://www.google.com", "https://recaptcha.google.com"],
  img: ["https://lh3.googleusercontent.com", "https://www.gstatic.com"],
});

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
      {
        // Not /docs or /redoc: those two send their own, stricter policy (lib/docs-page.ts), and a
        // header set here would replace it rather than add to it.
        source: "/((?!docs$|redoc$).*)",
        headers: [{ key: "Content-Security-Policy", value: CSP }],
      },
    ];
  },
  transpilePackages: ["@clinic/ui", "@clinic/api"],
};

export default withSerwist(nextConfig);
