// What the staff app talks to, for the Content-Security-Policy (builder: packages/ui/src/lib/csp.ts).
// Read by next.config.ts and proxy.ts. Relative import on purpose: next.config.ts is loaded before the
// workspace aliases exist.
import type { CspOptions } from "../../../../packages/ui/src/lib/csp";

// The staff app talks only to itself (its live feed arrives through its own /live/stream route). The
// avatar is a Google profile picture. Sign-in is a fetch to /auth followed by a navigation to Google,
// and neither is governed by form-action, so no Google entry is needed there.
export const CSP_OPTIONS: Omit<CspOptions, "script"> = {
  dev: process.env.NODE_ENV !== "production",
  upgradeInsecure: true,
  img: ["https://lh3.googleusercontent.com"],
};

// The pages rendered per request, which get a nonce in proxy.ts: the sign-in gate and everything under
// /dashboard and /access (the e2e error fixture, in builds made for e2e). Any other path is the 404
// page, which is built once and so carries the hashes of its own scripts instead (next.config.ts).
export const RENDERED_PER_REQUEST = ["dashboard", "access"] as const;
export const E2E_FIXTURE = process.env.SHELL_E2E === "1" ? ["e2e-shell"] : [];
export function rendersPerRequest(path: string): boolean {
  if (path === "/") return true;
  return [...RENDERED_PER_REQUEST, ...E2E_FIXTURE].some(
    (p) => path === `/${p}` || path.startsWith(`/${p}/`),
  );
}
