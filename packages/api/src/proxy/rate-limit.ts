// Per-client fixed-window limiter, per instance (serverless instances do not share state).
// Default 120/min. Memory is bounded: expired entries are swept and the map is capped.
const WINDOW_MS = 60_000;
const MAX_TRACKED_KEYS = 10_000;
const DEFAULT_LIMIT = 120;
// A request that arrives with no client address did not come through Vercel's edge. It is not
// "one client": it shares a single, much smaller bucket instead of the normal per-client one.
const UNKNOWN_LIMIT = 10;
export const UNKNOWN_CLIENT = "unknown";

function limit(): number {
  // A non-numeric value must not silently disable the limiter (`length >= NaN` is never true).
  const n = Number(process.env.RATE_LIMIT_PER_MINUTE);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LIMIT;
}

// IPv6 clients are keyed by their /64: a single customer holds billions of addresses inside it.
export function clientKey(ip: string | null | undefined): string {
  if (!ip) return UNKNOWN_CLIENT;
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = ip.includes("::") && tail ? tail.split(":") : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups = ip.includes("::")
    ? [
        ...headGroups,
        ...Array<string>(Math.max(missing, 0)).fill("0"),
        ...tailGroups,
      ]
    : headGroups;
  return (
    groups
      .slice(0, 4)
      .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ""))
      .join(":") + "::/64"
  );
}

const hits = new Map<string, number[]>();
let lastSweep = 0;

function sweep(now: number): void {
  for (const [key, times] of hits) {
    if (times.every((t) => t <= now - WINDOW_MS)) hits.delete(key);
  }
  // Still over the cap (a flood of distinct addresses): drop the oldest-inserted entries.
  for (const key of hits.keys()) {
    if (hits.size <= MAX_TRACKED_KEYS) break;
    hits.delete(key);
  }
  lastSweep = now;
}

export function checkRateLimit(
  ip: string | null | undefined,
  now = Date.now(),
): { ok: boolean; retryAfter: number } {
  if (hits.size > MAX_TRACKED_KEYS || now - lastSweep > WINDOW_MS) sweep(now);

  const key = clientKey(ip);
  const max =
    key === UNKNOWN_CLIENT ? Math.min(limit(), UNKNOWN_LIMIT) : limit();
  const recent = (hits.get(key) ?? []).filter((t) => t > now - WINDOW_MS);
  if (recent.length >= max) {
    hits.set(key, recent);
    const retryAfter = Math.max(
      1,
      Math.ceil((recent[0] + WINDOW_MS - now) / 1000),
    );
    return { ok: false, retryAfter };
  }
  recent.push(now);
  hits.delete(key); // re-insert so the map stays ordered by recency
  hits.set(key, recent);
  return { ok: true, retryAfter: 0 };
}

export function _trackedIpsForTests(): number {
  return hits.size;
}

export function _clearRateLimitForTests(): void {
  hits.clear();
  lastSweep = 0;
}
