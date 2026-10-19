import { describe, expect, it } from "vitest";
import { shouldTrackRenders } from "@/lib/test-run";

// The render count is written into the page only for a test run: E2E=1 (or NODE_ENV=test), a local
// base URL and not Vercel production. Anything else is a production build and writes nothing.
describe("the render-count hook", () => {
  it("is on for a local test run", () => {
    expect(
      shouldTrackRenders({
        E2E: "1",
        BETTER_AUTH_URL: "http://localhost:3100",
      }),
    ).toBe(true);
    expect(
      shouldTrackRenders({
        NODE_ENV: "test",
        BETTER_AUTH_URL: "http://127.0.0.1:3000",
      }),
    ).toBe(true);
  });

  it.each([
    [
      "a production build",
      {
        NODE_ENV: "production",
        BETTER_AUTH_URL: "https://clinic.ericgitangu.com",
      },
    ],
    [
      "E2E set on a real host",
      { E2E: "1", BETTER_AUTH_URL: "https://clinic.ericgitangu.com" },
    ],
    [
      "E2E set on Vercel production",
      {
        E2E: "1",
        VERCEL_ENV: "production",
        BETTER_AUTH_URL: "http://localhost:3000",
      },
    ],
    ["nothing set", {}],
  ])("is off for %s", (_name, env) => {
    expect(shouldTrackRenders(env)).toBe(false);
  });
});
