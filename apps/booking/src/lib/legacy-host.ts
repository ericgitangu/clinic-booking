// The generated *.vercel.app production aliases were the first public addresses. Patients now use
// the branded host, so each alias redirects there with a 308 (method, path and query kept).
//
// Only these exact hosts redirect, from an explicit list: no pattern on *.vercel.app, because
// per-deployment URLs (<project>-<hash>-<team>.vercel.app) and previews must keep serving. CI smoke
// tests the deployment before it is promoted, and verify-release and rollback address deployments.
//
// /api, /auth and /.well-known never redirect: an OAuth callback or OIDC lookup that bounced to
// another host would break the sign-in and the keyless deploy.
import { SITE } from "./site";

export const LEGACY_HOSTS = [
  "sil-clinic-booking.vercel.app",
  "clinic-web-nine-beta.vercel.app",
  "clinic-web-eric-gitangus-projects.vercel.app",
] as const;

export const NEVER_REDIRECTED = ["/api", "/auth", "/.well-known"] as const;

const hostOf = (header: string | null): string =>
  (header ?? "").split(":")[0].toLowerCase();

const isUnder = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

/** Where a request for this host and path should be sent, or null to serve it here. */
export function legacyRedirect(
  hostHeader: string | null,
  pathname: string,
  search: string,
): string | null {
  const host = hostOf(hostHeader);
  if (!(LEGACY_HOSTS as readonly string[]).includes(host)) return null;
  if (NEVER_REDIRECTED.some((p) => isUnder(pathname, p))) return null;
  return `${SITE.url}${pathname}${search}`;
}
