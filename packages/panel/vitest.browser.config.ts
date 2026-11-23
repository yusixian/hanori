import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Dynamic dev-tool imports must not trigger a page reload while browser tests are running.
  optimizeDeps: { include: ["react-grab", "react-dom/client"] },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["src/**/*.browser.test.tsx"],
    browser: {
      enabled: true,
      provider: playwright({ contextOptions: { timezoneId: "UTC" } }),
      instances: [{ browser: "chromium" }],
      headless: true,
    },
  },
});
