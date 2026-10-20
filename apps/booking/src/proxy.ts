import { NextResponse, type NextRequest } from "next/server";
import {
  logNotConfiguredOnce,
  notConfiguredResponse,
  readAuthEnv,
} from "@clinic/api/auth-env";
import { withNonce } from "@clinic/ui/lib/csp-proxy";
import { CSP_OPTIONS } from "@/lib/csp-options";
import { legacyRedirect } from "@/lib/legacy-host";
import { SITE } from "@/lib/site";

// Three jobs, in this order:
// 1. The old *.vercel.app production aliases redirect to the branded host (lib/legacy-host.ts).
// 2. Without the sign-in settings the routes that need them answer a plain 503 page and log once,
//    instead of throwing on every request. Checked per request, so a fixed environment takes
//    effect on the next deploy without code changes.
// 3. Every page that is rendered per request gets a fresh nonce and the nonce Content-Security-Policy
//    (packages/ui/src/lib/csp.ts). The pages built once (/about, /data, /decisions, /privacy, /terms, the 404)
//    are not matched here; next.config.ts gives them the "inline" policy.
// The redirect runs before the settings check, so an alias redirects even when sign-in is not
// configured, and a public page on the branded host never needs the sign-in settings.

// The routes that need the sign-in settings: what the matcher below listed before the nonce was added.
const needsSignIn = (path: string) =>
  path === "/auth" ||
  path.startsWith("/auth/") ||
  path === "/appointments" ||
  path.startsWith("/appointments/") ||
  /^\/book\/[^/]+\/details$/.test(path) ||
  path.startsWith("/book/confirmed/");

export function proxy(req: NextRequest) {
  const to = legacyRedirect(
    req.headers.get("host"),
    req.nextUrl.pathname,
    req.nextUrl.search,
  );
  if (to) return NextResponse.redirect(to, 308);

  const path = req.nextUrl.pathname;
  if (needsSignIn(path)) {
    const env = readAuthEnv();
    if (!env.ok) {
      logNotConfiguredOnce("booking", env.missing);
      return notConfiguredResponse(SITE.name);
    }
  }
  // The sign-in routes of the auth library answer JSON and redirects, not pages. The e2e error fixture
  // exists only in builds made for e2e; anywhere else that path is the built-once 404 page.
  if (path === "/auth" || path.startsWith("/auth/")) return NextResponse.next();
  if (path.startsWith("/e2e-shell/") && process.env.SHELL_E2E !== "1")
    return NextResponse.next();
  return withNonce(req, CSP_OPTIONS);
}

// Next reads this statically, so it is spelled out here; tests/legacy-host.test.ts checks that the
// host list below is the one in lib/legacy-host.ts. The first five entries are the routes rendered
// per request (they get the nonce policy), which include the sign-in routes. The last one runs the
// proxy for any other path, but only on a legacy alias, so the pages built once on every other host
// never reach it. tests/not-configured.test.ts pins which paths match.
export const config = {
  matcher: [
    "/",
    "/auth/:path*",
    "/appointments/:path*",
    "/book/:path*",
    "/e2e-shell/:path*",
    {
      source: "/((?!api(?:/|$)|auth(?:/|$)|\\.well-known(?:/|$)).*)",
      has: [
        {
          type: "host",
          value:
            "(sil-clinic-booking\\.vercel\\.app|clinic-web-nine-beta\\.vercel\\.app|clinic-web-eric-gitangus-projects\\.vercel\\.app)",
        },
      ],
    },
  ],
};
