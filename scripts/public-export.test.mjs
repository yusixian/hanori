import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isPublicPath,
  parsePublicJson,
  sanitizePublicFile,
  scanPublicFile,
} from "./lib/public-export.mjs";

const directories = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const asBuffer = (value) => Buffer.from(value);

describe("public snapshot policy", () => {
  it("keeps malformed JSON contents out of error messages", () => {
    const secret = "unpublished-secret-value";
    expect(() => parsePublicJson(`not-json ${secret}`, "manifest.json")).toThrow(
      "Invalid JSON in manifest.json; contents are not printed.",
    );
  });
  it.each([
    ".env",
    ".env.production",
    ".git/config",
    "docs/design/private.md",
    "docs/UI_EFFICIENCY_GOAL.md",
    "HANDOFF.md",
    ".claude/settings.json",
    "tasks/private.md",
    "packages/bot/src/skills/$OUT/secret.md",
    "packages/server/data/backup.json",
    "packages/docs/content/docs/changelog/v1.0.0.mdx",
    "packages/server/src/secret.pem",
    "packages/panel/src/pages/__screenshots__/login-failed.png",
    "packages/panel/.vitest-attachments/debug.json",
  ])("excludes private or generated path %s", (path) => {
    expect(isPublicPath(path)).toBe(false);
  });
  it.each([
    ".env.example",
    "packages/database/drizzle/meta/0000_snapshot.json",
    "packages/database/drizzle/0000_init.sql",
    "packages/bot/src/index.ts",
    "packages/panel/src/pages/data/index.tsx",
    "packages/server/src/harness/__fixtures__/lody-machine-list.txt",
    "packages/docs/content/docs/index.mdx",
    "docs/releases/v0.17.0.md",
    "Dockerfile",
    "acceptance/docs/public-docs.spec.ts",
    "scripts/smoke-deployment.mjs",
    "scripts/smoke-deployment.test.mjs",
  ])("preserves required source %s", (path) => {
    expect(isPublicPath(path)).toBe(true);
  });
  it("reports locations without credentials and does not exempt test files wholesale", () => {
    const secret = `ghp_${"a".repeat(36)}`;
    const findings = scanPublicFile(
      "packages/server/src/example.test.ts",
      asBuffer(`fixture\n${secret}`),
    );
    expect(findings).toEqual([
      { path: "packages/server/src/example.test.ts", line: 2, rule: "github-token" },
    ]);
    expect(JSON.stringify(findings)).not.toContain(secret);
    expect(
      scanPublicFile("source.ts", asBuffer("postgresql://bot:actual-secret@db:5432/app")),
    ).toEqual([expect.objectContaining({ rule: "credential-in-url" })]);
    expect(
      scanPublicFile("source.ts", asBuffer("postgresql://bot:password@localhost:43105/app")),
    ).toEqual([]);
  });
  it("keeps legacy release behavior while removing private PR links", () => {
    expect(
      sanitizePublicFile(
        "docs/releases/v0.2.0.md",
        asBuffer("Feature #73"),
      ).toString(),
    ).toBe("Feature #73");
  });
  it("preserves mixed-case username tests while anonymizing fixtures", () => {
    const data = asBuffer('trustedAuthors: ["example-owner"], author: "example-owner"');
    expect(sanitizePublicFile("packages/server/src/harness/intake.test.ts", data).toString()).toBe(
      'trustedAuthors: ["demo-org"], author: "Demo-Org"',
    );
    expect(scanPublicFile("source.ts", asBuffer("example-owner"))).toEqual([
      expect.objectContaining({ rule: "owner-metadata" }),
    ]);
  });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "public-export-test-"));
  directories.push(directory);
  const source = join(directory, "source");
  mkdirSync(source);
  const put = (path, data) => {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    writeFileSync(join(source, path), data);
  };
  for (const path of [
    "scripts/export-public.mjs",
    "scripts/check-public.mjs",
    "scripts/sync-public.mjs",
    "scripts/lib/public-export.mjs",
  ]) {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    cpSync(resolve(path), join(source, path));
  }
  for (const name of ["readme.md", "AGENTS.md", "CONTRIBUTING.md", "SECURITY.md"])
    put(`open-source/${name}`, "public guide\n");
  put("open-source/ci.yml", "name: CI\n");
  put(
    "package.json",
    JSON.stringify({
      version: "0.17.0",
      scripts: { "public:export": "private", "setup:env": "node scripts/init-env.mjs" },
    }),
  );
  put("packages/shared/src/index.ts", 'export const value = "committed";\n');
  put(".env", "TOKEN=must-not-be-exported\n");
  put("docs/private.md", "must-not-be-exported\n");
  const git = (...args) => execFileSync("git", args, { cwd: source, stdio: "pipe" });
  git("init", "-b", "main");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "fixture",
  );
  const out = join(directory, "snapshot");
  const run = () =>
    spawnSync(process.execPath, [join(source, "scripts/export-public.mjs"), "--out", out], {
      encoding: "utf8",
    });
  return { source, out, put, git, run };
}

