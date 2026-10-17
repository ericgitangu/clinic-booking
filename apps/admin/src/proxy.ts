import { NextResponse } from "next/server";
import {
  logNotConfiguredOnce,
  notConfiguredResponse,
  readAuthEnv,
} from "@clinic/api/auth-env";
import { SITE } from "@/lib/site";

// Without the sign-in settings the routes that need them answer a plain 503 page and log once,
// instead of throwing on every request. Checked per request, so a fixed environment takes effect
// on the next deploy without code changes.
export function proxy() {
  const env = readAuthEnv();
  if (env.ok) return NextResponse.next();
  logNotConfiguredOnce("admin", env.missing);
  return notConfiguredResponse(SITE.name);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
