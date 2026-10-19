import { describe, expect, it } from "vitest";
import { isLocalUrl, rateLimitFor } from "@/lib/auth-options";

const LOCAL = "http://localhost:3100";
const PROD = "https://clinic.ericgitangu.com";

// Production keeps Better Auth's limit (100 per 10 seconds, memory) and does not touch `enabled`, so
// the library default (on in production builds) applies. Only a test run on this machine lifts it.
describe("rateLimitFor", () => {
  it("production: 100 per 10 seconds, in memory, `enabled` left to the library", () => {
    const limit = rateLimitFor({ NODE_ENV: "production", BETTER_AUTH_URL: PROD });
    expect(limit).toEqual({ window: 10, max: 100, storage: "memory" });
    expect("enabled" in limit).toBe(false);
  });

  // [VERCEL_ENV, NODE_ENV, E2E, BETTER_AUTH_URL, lifted?]
  it.each([
    ["production", "test", "1", LOCAL, false],
    ["production", "production", "1", PROD, false],
    [undefined, "production", "1", PROD, false], // a non-Vercel host with E2E set
    ["preview", "production", "1", PROD, false], // a public preview with E2E set
    [undefined, "production", "1", undefined, false], // no base URL at all
    [undefined, "production", "1", "http://localhost.evil.example", false],
    [undefined, "production", undefined, LOCAL, false], // local but not a test run
    [undefined, "production", "1", LOCAL, true], // the browser suite
    [undefined, "test", undefined, "http://127.0.0.1:3100", true],
  ] as const)(
    "VERCEL_ENV=%s NODE_ENV=%s E2E=%s url=%s -> lifted %s",
    (vercel, node, e2e, url, lifted) => {
      const max = rateLimitFor({
        VERCEL_ENV: vercel,
        NODE_ENV: node,
        E2E: e2e,
        BETTER_AUTH_URL: url,
      }).max;
      expect(max).toBe(lifted ? 100_000 : 100);
    },
  );

  it("isLocalUrl only accepts this machine", () => {
    expect(isLocalUrl("http://localhost:3100")).toBe(true);
    expect(isLocalUrl("http://app.localhost")).toBe(true);
    expect(isLocalUrl("https://clinic.ericgitangu.com")).toBe(false);
    expect(isLocalUrl("not a url")).toBe(false);
  });
});
