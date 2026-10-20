import { withSerwist } from "@serwist/turbopack";
import type { NextConfig } from "next";
import { CSP_OPTIONS } from "./src/lib/csp-options";
import { SECURITY_HEADERS, buildCsp } from "../../packages/ui/src/lib/csp";

// Pages built once and served from cache have no per-request moment to mint a nonce, so each carries
// the hashes of its own inline scripts instead. The tokens below are replaced after `next build` by
// scripts/csp-hashes.mjs, which reads them out of the built HTML (the build fails if it cannot).
// Everything rendered per request is handled in proxy.ts with a nonce: "/", /book*, /appointments*.
// The e2e error fixture is rendered per request too but, as a test page, takes the catch-all policy.
// `next dev` has no built HTML, so there the pages get 'unsafe-inline'. The two docs pages send their
// own stricter policy, and the route handlers (/api, /auth, /cron) send HTML to nobody.
const HASHED_PAGES = [
  "about",
  "data",
  "decisions",
  "privacy",
  "terms",
] as const;
const NOT_FOUND_PAGE = "_not-found";
const hashToken = (name: string) => `__INLINE_SCRIPT_HASHES:${name}__`;
const policyFor = (name: string) =>
  buildCsp({
    ...CSP_OPTIONS,
    script: CSP_OPTIONS.dev
      ? { kind: "inline" }
      : { kind: "hashes", hashes: [hashToken(name)] },
  });
const RENDERED_PER_REQUEST = `book(?:/|$)|appointments(?:/|$)|docs$|redoc$|api(?:/|$)|auth(?:/|$)|cron(?:/|$)${process.env.SHELL_E2E === "1" ? "|e2e-shell(?:/|$)" : ""}`;
const NOT_A_HASHED_PAGE = HASHED_PAGES.map((p) => `${p}(?:/|$)`).join("|");
// Not on assets (_next/*, anything with a file extension): a header of this size on every script,
// stylesheet and image was +0.8 KB per response for nothing.
const CATCH_ALL_PAGES = `/((?!_next(?:/|$)|${RENDERED_PER_REQUEST}|${NOT_A_HASHED_PAGE}|.*\\.).+)`;
const PAGES_ONLY = "/((?!_next(?:/|$)|docs$|redoc$|.*\\.).*)";

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
  // The avatars are static files with stable names: let the browser keep them for a day and
  // revalidate in the background, so a swapped portrait shows within a day without a hashed name.
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
      { source: PAGES_ONLY, headers: [...SECURITY_HEADERS] },
      ...HASHED_PAGES.map((p) => ({
        source: `/${p}`,
        headers: [{ key: "Content-Security-Policy", value: policyFor(p) }],
      })),
      {
        source: CATCH_ALL_PAGES,
        headers: [
          {
            key: "Content-Security-Policy",
            value: policyFor(NOT_FOUND_PAGE),
          },
        ],
      },
    ];
  },
};

export default withSerwist(nextConfig);
