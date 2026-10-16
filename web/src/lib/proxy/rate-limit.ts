// Per-IP fixed-window limiter, per instance (serverless instances do not share state).
// Default 120/min. Memory is bounded: expired entries are swept and the map is capped.
const WINDOW_MS = 60_000;
const MAX_TRACKED_IPS = 10_000;

function limit(): number {
  return Number(process.env.RATE_LIMIT_PER_MINUTE ?? "120");
}

const hits = new Map<string, number[]>();
let lastSweep = 0;

function sweep(now: number): void {
  for (const [ip, times] of hits) {
    if (times.every((t) => t <= now - WINDOW_MS)) hits.delete(ip);
  }
  // Still over the cap (a flood of distinct addresses): drop the oldest-inserted entries.
  for (const ip of hits.keys()) {
    if (hits.size <= MAX_TRACKED_IPS) break;
    hits.delete(ip);
  }
  lastSweep = now;
}

export function checkRateLimit(
  ip: string,
  now = Date.now(),
): { ok: boolean; retryAfter: number } {
  if (hits.size > MAX_TRACKED_IPS || now - lastSweep > WINDOW_MS) sweep(now);

  const recent = (hits.get(ip) ?? []).filter((t) => t > now - WINDOW_MS);
  if (recent.length >= limit()) {
    hits.set(ip, recent);
    const retryAfter = Math.max(
      1,
      Math.ceil((recent[0] + WINDOW_MS - now) / 1000),
    );
    return { ok: false, retryAfter };
  }
  recent.push(now);
  hits.delete(ip); // re-insert so the map stays ordered by recency
  hits.set(ip, recent);
  return { ok: true, retryAfter: 0 };
}

export function _trackedIpsForTests(): number {
  return hits.size;
}

export function _clearRateLimitForTests(): void {
  hits.clear();
  lastSweep = 0;
}
