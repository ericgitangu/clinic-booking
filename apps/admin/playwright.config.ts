import { randomUUID } from "node:crypto";
import { defineConfig } from "@playwright/test";

// Runs against the REAL stack: this app built for production (`pnpm build` first), the real API
// and the real Postgres from docker compose, reached at E2E_API_URL. Nothing is stubbed; see
// e2e/support/test-auth.ts for the one stand-in (Google's own sign-in). Locally it uses the
// installed Chrome; PW_BUNDLED uses the Chromium Playwright downloads.
//
// Required in the environment, the same values the API was started with:
//   E2E_API_URL, INTERNAL_SIGNING_KEY, ADMIN_EMAILS, BETTER_AUTH_SECRET
export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  expect: { timeout: 15_000 },
  reporter: "list",
  use: {
    baseURL: "http://localhost:3101",
    ...(process.env.PW_CHROME_PATH
      ? { launchOptions: { executablePath: process.env.PW_CHROME_PATH } }
      : process.env.PW_BUNDLED
        ? {}
        : { channel: "chrome" }),
  },
  webServer: {
    command: "pnpm exec next start -p 3101",
    url: "http://localhost:3101/robots.txt",
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      API_URL: process.env.E2E_API_URL ?? "",
      INTERNAL_SIGNING_KEY: process.env.INTERNAL_SIGNING_KEY ?? "",
      ADMIN_EMAILS: process.env.ADMIN_EMAILS ?? "",
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "",
      BETTER_AUTH_URL: "http://localhost:3101",
      // Present only so the auth instance can be built; no test ever reaches Google.
      GOOGLE_CLIENT_ID: randomUUID(),
      GOOGLE_CLIENT_SECRET: randomUUID(),
    },
  },
});