describe("snapshot export and verification", () => {
  it("exports committed source without history, configuration or worktree changes and detects tampering", () => {
    const { source, out, put, run } = fixture();
    put("packages/shared/src/index.ts", 'export const value = "uncommitted";\n');
    expect(run().status).toBe(0);
    expect(readFileSync(join(out, "packages/shared/src/index.ts"), "utf8")).toContain("committed");
    expect(existsSync(join(out, ".git"))).toBe(false);
    expect(existsSync(join(out, ".env"))).toBe(false);
    expect(existsSync(join(out, "docs/private.md"))).toBe(false);
    const check = () =>
      spawnSync(process.execPath, [join(source, "scripts/check-public.mjs"), "--dir", out], {
        encoding: "utf8",
      });
    expect(check().status).toBe(0);
    expect(run().status).not.toBe(0);
    writeFileSync(join(out, "packages/shared/src/index.ts"), "tampered");
    expect(check().status).not.toBe(0);
  });
  it("blocks credential findings before creating the output and keeps values out of diagnostics", () => {
    const { out, put, git, run } = fixture();
    const secret = `ghp_${"b".repeat(36)}`;
    put("packages/shared/src/secret.ts", `export const token = '${secret}';`);
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "unsafe fixture",
    );
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("github-token");
    expect(result.stderr).not.toContain(secret);
    expect(existsSync(out)).toBe(false);
  });
  it("rejects symlinks instead of following private files", () => {
    const { source, out, git, run } = fixture();
    symlinkSync("../../../.env", join(source, "packages/shared/src/link.ts"));
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "symlink fixture",
    );
    expect(run().status).not.toBe(0);
    expect(existsSync(out)).toBe(false);
  });
});

describe("public repository synchronization", () => {
  function syncFixture() {
    const context = fixture();
    expect(context.run().status).toBe(0);
    const publicRoot = join(dirname(context.out), "public");
    cpSync(context.out, publicRoot, { recursive: true });
    const publicGit = (...args) =>
      execFileSync("git", args, { cwd: publicRoot, stdio: "pipe" }).toString().trim();
    publicGit("init", "-b", "sync-test");
    publicGit("add", ".");
    const commitPublic = () =>
      publicGit(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-am",
        "public fixture",
      );
    commitPublic();
    context.put("packages/shared/src/index.ts", 'export const value = "updated";\n');
    context.git("add", ".");
    context.git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "new snapshot",
    );
    const next = join(dirname(context.out), "next");
    execFileSync(process.execPath, [
      join(context.source, "scripts/export-public.mjs"),
      "--out",
      next,
    ]);
    const sync = (apply = false) =>
      spawnSync(
        process.execPath,
        [
          join(context.source, "scripts/sync-public.mjs"),
          "--snapshot",
          next,
          "--into",
          publicRoot,
          ...(apply ? ["--apply"] : []),
        ],
        { encoding: "utf8" },
      );
    return { ...context, publicRoot, publicGit, commitPublic, sync };
  }
  it("plans by default, updates only managed files and never commits", () => {
    const { publicRoot, publicGit, sync } = syncFixture();
    const head = publicGit("rev-parse", "HEAD");
    expect(sync().status).toBe(0);
    expect(publicGit("status", "--porcelain")).toBe("");
    const result = sync(true);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(publicRoot, "packages/shared/src/index.ts"), "utf8")).toContain(
      "updated",
    );
    expect(publicGit("rev-parse", "HEAD")).toBe(head);
    expect(publicGit("status", "--porcelain")).not.toBe("");
  });
  it("refuses to overwrite community changes and protected branches", () => {
    const { publicRoot, publicGit, commitPublic, sync } = syncFixture();
    const path = join(publicRoot, "packages/shared/src/index.ts");
    writeFileSync(path, "community change\n");
    commitPublic();
    expect(sync(true).status).not.toBe(0);
    expect(readFileSync(path, "utf8")).toBe("community change\n");
    publicGit("branch", "-m", "main");
    expect(sync(true).stderr).toContain("feature branch");
  });
});
