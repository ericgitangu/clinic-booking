import { randomUUID } from "node:crypto";
import { defineConfig } from "@playwright/test";

// Runs against the REAL stack: this app built for production (`pnpm build` first), the real API
// and the real Postgres from docker compose, reached at E2E_API_URL. Nothing is stubbed; see
// e2e/support/test-auth.ts for the one stand-in (Google's own sign-in). Locally it uses the
// installed Chrome; PW_BUNDLED uses the Chromium Playwright downloads.
//
// Required in the environment, the same values the API was started with:
//   E2E_API_URL, INTERNAL_SIGNING_KEY, ADMIN_EMAILS, BETTER_AUTH_SECRET
// The port the production build is served on; override it when 3101 is taken.
const PORT = Number(process.env.ADMIN_E2E_PORT ?? 3101);
const ORIGIN = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  expect: { timeout: 15_000 },
  reporter: "list",
  // Specs that read or change the clinic-wide numbers (the dashboard and its cached metrics) cannot
  // overlap with anything else that changes them, so with more than one worker they run after the
  // rest, one project at a time. The others never touch those numbers and run side by side.
  projects: [
    {
      name: "independent",
      testIgnore: [
        "**/dashboard.spec.ts",
        "**/metrics-cache.spec.ts",
        "**/one-hour-rule.spec.ts",
      ],
    },
    {
      name: "dashboard",
      testMatch: "**/dashboard.spec.ts",
      dependencies: ["independent"],
    },
    {
      name: "metrics-cache",
      testMatch: "**/metrics-cache.spec.ts",
      dependencies: ["dashboard"],
    },
    {
      // Books a visit and leaves it, which changes the clinic-wide numbers. Its own project, after
      // metrics-cache: two files in one project run side by side with more than one worker, and
      // the cache spec asserts the numbers do not move while it runs.
      name: "one-hour-rule",
      testMatch: "**/one-hour-rule.spec.ts",
      dependencies: ["metrics-cache"],
    },
  ],
  use: {
    baseURL: ORIGIN,
    ...(process.env.PW_CHROME_PATH
      ? { launchOptions: { executablePath: process.env.PW_CHROME_PATH } }
      : process.env.PW_BUNDLED
        ? {}
        : { channel: "chrome" }),
  },
  webServer: {
    // The dashboard metrics are cached on disk for sixty seconds. A server started within
    // a minute of the last run would otherwise serve that run's numbers for this run's database, so
    // each run starts with an empty data cache.
    command: `rm -rf .next/cache/fetch-cache && pnpm exec next start -p ${PORT}`,
    url: `${ORIGIN}/robots.txt`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      API_URL: process.env.E2E_API_URL ?? "",
      INTERNAL_SIGNING_KEY: process.env.INTERNAL_SIGNING_KEY ?? "",
      ADMIN_EMAILS: process.env.ADMIN_EMAILS ?? "",
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "",
      BETTER_AUTH_URL: ORIGIN,
      // Present only so the auth instance can be built; no test ever reaches Google.
      GOOGLE_CLIENT_ID: randomUUID(),
      GOOGLE_CLIENT_SECRET: randomUUID(),
    },
  },
});
