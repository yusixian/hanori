import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

// Use a separate port when running the suite alongside a local preview.
const port = process.env.CI ? 4175 : 43104;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./docs",
  outputDir: "../.acceptance/public-docs",
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } },
  ],
  webServer: {
    command: "pnpm preview:docs",
    cwd: resolve(import.meta.dirname, ".."),
    url: `${baseURL}/docs/`,
    env: { DOCS_PREVIEW_PORT: String(port) },
    reuseExistingServer: !process.env.CI,
  },
});
