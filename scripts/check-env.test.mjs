import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("./check-env.mjs", import.meta.url));
const docker = {
  DB_PASSWORD: "test-database-credential",
  BETTER_AUTH_SECRET: "test-auth-secret-" + "a".repeat(32),
  ENCRYPTION_KEY: "test-encryption-credential",
  BETTER_AUTH_URL: "https://bot.example.com",
  AUTH_OWNER_EMAIL: "owner@example.com",
};
const githubApp = {
  GITHUB_APP_ID: "123",
  GITHUB_APP_CLIENT_ID: "test-client-id",
  GITHUB_APP_CLIENT_SECRET: "test-github-credential",
  GITHUB_APP_PRIVATE_KEY:
    "-----BEGIN PRIVATE KEY-----\\nfixture\\ntest-private-key\\n-----END PRIVATE KEY-----",
  GITHUB_APP_SLUG: "hanori-test",
};

let cwd;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "check-env-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function run(...args) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
}

function writeEnv(env, file = ".env") {
  const contents = Object.entries(env)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => name + "=" + value)
    .join("\n");
  writeFileSync(join(cwd, file), contents + "\n", { mode: 0o600 });
}

describe("deployment environment check", () => {
  it("validates a Docker environment with the default options", () => {
    writeEnv(docker);
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("passed (docker)");
    expect(result.stderr).not.toMatch(/^(?:WARNING|ERROR):/m);
  });

  it("warns about a bootstrap password without failing the check", () => {
    writeEnv({ ...docker, PANEL_PASSWORD: "test-bootstrap-credential" });
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(
      /WARNING:.*PANEL_PASSWORD.*after the first successful owner login/,
    );
    expect(result.stdout + result.stderr).not.toContain("test-bootstrap-credential");
  });

  it.each(Object.keys(docker))("rejects a missing required Docker value: %s", (key) => {
    writeEnv({ ...docker, [key]: undefined });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(key);
  });

  it("rejects example secrets and the example database password", () => {
    writeEnv({
      ...docker,
      DB_PASSWORD: "password",
      BETTER_AUTH_SECRET: "change-me-to-a-random-secret-at-least-32-characters",
      ENCRYPTION_KEY: "change-me",
    });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DB_PASSWORD");
    expect(result.stderr).toContain("BETTER_AUTH_SECRET");
    expect(result.stderr).toContain("ENCRYPTION_KEY");
  });

  it("rejects a short auth secret and malformed owner email", () => {
    writeEnv({ ...docker, BETTER_AUTH_SECRET: "short", AUTH_OWNER_EMAIL: "nobody@example..com" });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("at least 32 characters");
    expect(result.stderr).toContain("AUTH_OWNER_EMAIL");
  });

  it.each([
    "http://bot.example.com",
    "http://127.example.com",
    "https:/bot.example.com",
    "https://bot.example.com:99999",
    "https://user:secret@bot.example.com",
    "https://bot.example.com/path",
    "https://bot.example.com/.",
    "https://bot.example.com?",
    "'https://bot.example.com#fragment'",
  ])("rejects a URL that is not an allowed origin: %s", (url) => {
    writeEnv({ ...docker, BETTER_AUTH_URL: url });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("BETTER_AUTH_URL");
  });

  it.each(["http://localhost:43100", "http://127.0.0.1:43100", "http://[::1]:43100"])(
    "accepts loopback HTTP: %s",
    (url) => {
      writeEnv({ ...docker, BETTER_AUTH_URL: url });
      expect(run().status).toBe(0);
    },
  );

  it("supports a custom path and requires DATABASE_URL in local mode", () => {
    const env = { ...docker, DB_PASSWORD: undefined };
    const args = ["--mode", "local", "--file", "local.env"];
    writeEnv(env, "local.env");
    expect(run(...args).stderr).toContain("DATABASE_URL");
    writeEnv(
      { ...env, DATABASE_URL: "postgresql://bot:password@localhost:43105/cos_tool_bot" },
      "local.env",
    );
    const result = run(...args);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("passed (local)");
  });

  it("rejects a partially configured GitHub App", () => {
    writeEnv({ ...docker, GITHUB_APP_ID: githubApp.GITHUB_APP_ID });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Set all five GitHub App variables");
    expect(result.stderr).toContain("GITHUB_APP_SLUG");
  });

  it("accepts all five GitHub App values and a single-line PEM", () => {
    writeEnv({ ...docker, ...githubApp });
    expect(run().status).toBe(0);
  });

  it.each(["", "'"])("rejects raw PEM newlines with quote %j", (quote) => {
    const multiline = githubApp.GITHUB_APP_PRIVATE_KEY.replaceAll("\\n", "\n");
    writeEnv({ ...docker, ...githubApp, GITHUB_APP_PRIVATE_KEY: quote + multiline + quote });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("GITHUB_APP_PRIVATE_KEY");
    expect(result.stderr).toContain("literal \\n");
  });

  it("checks both worker secrets when both profiles are enabled", () => {
    const env = { ...docker, COMPOSE_PROFILES: "coding, media" };
    writeEnv(env);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CODING_WORKER_SECRET");
    expect(result.stderr).toContain("MEDIA_WORKER_SECRET");
    writeEnv({
      ...env,
      CODING_WORKER_SECRET: "a".repeat(64),
      MEDIA_WORKER_SECRET: "b".repeat(64),
    });
    expect(run().status).toBe(0);
  });

  it("does not echo secrets, URL credentials, invalid arguments, or missing file paths", () => {
    const urlPassword = "test-url-credential";
    writeEnv({
      ...docker,
      ...githubApp,
      BETTER_AUTH_URL: "https://user:" + urlPassword + "@example.com",
    });
    const result = run();
    expect(result.status).toBe(1);
    for (const secret of [
      docker.DB_PASSWORD,
      docker.BETTER_AUTH_SECRET,
      docker.ENCRYPTION_KEY,
      githubApp.GITHUB_APP_CLIENT_SECRET,
      "test-private-key",
      urlPassword,
    ]) {
      expect(result.stdout + result.stderr).not.toContain(secret);
    }
    for (const args of [["--" + urlPassword], ["--file", urlPassword], ["--mode", urlPassword]]) {
      const invalid = run(...args);
      expect(invalid.status).toBe(1);
      expect(invalid.stdout + invalid.stderr).not.toContain(urlPassword);
    }
  });

  it("prints help without opening an environment file", () => {
    const result = run("--help");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--mode <docker|local>");
  });
});
