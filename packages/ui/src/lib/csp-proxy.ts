import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, newNonce, type CspOptions } from "@clinic/ui/lib/csp";

// For use in an app's proxy: lets the request through with a fresh nonce. Next reads the nonce out
// of the request's Content-Security-Policy header and puts it on the scripts it renders, so the page
// has to be rendered for this request (a static page would have none).
export function withNonce(
  request: NextRequest,
  options: Omit<CspOptions, "script">,
): NextResponse {
  // `next dev` injects scripts of its own (hot reload and overlay): development gets 'unsafe-inline'
  // and no nonce.
  if (options.dev) {
    const response = NextResponse.next();
    response.headers.set(
      "content-security-policy",
      buildCsp({ ...options, script: { kind: "inline" } }),
    );
    return response;
  }
  const nonce = newNonce();
  const csp = buildCsp({ ...options, script: { kind: "nonce", nonce } });
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("content-security-policy", csp);
  return response;
}
