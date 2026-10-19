import { describe, expect, it } from "vitest";
import { rateLimitFor } from "@/lib/auth-options";

// Production keeps Better Auth's default limit, now written down. Only a test run relaxes it.
describe("rateLimitFor", () => {
  it("production: on, 100 per 10 seconds, in memory", () => {
    expect(rateLimitFor({ NODE_ENV: "production" })).toEqual({
      enabled: true,
      window: 10,
      max: 100,
      storage: "memory",
    });
  });
  it("an end-to-end run lifts the ceiling so the suite cannot trip it", () => {
    expect(rateLimitFor({ NODE_ENV: "production", E2E: "1" }).max).toBe(
      100_000,
    );
    expect(rateLimitFor({ NODE_ENV: "test" }).max).toBe(100_000);
  });
  it("never lifted on Vercel production, whatever else is set", () => {
    expect(
      rateLimitFor({ VERCEL_ENV: "production", E2E: "1", NODE_ENV: "test" })
        .max,
    ).toBe(100);
  });
  it("stays on in a test run (the limiter is not switched off)", () => {
    expect(rateLimitFor({ E2E: "1" }).enabled).toBe(true);
  });
});
