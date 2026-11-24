import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const directories = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe.each([
  ["Node", process.execPath, resolve("scripts/init-env.mjs")],
  ["POSIX shell", resolve("scripts/init-env.sh")],
])("%s deployment environment initialization", (_, command, script) => {
  const prefix = script ? [script] : [];
  function temporaryDirectory() {
    const directory = mkdtempSync(join(tmpdir(), "deployment-env-"));
    directories.push(directory);
    return directory;
  }
  it("generates independent secrets privately and never overwrites an existing environment", () => {
    const directory = temporaryDirectory();
    const output = join(directory, ".env");
    const args = [
      ...prefix,
      "--email",
      "owner@example.com",
      "--url",
      "https://bot.example.com",
      "--output",
      output,
    ];
    const stdout = execFileSync(command, args, { encoding: "utf8" });
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
    expect(contents).toContain("CODING_WORKER_URL=\n");
    expect(spawnSync(command, args).status).not.toBe(0);
    expect(readFileSync(output, "utf8")).toBe(contents);
  });

  it.each([
    "http://bot.example.com",
    "https://user:secret@bot.example.com",
    "https://bot.example.com/path",
    "https://bot.example.com?q=1",
    "https://999.0.0.1",
    "https://bot.example.com:65536",
    "https://[:::::]",
    "https://bot.example.com#fragment",
  ])("rejects unsafe origins: %s", (url) => {
    const cwd = temporaryDirectory();
    const result = spawnSync(command, [...prefix, "--email", "owner@example.com", "--url", url], {
      cwd,
    });
    expect(result.status).not.toBe(0);
    expect(existsSync(join(cwd, ".env"))).toBe(false);
  });

  it.each([[], ["--email", "bad"], ["--email"], ["--unknown"]])(
    "rejects invalid arguments %#",
    (...args) => {
      expect(
        spawnSync(command, [...prefix, ...args], { cwd: temporaryDirectory() }).status,
      ).not.toBe(0);
    },
  );
  it("prints help without creating an environment", () => {
    const cwd = temporaryDirectory();
    expect(execFileSync(command, [...prefix, "--help"], { cwd, encoding: "utf8" })).toContain(
      "--email",
    );
    expect(existsSync(join(cwd, ".env"))).toBe(false);
  });
});

it.each([undefined, "http://[::1]:43100", "http://127.0.0.1", "https://BOT.EXAMPLE.COM:443/"])(
  "generates matching deployment templates for %s",
  (url) => {
    const contents = ["mjs", "sh"].map((extension) => {
      const cwd = mkdtempSync(join(tmpdir(), "deployment-env-"));
      directories.push(cwd);
      const script = resolve(`scripts/init-env.${extension}`);
      const args = ["--email", "owner@example.com", ...(url ? ["--url", url] : [])];
      execFileSync(
        extension === "sh" ? script : process.execPath,
        extension === "sh" ? args : [script, ...args],
        { cwd },
      );
      return readFileSync(join(cwd, ".env"), "utf8").replace(
        /^(DB_PASSWORD|BETTER_AUTH_SECRET|ENCRYPTION_KEY|PANEL_PASSWORD|MINI_APP_SESSION_SECRET)=[a-f0-9]+$/gm,
        "$1=<generated>",
      );
    });
    expect(contents[0]).toBe(contents[1]);
  },
);
