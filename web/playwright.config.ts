import { defineConfig } from "@playwright/test";

// Runs against a production build served on 3100 (`pnpm build` first). Locally it uses the
// installed Chrome; CI sets PW_CHANNEL to the one in its image.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3100",
    channel: process.env.PW_CHANNEL ?? "chrome",
  },
  webServer: {
    command: "pnpm exec next start -p 3100",
    url: "http://localhost:3100",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
