import type { NextConfig } from "next";
import {
  CSP_OPTIONS,
  E2E_FIXTURE,
  RENDERED_PER_REQUEST,
} from "./src/lib/csp-options";
import { SECURITY_HEADERS, buildCsp } from "../../packages/ui/src/lib/csp";

// The 404 page is built once, so it has no nonce; it carries the hashes of its own inline scripts,
// filled in after `next build` by packages/ui/scripts/csp-hashes.mjs (the token below; the build fails
// if it is not filled). `next dev` has no built HTML, so there it gets 'unsafe-inline'.
const NOT_FOUND_POLICY = buildCsp({
  ...CSP_OPTIONS,
  script: CSP_OPTIONS.dev
    ? { kind: "inline" }
    : { kind: "hashes", hashes: ["__INLINE_SCRIPT_HASHES:_not-found__"] },
});
const NOT_A_404 = [...RENDERED_PER_REQUEST, ...E2E_FIXTURE, "auth", "live"]
  .map((p) => `${p}(?:/|$)`)
  .join("|");

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
  // The Content-Security-Policy is set per request in proxy.ts (it needs a nonce); these go on everything.
  async headers() {
    // Pages only: not on _next/* or anything with a file extension (a header on every asset costs bytes).
    return [
      {
        source: "/((?!_next(?:/|$)|.*\\.).*)",
        headers: [...SECURITY_HEADERS],
      },
      {
        source: `/((?!_next(?:/|$)|${NOT_A_404}|.*\\.).+)`,
        headers: [{ key: "Content-Security-Policy", value: NOT_FOUND_POLICY }],
      },
    ];
  },
  // Lets pages answer 403 with forbidden() and render forbidden.tsx.
  experimental: { authInterrupts: true },
};

export default nextConfig;
