// How the dashboard metrics are cached. Kept free of Next imports so the
// rules can be tested on their own; dashboard-data.ts applies them with unstable_cache.
import { can, type Role } from "@/lib/roles";

/** The tag every cached metrics entry carries; mutations and the refresh button expire it. */
export const METRICS_TAG = "admin-metrics";

/** How long an entry lives when nothing invalidates it. */
export const METRICS_TTL_SECONDS = 60;

/**
 * The cache key and options for one metrics query. The key is the query only: the figures are
 * clinic-wide, so they are the same for an owner, an admin and a viewer, and no caller identity is
 * part of the key (or of the cached value).
 */
export function metricsCachePlan(
  from: string,
  to: string,
  bucket: "day",
): {
  keyParts: string[];
  options: { revalidate: number; tags: string[] };
} {
  return {
    keyParts: [METRICS_TAG, from, to, bucket],
    options: { revalidate: METRICS_TTL_SECONDS, tags: [METRICS_TAG] },
  };
}

/**
 * The gate in front of the cache. Whoever asks must hold a role that may view the dashboard, so a
 * cached value is never returned to someone the API would refuse. Pages have already checked this
 * (requireStaff); this is the second line, for any future caller.
 */
export function assertMayReadMetrics(role: Role | null): asserts role is Role {
  if (!can(role, "view")) {
    throw new Error("metrics are not available to this account");
  }
}
