import { NextResponse, type NextRequest } from "next/server";
import {
  logNotConfiguredOnce,
  notConfiguredResponse,
  readAuthEnv,
} from "@clinic/api/auth-env";
import { legacyRedirect } from "@/lib/legacy-host";
import { SITE } from "@/lib/site";

// Two jobs, in this order:
// 1. The old *.vercel.app production aliases redirect to the branded host (lib/legacy-host.ts).
// 2. Without the sign-in settings the routes that need them answer a plain 503 page and log once,
//    instead of throwing on every request. Checked per request, so a fixed environment takes
//    effect on the next deploy without code changes.
// The redirect runs before the settings check, so an alias redirects even when sign-in is not
// configured, and a public page on the branded host never needs the sign-in settings.
export function proxy(req: NextRequest) {
  const to = legacyRedirect(
    req.headers.get("host"),
    req.nextUrl.pathname,
    req.nextUrl.search,
  );
  if (to) return NextResponse.redirect(to, 308);

  const env = readAuthEnv();
  if (env.ok) return NextResponse.next();
  logNotConfiguredOnce("booking", env.missing);
  return notConfiguredResponse(SITE.name);
}

// Next reads this statically, so it is spelled out here; tests/legacy-host.test.ts checks that the
// host list below is the one in lib/legacy-host.ts. The first four entries are the sign-in routes
// on every host. The last one runs the proxy for any other path, but only on a legacy alias, so
// public pages on every other host never reach it (and never need the sign-in settings).
export const config = {
  matcher: [
    "/auth/:path*",
    "/appointments/:path*",
    "/book/:doctorId/details",
    "/book/confirmed/:path*",
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
