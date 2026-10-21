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
// The stand-in for Resend's HTTP API (the booking suite's, on a port of its own).
const RESEND_PORT = Number(process.env.ADMIN_E2E_RESEND_PORT ?? 3298);
const RESEND_KEY = ["re", "e2e", "standin", "key"].join("_"); // ggignore

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  expect: { timeout: 15_000 },
  // The json file carries each skip and its reason, which the list reporter does not print.
  reporter: [["list"], ["json", { outputFile: "test-results/results.json" }]],
  // Specs that read or change the clinic-wide numbers (the dashboard and its cached metrics) cannot
  // overlap with anything else that changes them, so with more than one worker they run after the
  // rest, one project at a time. The others never touch those numbers and run side by side.
  projects: [
    {
      name: "independent",
      testIgnore: [
        "**/dashboard.spec.ts",
        "**/staff-ops.spec.ts",
        "**/drill-down.spec.ts",
        "**/detail-views.spec.ts",
        "**/metrics-cache.spec.ts",
        "**/one-hour-rule.spec.ts",
        "**/live-feed.spec.ts",
        "**/live-notifications.spec.ts",
        "**/doctor-notification.spec.ts",
      ],
    },
    // Each of these books, cancels, marks or moves visits, or reads the clinic-wide figures they
    // change, so no two may run side by side: one project each, in a chain. (Two files of one
    // project do run side by side when there is more than one worker.)
    {
      name: "dashboard",
      testMatch: "**/dashboard.spec.ts",
      dependencies: ["independent"],
    },
    {
      name: "staff-ops",
      testMatch: "**/staff-ops.spec.ts",
      dependencies: ["dashboard"],
    },
    {
      name: "drill-down",
      testMatch: "**/drill-down.spec.ts",
      dependencies: ["staff-ops"],
    },
    {
      name: "detail-views",
      testMatch: "**/detail-views.spec.ts",
      dependencies: ["drill-down"],
    },
    {
      name: "metrics-cache",
      testMatch: "**/metrics-cache.spec.ts",
      dependencies: ["detail-views"],
    },
    {
      // Books a visit and leaves it, which changes the clinic-wide numbers. Its own project, after
      // metrics-cache: two files in one project run side by side with more than one worker, and
      // the cache spec asserts the numbers do not move while it runs.
      name: "one-hour-rule",
      testMatch: "**/one-hour-rule.spec.ts",
      dependencies: ["metrics-cache"],
    },
    // The live feed books and cancels while dashboards are open, which moves the clinic-wide numbers
    // and fills the metrics cache; it runs last so no other spec starts from those numbers.
    {
      name: "live-feed",
      testMatch: "**/live-feed.spec.ts",
      dependencies: ["one-hour-rule"],
    },
    // Both mark visits arrived and book while a dashboard is open, so they run after the live feed
    // and one after the other.
    {
      name: "live-notifications",
      testMatch: "**/live-notifications.spec.ts",
      dependencies: ["live-feed"],
    },
    {
      name: "doctor-notification",
      testMatch: "**/doctor-notification.spec.ts",
      dependencies: ["live-notifications"],
    },
  ],
  use: {
    baseURL: ORIGIN,
    // Kept for a failed scenario only (written to ./test-results, the default outputDir), so CI can
    // store them (.circleci/config.yml, admin-e2e). No screenshots or video: the trace holds both.
    trace: "retain-on-failure",
    ...(process.env.PW_CHROME_PATH
      ? { launchOptions: { executablePath: process.env.PW_CHROME_PATH } }
      : process.env.PW_BUNDLED
        ? {}
        : { channel: "chrome" }),
  },
  webServer: [
    {
      // STAND-IN for Resend's HTTP API only; the app, the API and the database are real.
      command: "node ../booking/e2e/support/resend-standin.mjs",
      url: `http://127.0.0.1:${RESEND_PORT}/_health`,
      reuseExistingServer: false,
      timeout: 15_000,
      env: {
        RESEND_STANDIN_PORT: String(RESEND_PORT),
        RESEND_API_KEY: RESEND_KEY,
      },
    },
    {
      // The dashboard metrics are cached on disk for sixty seconds. A server started within
      // a minute of the last run would otherwise serve that run's numbers for this run's database, so
      // each run starts with an empty data cache.
      command: `rm -rf .next/cache/fetch-cache && pnpm exec next start -p ${PORT}`,
      url: `${ORIGIN}/robots.txt`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        API_URL: process.env.E2E_API_URL ?? "",
        // The live-feed gateway from docker compose (profile "realtime").
        REALTIME_URL: process.env.E2E_REALTIME_URL ?? "",
        INTERNAL_SIGNING_KEY: process.env.INTERNAL_SIGNING_KEY ?? "",
        ADMIN_EMAILS: process.env.ADMIN_EMAILS ?? "",
        BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "",
        BETTER_AUTH_URL: ORIGIN,
        // The e2e error fixture (page.e2e.tsx) only gets a nonce at runtime when this is set.
        SHELL_E2E: "1",
        // Present only so the auth instance can be built; no test ever reaches Google.
        GOOGLE_CLIENT_ID: randomUUID(),
        GOOGLE_CLIENT_SECRET: randomUUID(),
        // Email goes to the stand-in, with the key it expects.
        RESEND_API_KEY: RESEND_KEY,
        RESEND_BASE_URL: `http://127.0.0.1:${RESEND_PORT}`,
      },
    },
  ],
});
