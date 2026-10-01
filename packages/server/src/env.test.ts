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
  it.each(["development", "production"] as const)(
    "requires an explicit key in %s",
    async (mode) => {
      await expect(loadEnvironment(mode)).rejects.toThrow("Missing required env: ENCRYPTION_KEY");
      await expect(loadEnvironment(mode, "")).rejects.toThrow(
        "Missing required env: ENCRYPTION_KEY",
      );
    },
  );

  it.each(["development", "production"] as const)("preserves the exact key in %s", async (mode) => {
    const key = "  synthetic-$key#with-spaces  ";
    const environment = await loadEnvironment(mode, key);
    expect(environment.ENCRYPTION_KEY).toBe(key);
    expect(environment).not.toHaveProperty("USING_DEFAULT_ENCRYPTION_KEY");
  });
});
