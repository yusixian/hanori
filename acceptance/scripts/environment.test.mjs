import { describe, expect, it } from "vitest";
import { createAcceptanceServerEnvironment } from "./environment.mjs";

describe("createAcceptanceServerEnvironment", () => {
  it("forwards host process essentials without leaking integration credentials", () => {
    const environment = createAcceptanceServerEnvironment(
      {
        HOME: "/tmp/acceptance-home",
        PATH: "/usr/bin",
        PIXAI_MCP_URL: "https://production.example.test/mcp",
        GITHUB_APP_PRIVATE_KEY: "production-private-key",
        CODING_WORKER_SECRET: "production-worker-secret",
      },
      {
        NODE_ENV: "development",
        DATABASE_URL: "postgresql://acceptance",
      },
    );

    expect(environment).toMatchObject({
      HOME: "/tmp/acceptance-home",
      PATH: "/usr/bin",
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://acceptance",
    });
    expect(environment).not.toHaveProperty("PIXAI_MCP_URL");
    expect(environment).not.toHaveProperty("GITHUB_APP_PRIVATE_KEY");
    expect(environment).not.toHaveProperty("CODING_WORKER_SECRET");
  });
});
