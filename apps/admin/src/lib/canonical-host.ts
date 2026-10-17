import { SITE } from "@/lib/site";

// The admin project's stable production aliases on vercel.app. They only exist to be demoted to a
// redirect to the custom domain once it is live. This is an exact allowlist, not a pattern:
// per-deployment URLs (<project>-<hash>-<team>.vercel.app) and previews must keep serving, because
// CI smoke-tests the deployment it has just made through that URL before it promotes it, and the
// verify and rollback steps resolve deployments through it.
export const REDIRECTED_HOSTS: ReadonlySet<string> = new Set([
  "clinic-admin-azure.vercel.app",
  "clinic-admin-eric-gitangus-projects.vercel.app",
]);

// Paths that are never redirected, because a redirect would break them: the sign-in handshake
// (the OAuth state cookie is host-only and the callback must land on the host that started it),
// the API routes, and well-known files.
const EXCLUDED_PREFIXES = ["/api", "/auth", "/.well-known"] as const;

export function isExcluded(pathname: string): boolean {
  return EXCLUDED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

function hostOnly(host: string | null): string {
  return (host ?? "").trim().toLowerCase().replace(/:\d+$/, "");
}

/** Where to send this request (308), or null when it should be served as it is. */
export function canonicalRedirect(
  hostHeader: string | null,
  pathname: string,
  search: string,
): string | null {
  if (!REDIRECTED_HOSTS.has(hostOnly(hostHeader))) return null;
  if (isExcluded(pathname)) return null;
  return `${SITE.url}${pathname}${search}`;
}
