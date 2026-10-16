import { beforeEach, describe, expect, it } from "vitest";
import {
  _clearRateLimitForTests,
  _trackedIpsForTests,
  checkRateLimit,
  clientKey,
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

describe("RATE_LIMIT_PER_MINUTE parsing", () => {
  it.each(["abc", "", "NaN", "-5", "0"])(
    "%j falls back to 120 and the limiter still limits",
    (value) => {
      process.env.RATE_LIMIT_PER_MINUTE = value;
      const t = 1_000_000;
      for (let i = 0; i < 120; i++)
        expect(checkRateLimit("1.1.1.1", t + i).ok).toBe(true);
      expect(checkRateLimit("1.1.1.1", t + 121).ok).toBe(false);
    },
  );
});

describe("clientKey", () => {
  it("keeps an IPv4 address as is", () => {
    expect(clientKey("203.0.113.9")).toBe("203.0.113.9");
  });
  it("maps an IPv4-mapped IPv6 address to its IPv4", () => {
    expect(clientKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
  });
  it("collapses an IPv6 client to its /64", () => {
    const a = clientKey("2001:db8:abcd:12:1:2:3:4");
    expect(a).toBe("2001:db8:abcd:12::/64");
    expect(clientKey("2001:db8:abcd:12:ffff:ffff:ffff:ffff")).toBe(a);
    expect(clientKey("2001:db8:abcd:13::1")).not.toBe(a);
  });
  it("expands :: before taking the prefix", () => {
    expect(clientKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(clientKey("::1")).toBe("0:0:0:0::/64");
  });
  it("a missing address is its own untrusted client", () => {
    expect(clientKey(null)).toBe("unknown");
    expect(clientKey(undefined)).toBe("unknown");
    expect(clientKey("")).toBe("unknown");
  });
});

describe("limits keyed by client", () => {
  it("many addresses inside one /64 share a single bucket", () => {
    process.env.RATE_LIMIT_PER_MINUTE = "3";
    const t = 1_000_000;
    expect(checkRateLimit("2001:db8:1:1::a", t).ok).toBe(true);
    expect(checkRateLimit("2001:db8:1:1::b", t + 1).ok).toBe(true);
    expect(checkRateLimit("2001:db8:1:1::c", t + 2).ok).toBe(true);
    expect(checkRateLimit("2001:db8:1:1::d", t + 3).ok).toBe(false);
  });
  it("requests with no address share a much smaller bucket than real clients", () => {
    process.env.RATE_LIMIT_PER_MINUTE = "120";
    const t = 1_000_000;
    for (let i = 0; i < 10; i++)
      expect(checkRateLimit(null, t + i).ok).toBe(true);
    expect(checkRateLimit(null, t + 11).ok).toBe(false);
    expect(checkRateLimit("198.51.100.1", t + 12).ok).toBe(true);
  });
});
