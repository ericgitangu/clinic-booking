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
  webServer: {
    command: "pnpm exec next start -p 3100",
    url: "http://localhost:3100",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
