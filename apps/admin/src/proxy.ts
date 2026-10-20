import { NextResponse, type NextRequest } from "next/server";
import {
  logNotConfiguredOnce,
  notConfiguredResponse,
  readAuthEnv,
} from "@clinic/api/auth-env";
import { withNonce } from "@clinic/ui/lib/csp-proxy";
import { canonicalRedirect } from "@/lib/canonical-host";
import { CSP_OPTIONS, isPage } from "@/lib/csp-options";
import { SITE } from "@/lib/site";

// Three jobs, in this order (the third is described at the end of proxy()):
// 1. The old vercel.app production aliases answer a 308 to the custom domain, same path and query
//    (see lib/canonical-host.ts for exactly which hosts and paths).
// 2. Without the sign-in settings the routes that need them answer a plain 503 page and log once,
//    instead of throwing on every request. Checked per request, so a fixed environment takes
//    effect on the next deploy without code changes.
export function proxy(request: NextRequest) {
  const target = canonicalRedirect(
    request.headers.get("host") ?? request.nextUrl.host,
    request.nextUrl.pathname,
    request.nextUrl.search,
  );
  if (target) return NextResponse.redirect(target, 308);

  const env = readAuthEnv();
  if (!env.ok) {
    logNotConfiguredOnce("admin", env.missing);
    return notConfiguredResponse(SITE.name);
  }
  // Every page is rendered per request (the root layout is force-dynamic), so each gets a fresh nonce
  // and the nonce Content-Security-Policy (packages/ui/src/lib/csp.ts). Assets, the sign-in routes and
  // the live stream answer no page and are passed through.
  return isPage(request.nextUrl.pathname)
    ? withNonce(request, CSP_OPTIONS)
    : NextResponse.next();
}

// Everything but static assets gets the 503 guard. The two alias hosts are also matched on every
// path, assets included, so robots.txt, favicon.ico and _next/* redirect to the custom domain too
// (a `has: host` entry per alias, written out because Next reads this object statically; the value
// is a regular expression, so the dots are escaped). A test keeps these in step with
// REDIRECTED_HOSTS.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt).*)",
    {
      source: "/:path*",
      has: [{ type: "host", value: "clinic-admin-azure\\.vercel\\.app" }],
    },
    {
      source: "/:path*",
      has: [
        {
          type: "host",
          value: "clinic-admin-eric-gitangus-projects\\.vercel\\.app",
        },
      ],
    },
  ],
};
