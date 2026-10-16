import { beforeEach, describe, expect, it } from "vitest";
import {
  _clearRateLimitForTests,
  _trackedIpsForTests,
  checkRateLimit,
} from "@/lib/proxy/rate-limit";

beforeEach(() => {
  _clearRateLimitForTests();
  process.env.RATE_LIMIT_PER_MINUTE = "2";
});

describe("checkRateLimit", () => {
  it("blocks the request after the per-minute limit and reports Retry-After", () => {
    const t = 1_000_000;
    expect(checkRateLimit("1.1.1.1", t).ok).toBe(true);
    expect(checkRateLimit("1.1.1.1", t + 1).ok).toBe(true);
    const blocked = checkRateLimit("1.1.1.1", t + 2);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
    expect(checkRateLimit("2.2.2.2", t + 3).ok).toBe(true); // other clients unaffected
  });

  it("allows the client again once its window has passed", () => {
    const t = 1_000_000;
    checkRateLimit("1.1.1.1", t);
    checkRateLimit("1.1.1.1", t + 1);
    expect(checkRateLimit("1.1.1.1", t + 61_000).ok).toBe(true);
  });

  it("evicts idle clients so memory stays bounded", () => {
    const t = 1_000_000;
    for (let i = 0; i < 50; i++) checkRateLimit(`10.0.0.${i}`, t);
    expect(_trackedIpsForTests()).toBe(50);
    checkRateLimit("9.9.9.9", t + 120_000); // a later request triggers the sweep
    expect(_trackedIpsForTests()).toBe(1);
  });

  it("caps the number of tracked clients under a flood of distinct addresses", () => {
    const t = 1_000_000;
    for (let i = 0; i < 12_000; i++) checkRateLimit(`ip-${i}`, t);
    expect(_trackedIpsForTests()).toBeLessThanOrEqual(10_001);
  });
});
