import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const directories = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "release-upgrade-"));
  directories.push(directory);
  const source = join(directory, "source");
  mkdirSync(join(source, "scripts"), { recursive: true });
  copyFileSync(
    resolve("scripts/update-production.sh"),
    join(source, "scripts/update-production.sh"),
  );
  writeFileSync(join(source, "docker-compose.yml"), "services: {}\n");
  writeFileSync(join(source, "docker-compose.direct.yml"), "services: {}\n");
  const git = (...args) =>
    execFileSync("git", args, { cwd: source, stdio: "pipe" }).toString().trim();
  git("init", "-b", "main");
  git("add", ".");
  const commit = () =>
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-am",
      "fixture",
    );
  commit();
  const before = git("rev-parse", "HEAD");
  git("tag", "v0.9.0");
  writeFileSync(join(source, "version.txt"), "new release");
  git("add", ".");
  commit();
  git("tag", "v1.0.0");
  const target = git("rev-parse", "HEAD");
  const remote = join(directory, "remote.git");
  execFileSync("git", ["clone", "--bare", source, remote], { stdio: "pipe" });
  git("remote", "add", "origin", remote);
  git("checkout", "--detach", before);
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const calls = join(directory, "docker-calls");
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/bash
printf '%s\\n' "$*" >> "$TEST_DOCKER_CALLS"
case "$*" in
  *"config --environment"*) printf 'COMPOSE_PROFILES=\\nCODING_WORKER_SECRET=\\n';;
  *"config --services"*) printf 'app\\ndb\\n';;
  *"pg_dump"*) printf 'verified fake dump';;
  *"pg_restore --list"*) cat >/dev/null; [[ "\${TEST_BACKUP_FAIL:-}" != 1 ]];;
  *"psql"*) printf '0\\n';;
  *" build "*) [[ "\${TEST_BUILD_FAIL:-}" != 1 ]];;
  *) exit 0;;
esac
`,
  );
  chmodSync(join(bin, "docker"), 0o755);
  const backup = join(directory, "backups");
  const run = (extraEnv = {}, args = ["--version", "v1.0.0"]) =>
    spawnSync("bash", [join(source, "scripts/update-production.sh"), ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TEST_DOCKER_CALLS: calls,
        DEPLOY_BACKUP_DIR: backup,
        DEPLOY_PROJECT_NAME: "existing-instance",
        ...extraEnv,
      },
    });
  return { source, before, target, git, calls, backup, run };
}

describe("release upgrades", () => {
  it("pins an already deployed tag without restarting services", () => {
    const { git, calls, run } = fixture();
    expect(run().status).toBe(0);
    git("checkout", "main");
    writeFileSync(calls, "");
    expect(run().status).toBe(0);
    expect(git("branch", "--show-current")).toBe("");
    expect(readFileSync(calls, "utf8")).not.toContain(" up -d");
  });
  it("backs up before moving to a remote tag and writes success only after readiness", () => {
    const { target, git, calls, backup, run } = fixture();
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(git("rev-parse", "HEAD")).toBe(target);
    expect(git("branch", "--show-current")).toBe("");
    const commands = readFileSync(calls, "utf8");
    expect(commands.indexOf("pg_dump")).toBeLessThan(commands.indexOf(" build app"));
    expect(commands).toContain("-p existing-instance");
    expect(commands).toContain("/api/health/ready");
    expect(readFileSync(join(backup, "last-deployed-commit"), "utf8").trim()).toBe(target);
  });
  it("keeps current code when backup verification fails", () => {
    const { before, git, calls, backup, run } = fixture();
    expect(run({ TEST_BACKUP_FAIL: "1" }).status).not.toBe(0);
    expect(git("rev-parse", "HEAD")).toBe(before);
    expect(readFileSync(calls, "utf8")).not.toContain(" build app");
    expect(existsSync(join(backup, "last-deployed-commit"))).toBe(false);
  });
  it("does not mark a failed build deployed", () => {
    const { calls, backup, run } = fixture();
    expect(run({ TEST_BUILD_FAIL: "1" }).status).not.toBe(0);
    expect(readFileSync(calls, "utf8")).not.toContain(" up -d");
    expect(existsSync(join(backup, "last-deployed-commit"))).toBe(false);
  });
  it("refuses an older release before backup or startup", () => {
    const { target, git, calls, run } = fixture();
    git("checkout", "--detach", target);
    expect(run({}, ["--version", "v0.9.0"]).status).not.toBe(0);
    expect(readFileSync(calls, "utf8")).not.toContain("pg_dump");
  });
});
