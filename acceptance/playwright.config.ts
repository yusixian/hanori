import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// cos-tool-bot acceptance 配置。隔离环境由 acceptance/scripts/run.mjs 启动
// （专用数据库 + :43110 server + panel 构建产物），Playwright 只负责驱动浏览器。
const runDir =
  process.env.ACCEPTANCE_RUN_DIR ?? path.resolve(import.meta.dirname, "../.acceptance/runs/ad-hoc");

const baseURL = process.env.ACCEPTANCE_BASE_URL ?? "http://localhost:43110/";

export default defineConfig({
  testDir: "./specs",
  globalSetup: "./global-setup.ts",
  outputDir: path.join(runDir, "playwright-artifacts"),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: path.join(runDir, "playwright-results.json") }]],
  use: {
    baseURL,
    screenshot: "only-on-failure",
    video: process.env.ACCEPTANCE_VIDEO === "on" ? "on" : "retain-on-failure",
    trace: "retain-on-failure",
    locale: "en-US",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } },
    },
  ],
});
