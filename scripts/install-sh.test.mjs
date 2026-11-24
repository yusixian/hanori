import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

const source = resolve(import.meta.dirname, "..");
const script = join(source, "scripts/install.sh");
const compose = "docker-compose.prebuilt.yml";
const owner = ["--email", "owner@example.com"];
let cwd;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "hanori-install-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function install(...args) {
  const result = spawnSync("sh", [script, "--source-dir", source, ...args], {
    cwd,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return result;
}

test("installs prebuilt Compose and privately generates independent credentials", () => {
  const dir = "bot instance";
  const target = join(cwd, dir);
  const result = install(
    ...owner,
    "--dir",
    dir,
    "--url",
    "https://BOT.example.com/",
    "--tag",
    "v1",
  );
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("docker compose -f docker-compose.prebuilt.yml up -d");
  expect(result.stdout).toContain("curl -fsS http://127.0.0.1:43100/api/health/ready");
  expect(readdirSync(target).sort()).toEqual([".env", ".env.selfhost.example", compose, "scripts"]);
  for (const file of [compose, ".env.selfhost.example", "scripts/init-env.sh"]) {
    expect(readFileSync(join(target, file))).toEqual(readFileSync(join(source, file)));
  }

  const path = join(target, ".env");
  const content = readFileSync(path, "utf8");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(content).toContain("AUTH_OWNER_EMAIL=owner@example.com\n");
  expect(content).toContain("BETTER_AUTH_URL=https://bot.example.com\n");
  expect(content).toContain("HANORI_IMAGE_TAG=v1\n");
  const secrets = [
    ...content.matchAll(
      /^(DB_PASSWORD|BETTER_AUTH_SECRET|ENCRYPTION_KEY|PANEL_PASSWORD|MINI_APP_SESSION_SECRET)=([a-f0-9]{48,64})$/gm,
    ),
  ].map(([, , secret]) => secret);
  expect(new Set(secrets).size).toBe(5);
  for (const secret of secrets) expect(result.stdout + result.stderr).not.toContain(secret);

  const repeated = install("--dir", dir, "--tag", "v2");
  expect(repeated.status).toBe(0);
  expect(repeated.stdout).toContain("Keeping existing .env");
  expect(readFileSync(path, "utf8")).toBe(content);
  for (const secret of secrets) expect(repeated.stdout + repeated.stderr).not.toContain(secret);
});

test("preserves a manually prepared environment and Compose file", () => {
  const environment = "PANEL_PASSWORD=existing-fixture-password\n";
  writeFileSync(join(cwd, ".env"), environment, { mode: 0o600 });
  writeFileSync(join(cwd, compose), "# customized\n");
  const result = install("--dir", ".");
  expect(result.status).toBe(0);
  expect(result.stdout + result.stderr).not.toContain("existing-fixture-password");
  expect(readFileSync(join(cwd, ".env"), "utf8")).toBe(environment);
  expect(readFileSync(join(cwd, compose), "utf8")).toBe("# customized\n");
  expect(existsSync(join(cwd, "scripts/init-env.sh"))).toBe(true);
});

test("uses the default path, image tag and local origin", () => {
  expect(install(...owner).status).toBe(0);
  const content = readFileSync(join(cwd, "hanori/.env"), "utf8");
  expect(content).toContain("HANORI_IMAGE_TAG=latest\n");
  expect(content).toContain("BETTER_AUTH_URL=http://localhost:43100\n");
});

test("leaves a dangling .env symlink and its target untouched", () => {
  symlinkSync("missing", join(cwd, ".env"));
  expect(install(...owner, "--dir", ".").status).toBe(1);
  expect(readdirSync(cwd)).toEqual([".env"]);
});

test.each([
  [],
  ["--email", "bad"],
  [...owner, "--url", "https://user:password@example.com"],
  [...owner, "--url", "https://example.com/path"],
  [...owner, "--tag", "latest\nDB_PASSWORD=bad"],
  [...owner, "--tag", "-latest"],
  [...owner, "--tag", "x".repeat(129)],
  [...owner, "--ref", "../main"],
  [...owner, "--ref", "main?bad"],
  [...owner, "--dir"],
  [...owner, "--source-dir", "missing"],
  [...owner, "--unknown"],
])("rejects invalid or missing options (%#)", (...args) => {
  const result = install(...args);
  expect(result.status).toBe(1);
  expect(result.stderr).not.toContain("user:password");
  expect(existsSync(join(cwd, "hanori/.env"))).toBe(false);
  expect(existsSync(join(cwd, "hanori", compose))).toBe(false);
});

test("leaves no published files when a source is incomplete", () => {
  writeFileSync(join(cwd, compose), "# fixture\n");
  const result = install(...owner, "--source-dir", ".");
  expect(result.status).toBe(1);
  expect(readdirSync(join(cwd, "hanori"))).toEqual([]);
});

test("prints help without creating a target directory", () => {
  expect(install("--help").stdout).toContain("--source-dir");
  expect(readdirSync(cwd)).toEqual([]);
});
