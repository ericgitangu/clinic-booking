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
  // The email-allowance scenario runs by itself after everything else: while the allowance is at its
  // limit, any other scenario's email would be dropped.
  projects: [
    { name: "main", testIgnore: /emails-cap\.spec/ },
    {
      name: "allowance",
      testMatch: /emails-cap\.spec/,
      dependencies: ["main"],
    },
  ],
  use: {
    baseURL: "http://localhost:3100",
    // Kept for a failed scenario only, so CI can store them (.circleci/config.yml, e2e-real).
    trace: "retain-on-failure",
    ...(process.env.PW_CHROME_PATH
      ? { launchOptions: { executablePath: process.env.PW_CHROME_PATH } }
      : process.env.PW_BUNDLED
        ? {}
        : { channel: "chrome" }),
  },
  // Every scenario runs against the real API and database: docker compose with migrations and
  // seed (`make e2e` starts it; CI's e2e-real job does too). E2E_API_URL points elsewhere if needed.
  webServer: [
    {
      // STAND-IN for Resend's HTTP API only (see e2e/support/resend-standin.mjs). Everything else,
      // the app, the API and the database, is real.
      command: "node e2e/support/resend-standin.mjs",
      url: "http://127.0.0.1:3198/_health",
      reuseExistingServer: false,
      timeout: 15_000,
    },
    {
      command: "pnpm exec next start -p 3100",
      url: "http://localhost:3100",
      // Never attach to a server that is already there (another worktree's, say): fail instead.
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        API_URL: process.env.E2E_API_URL ?? "http://127.0.0.1:8080",
        // The e2e error fixture (page.e2e.tsx) only gets a nonce at runtime when this is set.
        SHELL_E2E: "1",
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
        // Email goes to the Resend stand-in. The key is a throwaway the stand-in expects.
        RESEND_API_KEY: ["re", "e2e", "standin", "key"].join("_"), // ggignore
        RESEND_BASE_URL: "http://127.0.0.1:3198",
        CRON_SECRET: process.env.CRON_SECRET ?? "",
      },
    },
    // On a machine with no push-service key (E2E_PUSH_LOCAL=1) the live-update scenarios run against
    // a local stand-in for that third party (e2e/support/fake-push.mjs). CI never sets this: it
    // runs them against the real service with the key from the `ably-ci` context.
    // The same app in development mode on 3101, where React StrictMode mounts every component twice;
    // one scenario checks that this mints no second push token. Only when push is in play.
    ...(process.env.E2E_PUSH_LOCAL || process.env.ABLY_API_KEY
      ? [
          {
            command: "pnpm exec next dev -p 3101",
            // A page, not robots.txt: the server is ready once the proxy, the shell and the booking
            // pages have compiled, so the first compile (slow on a shared runner) is not charged to
            // the scenario that opens a page on it.
            url: "http://localhost:3101/book",
            reuseExistingServer: false,
            timeout: 120_000,
            env: {
              API_URL: process.env.E2E_API_URL ?? "http://127.0.0.1:8080",
              E2E: "1",
              RECAPTCHA_ENFORCE: "false",
              INTERNAL_SIGNING_KEY: process.env.INTERNAL_SIGNING_KEY ?? "",
              BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "",
              BETTER_AUTH_URL: "http://localhost:3101",
              GOOGLE_CLIENT_ID: "e2e-google-client-id",
              GOOGLE_CLIENT_SECRET: "e2e-google-client-secret",
            },
          },
        ]
      : []),
    ...(process.env.E2E_PUSH_LOCAL
      ? [
          {
            command: "node e2e/support/fake-push.mjs",
            url: "http://localhost:3199/__stats",
            reuseExistingServer: false,
            timeout: 20_000,
          },
        ]
      : []),
  ],
});
