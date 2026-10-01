import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const directories = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("deployment environment initialization", () => {
  it("generates independent secrets privately and never overwrites an existing environment", () => {
    const directory = mkdtempSync(join(tmpdir(), "deployment-env-"));
    directories.push(directory);
    const output = join(directory, ".env");
    const args = [
      resolve("scripts/init-env.mjs"),
      "--email",
      "owner@example.com",
      "--url",
      "https://bot.example.com",
      "--output",
      output,
    ];
    const stdout = execFileSync(process.execPath, args, { encoding: "utf8" });
    const contents = readFileSync(output, "utf8");
    const secrets = [
      ...contents.matchAll(
        /^(?:DB_PASSWORD|BETTER_AUTH_SECRET|ENCRYPTION_KEY|PANEL_PASSWORD|MINI_APP_SESSION_SECRET)=([a-f0-9]+)$/gm,
      ),
    ].map((match) => match[1]);
    expect(secrets).toHaveLength(5);
    expect(new Set(secrets).size).toBe(5);
    for (const secret of secrets) {
      expect(secret.length).toBeGreaterThanOrEqual(48);
      expect(stdout).not.toContain(secret);
    }
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(contents).toContain("NSFW_API_URL=http://nsfw-api:3000");
    expect(contents).toContain("DATABASE_URL=\n");
    expect(spawnSync(process.execPath, args).status).not.toBe(0);
    expect(readFileSync(output, "utf8")).toBe(contents);
  });

  it.each([
    "http://bot.example.com",
    "https://user:secret@bot.example.com",
    "https://bot.example.com/path",
    "https://bot.example.com?q=1",
  ])("rejects unsafe origins: %s", (url) => {
    const result = spawnSync(process.execPath, [
      resolve("scripts/init-env.mjs"),
      "--email",
      "owner@example.com",
      "--url",
      url,
    ]);
    expect(result.status).not.toBe(0);
  });
});
