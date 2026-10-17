import { defineConfig } from "@playwright/test";

// Runs against a production build served on 3100 (`pnpm build` first). Locally it uses the
// installed Chrome; CI sets PW_BUNDLED to use the Chromium Playwright downloads (the image's Chrome is not on a fixed path).
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  // A shared CI runner is slow on the first request to each page; a booking is several API calls.
  expect: { timeout: 15_000 },
  workers: process.env.CI ? 2 : undefined,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3100",
    ...(process.env.PW_CHROME_PATH
      ? { launchOptions: { executablePath: process.env.PW_CHROME_PATH } }
      : process.env.PW_BUNDLED
        ? {}
        : { channel: "chrome" }),
  },
  // Every scenario runs against the real API and database: docker compose with migrations and
  // seed (`make e2e` starts it; CI's e2e-real job does too). E2E_API_URL points elsewhere if needed.
  webServer: {
    command: "pnpm exec next start -p 3100",
    url: "http://localhost:3100",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      API_URL: process.env.E2E_API_URL ?? "http://127.0.0.1:8080",
      // The human check is off for test runs only (see lib/human-check.ts); there is no Google here.
      E2E: "1",
      RECAPTCHA_ENFORCE: "false",
      // The same values the API was started with (make e2e and the e2e-real job generate them).
      INTERNAL_SIGNING_KEY: process.env.INTERNAL_SIGNING_KEY ?? "",
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "",
      BETTER_AUTH_URL: "http://localhost:3100",
      // Present only so the auth instance can be built; the tests never complete a Google sign-in.
      GOOGLE_CLIENT_ID: "e2e-google-client-id",
      GOOGLE_CLIENT_SECRET: "e2e-google-client-secret",
    },
  },
});
