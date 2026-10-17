// The generated *.vercel.app alias was the first public address. Now that patients use
// the branded host it is demoted to a redirect. Only that exact production host is matched:
// preview deployments (sil-clinic-booking-git-<branch>-<team>.vercel.app, the per-deployment hash
// hosts) and localhost keep serving, so previews and local runs stay usable.
import { SITE } from "./site";

export const LEGACY_HOST = "sil-clinic-booking.vercel.app";

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A next.config redirect rule. Path and query travel with it; `permanent` makes it a 308, which
// keeps the method as well (a 301 would turn a POST into a GET).
export const legacyHostRedirect = {
  source: "/:path*",
  has: [{ type: "host" as const, value: escapeRegex(LEGACY_HOST) }],
  destination: `${SITE.url}/:path*`,
  permanent: true,
};
