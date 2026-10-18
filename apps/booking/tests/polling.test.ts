import { describe, expect, it } from "vitest";
import {
  IDLE_MS,
  MAX_BACKOFF_MS,
  MAX_RETRY_AFTER_MS,
  POLL_MS,
  parseRetryAfter,
  pollInterval,
} from "@/lib/polling";

describe("patient polling", () => {
  it("polls every 15 s and goes idle after 10 minutes", () => {
    expect(POLL_MS).toBe(15_000);
    expect(IDLE_MS).toBe(600_000);
  });

  it("refetches on the interval until the person goes idle, then stops", () => {
    expect(pollInterval(false)).toBe(POLL_MS);
    expect(pollInterval(true)).toBe(false);
  });

  it("backs off 15, 30, 60, 120 s on consecutive failures and caps there", () => {
    expect(
      [0, 1, 2, 3, 4, 10, 1000].map((n) => pollInterval(false, n)),
    ).toEqual([15_000, 30_000, 60_000, 120_000, 120_000, 120_000, 120_000]);
    expect(MAX_BACKOFF_MS).toBe(120_000);
    expect(pollInterval(true, 3)).toBe(false); // idle still wins over backoff
  });

  it("takes the longer of the backoff and Retry-After", () => {
    expect(pollInterval(false, 0, 60_000)).toBe(60_000);
    expect(pollInterval(false, 3, 60_000)).toBe(120_000);
    expect(pollInterval(false, 1, 0)).toBe(30_000);
    expect(pollInterval(true, 0, 60_000)).toBe(false);
  });

  describe("parseRetryAfter", () => {
    const now = Date.parse("2026-10-18T10:00:00Z");
    it("reads seconds", () => {
      expect(parseRetryAfter("60", now)).toBe(60_000);
      expect(parseRetryAfter(" 0 ", now)).toBe(0);
    });
    it("reads an HTTP date, a past date as zero", () => {
      expect(parseRetryAfter("Sun, 18 Oct 2026 10:01:30 GMT", now)).toBe(
        90_000,
      );
      expect(parseRetryAfter("Sun, 18 Oct 2026 09:00:00 GMT", now)).toBe(0);
    });
    it("ignores garbage, negatives and empties", () => {
      for (const v of ["soon", "-5", "1.5", "60s", "", "  ", null, undefined])
        expect(parseRetryAfter(v, now), String(v)).toBeNull();
    });
    it("clamps an absurd wait", () => {
      expect(parseRetryAfter("999999999", now)).toBe(MAX_RETRY_AFTER_MS);
      expect(parseRetryAfter("Fri, 31 Dec 9999 23:59:59 GMT", now)).toBe(
        MAX_RETRY_AFTER_MS,
      );
    });
  });
});
