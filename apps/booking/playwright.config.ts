import { defineConfig } from "@playwright/test";

// Runs against a production build served on 3100 (`pnpm build` first). Locally it uses the
// installed Chrome; CI sets PW_BUNDLED to use the Chromium Playwright downloads (the image's Chrome is not on a fixed path).
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3100",
    ...(process.env.PW_CHROME_PATH
      ? { launchOptions: { executablePath: process.env.PW_CHROME_PATH } }
      : process.env.PW_BUNDLED
        ? {}
        : { channel: "chrome" }),
  },
  webServer: [
    {
      // The API stand-in for the booking tests (see e2e/fake-api.mjs).
      command: "node e2e/fake-api.mjs",
      url: "http://127.0.0.1:3199/health",
      reuseExistingServer: !process.env.CI,
      timeout: 15_000,
    },
    {
      command: "pnpm exec next start -p 3100",
      url: "http://localhost:3100",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      // Server-side calls go to the stand-in; the human check is off because there is no Google here.
      env: { API_URL: "http://127.0.0.1:3199", RECAPTCHA_ENFORCE: "false" },
    },
  ],
});
