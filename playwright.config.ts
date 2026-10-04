import { defineConfig } from "@playwright/test";
import { APP_URL } from "./e2e/env.mjs";

export default defineConfig({
  testDir: "./e2e",
  // The tests share one database and cache, so they run one at a time.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: APP_URL,
    // Drives the installed Google Chrome, so no separate browser download is needed.
    channel: "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // Starts the mock API and the app unless they're already running (CI starts them itself).
  webServer: {
    command: "node e2e/serve.mjs",
    url: `${APP_URL}/api/health`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
