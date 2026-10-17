import { NextResponse, type NextRequest } from "next/server";
import {
  logNotConfiguredOnce,
  notConfiguredResponse,
  readAuthEnv,
} from "@clinic/api/auth-env";
import { canonicalRedirect } from "@/lib/canonical-host";
import { SITE } from "@/lib/site";

// Two jobs, in this order:
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
  if (env.ok) return NextResponse.next();
  logNotConfiguredOnce("admin", env.missing);
  return notConfiguredResponse(SITE.name);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
