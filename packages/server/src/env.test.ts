import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnvironment = { ...process.env };
const requiredEnvironment = {
  DATABASE_URL: "postgresql://bot:password@localhost:5432/cos_tool_bot",
  BETTER_AUTH_SECRET: "test-secret-at-least-32-characters",
  BETTER_AUTH_URL: "https://bot.example.com",
  AUTH_OWNER_EMAIL: "owner@example.com",
};

async function loadEnvironment(
  nodeEnvironment: "development" | "production",
  encryptionKey?: string,
) {
  process.env = {
    ...originalEnvironment,
    ...requiredEnvironment,
    NODE_ENV: nodeEnvironment,
  };
  if (encryptionKey === undefined) {
    delete process.env.ENCRYPTION_KEY;
  } else {
    process.env.ENCRYPTION_KEY = encryptionKey;
  }
  vi.resetModules();
  return (await import("./env.js")).env;
}

afterEach(() => {
  process.env = { ...originalEnvironment };
  vi.resetModules();
});

describe("server environment", () => {
  it("keeps the legacy encryption key fallback during a production migration", async () => {
    const developmentEnvironment = await loadEnvironment("development");
    const productionEnvironment = await loadEnvironment("production", "");

    expect(productionEnvironment.ENCRYPTION_KEY).toBe(developmentEnvironment.ENCRYPTION_KEY);
    expect(productionEnvironment.USING_DEFAULT_ENCRYPTION_KEY).toBe(true);
  });
});
