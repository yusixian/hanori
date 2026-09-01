import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/{bot,server,shared,coding-worker}/src/**/*.test.ts",
      "acceptance/**/*.test.mjs",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: [
        "packages/server/src/services/run-redaction.ts",
        "packages/server/src/services/bot-run-service.ts",
      ],
      thresholds: { branches: 90, functions: 90, lines: 90, statements: 90 },
    },
  },
});
