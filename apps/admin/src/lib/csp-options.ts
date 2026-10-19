// What the staff app talks to, for the Content-Security-Policy (builder: packages/ui/src/lib/csp.ts).
// Read by proxy.ts. Relative import on purpose: it is also read where the workspace aliases do not exist.
import type { CspOptions } from "../../../../packages/ui/src/lib/csp";

// The staff app talks only to itself (its live feed arrives through its own /live/stream route). The
// avatar is a Google profile picture. Sign-in is a fetch to /auth followed by a navigation to Google,
// and neither is governed by form-action, so no Google entry is needed there.
export const CSP_OPTIONS: Omit<CspOptions, "script"> = {
  dev: process.env.NODE_ENV !== "production",
  upgradeInsecure: true,
  img: ["https://lh3.googleusercontent.com"],
};

// Every page of this app is rendered per request (the root layout reads the session and says so with
// force-dynamic; that includes the 404 page), so every page can carry a nonce. What is not a page:
// build assets, the auth routes, the live stream, and anything with a file extension.
export const isPage = (path: string) =>
  !path.startsWith("/_next/") &&
  !path.startsWith("/auth/") &&
  !path.startsWith("/live/") &&
  !path.includes(".");
