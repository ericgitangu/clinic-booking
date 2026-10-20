// What the patient app talks to, for the Content-Security-Policy (builder: packages/ui/src/lib/csp.ts).
// Read by next.config.ts and by proxy.ts, so the two can not drift. Relative import on purpose:
// next.config.ts is loaded before the workspace aliases exist.
import {
  ABLY_STREAM_ORIGIN,
  type CspOptions,
} from "../../../../packages/ui/src/lib/csp";

// Only the live-update scenarios against the local stand-in for the push service (E2E_PUSH_LOCAL=1,
// e2e/support/fake-push.mjs) need a local host in connect-src. Refuse it anywhere else, and refuse
// any host but localhost, so a real build can not ship with it.
export function extraConnect(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const raw = env.CSP_EXTRA_CONNECT?.split(",").filter(Boolean) ?? [];
  if (raw.length === 0) return [];
  const local = raw.every((h) =>
    /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(h),
  );
  if (env.E2E_PUSH_LOCAL !== "1" || !local)
    throw new Error(
      "CSP_EXTRA_CONNECT is only for the local push stand-in (E2E_PUSH_LOCAL=1, http://localhost:<port>); refusing to build with it",
    );
  return raw;
}

export const CSP_OPTIONS: Omit<CspOptions, "script"> = {
  dev: process.env.NODE_ENV !== "production",
  upgradeInsecure: true,
  // reCAPTCHA Enterprise talks to www.google.com and www.gstatic.com and draws its (hidden) badge frame
  // from www.google.com. The script itself is covered by 'strict-dynamic'. Everything else, including
  // the Go gateway, is reached through the same-origin /api proxy.
  connect: [
    "https://www.google.com",
    "https://www.gstatic.com",
    ABLY_STREAM_ORIGIN,
    ...extraConnect(),
  ],
  frame: ["https://www.google.com", "https://recaptcha.google.com"],
  img: ["https://lh3.googleusercontent.com", "https://www.gstatic.com"],
};
