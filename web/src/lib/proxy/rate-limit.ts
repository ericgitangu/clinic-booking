// Per-IP fixed-window limiter, per instance (ADR-0023). Default 120/min.
const WINDOW_MS = 60_000;

function limit(): number {
  return Number(process.env.RATE_LIMIT_PER_MINUTE ?? "120");
}

const hits = new Map<string, number[]>();

export function checkRateLimit(
  ip: string,
  now = Date.now(),
): { ok: boolean; retryAfter: number } {
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
  hits.set(ip, recent);
  return { ok: true, retryAfter: 0 };
}

export function _clearRateLimitForTests(): void {
  hits.clear();
}
