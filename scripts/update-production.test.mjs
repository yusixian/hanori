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
  const mediaContainer = join(directory, "media-container");
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/bash
printf '%s\\n' "$*" >> "$TEST_DOCKER_CALLS"
case "$*" in
  *"config --environment"*) printf 'COMPOSE_PROFILES=%s\\nCODING_WORKER_SECRET=%s\\nMEDIA_WORKER_SECRET=%s\\n' "\${TEST_COMPOSE_PROFILES:-}" "\${TEST_CODING_SECRET:-}" "\${TEST_MEDIA_SECRET:-}";;
  *"config --format json"*) printf '{"services":{"app":{"environment":{"MEDIA_WORKER_SECRET":"%s"}}}}\\n' "\${TEST_MEDIA_JSON_SECRET:-}";;
  *"config --services"*)
    printf 'app\\ndb\\n'
    if [[ ",\${TEST_COMPOSE_PROFILES:-}," == *,coding,* ]]; then printf 'coding-worker\\ncoding-egress-proxy\\n'; fi
    if [[ ",\${TEST_COMPOSE_PROFILES:-}," == *,media,* ]]; then printf 'media-worker\\n'; fi
    if [[ ",\${TEST_COMPOSE_PROFILES:-}," == *,harness,* ]]; then printf 'lody-bridge\\n'; fi
    ;;
  *"label=com.docker.compose.service=media-worker"*)
    if [[ -f "$TEST_MEDIA_CONTAINER" ]]; then printf 'media-fixture\\n'; fi
    ;;
  "stop media-fixture") [[ "\${TEST_MEDIA_STOP_FAIL:-}" != 1 ]];;
  "rm media-fixture")
    if [[ "\${TEST_MEDIA_REMOVE_FAIL:-}" != 1 ]]; then rm -f "$TEST_MEDIA_CONTAINER"; fi
    ;;
  *"ps -q media-worker"*) printf 'media-fixture\\n';;
  *"ps -q coding-worker"*) printf 'coding-fixture\\n';;
  *"ps -q coding-egress-proxy"*) printf 'proxy-fixture\\n';;
  "inspect "*"media-fixture"*)
    if [[ "\${TEST_MEDIA_HEALTH_FAIL:-}" == 1 ]]; then printf 'unhealthy\\n'; else printf 'healthy\\n'; fi
    ;;
  "inspect "*) printf 'healthy\\n';;
  *"pg_dump"*) printf 'verified fake dump';;
  *"pg_restore --list"*) cat >/dev/null; [[ "\${TEST_BACKUP_FAIL:-}" != 1 ]];;
  *"psql"*) printf '0\\n';;
  *" build "*) [[ "\${TEST_BUILD_FAIL:-}" != 1 ]];;
  *) exit 0;;
esac
`,
  );
  chmodSync(join(bin, "docker"), 0o755);
  writeFileSync(join(bin, "sleep"), "#!/bin/bash\nexit 0\n");
  chmodSync(join(bin, "sleep"), 0o755);
  const backup = join(directory, "backups");
  const run = (extraEnv = {}, args = ["--version", "v1.0.0"]) => {
    if (extraEnv.TEST_MEDIA_EXISTING === "1") writeFileSync(mediaContainer, "existing container");
    const result = spawnSync("bash", [join(source, "scripts/update-production.sh"), ...args], {
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TEST_DOCKER_CALLS: calls,
        TEST_MEDIA_CONTAINER: mediaContainer,
        DEPLOY_BACKUP_DIR: backup,
        DEPLOY_PROJECT_NAME: "existing-instance",
        ...extraEnv,
        TEST_MEDIA_JSON_SECRET: JSON.stringify(extraEnv.TEST_MEDIA_SECRET ?? "").slice(1, -1),
      },
    });
    if (result.error) throw result.error;
    return result;
  };
  return { source, before, target, git, calls, backup, mediaContainer, run };
}

// Each integration case creates a Git repository and launches real child processes.
describe("release upgrades", { timeout: 30_000 }, () => {
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

  it.each([
    { TEST_COMPOSE_PROFILES: "media" },
    { TEST_COMPOSE_PROFILES: "media", TEST_MEDIA_SECRET: "too-short" },
    { TEST_MEDIA_SECRET: "synthetic-media-secret-at-least-32-characters" },
    {
      TEST_COMPOSE_PROFILES: "media",
      TEST_MEDIA_SECRET: "synthetic-media-secret-at-least-32-characters\nextra-line",
    },
    {
      TEST_COMPOSE_PROFILES: "media",
      TEST_MEDIA_SECRET: "synthetic-media-secret-at-least-32-characters\r",
    },
    { TEST_COMPOSE_PROFILES: "media", TEST_MEDIA_SECRET: "x".repeat(31) },
    { TEST_COMPOSE_PROFILES: "media", TEST_MEDIA_SECRET: "x".repeat(257) },
    {
      TEST_COMPOSE_PROFILES: "media",
      TEST_MEDIA_SECRET: 'synthetic-media-secret-at-least-32-characters"suffix',
    },
    {
      TEST_COMPOSE_PROFILES: "media",
      TEST_MEDIA_SECRET: "synthetic-media-secret-at-least-32-characters\\suffix",
    },
    {
      TEST_COMPOSE_PROFILES: "media",
      TEST_MEDIA_SECRET: "synthetic-media-secret-at-least-32-charactersé",
    },
    { TEST_MEDIA_SECRET: "\nsynthetic-media-secret-at-least-32-characters" },
  ])("requires the media profile and a strong secret together before backup: %j", (environment) => {
    const { before, git, calls, backup, run } = fixture();
    const result = run(environment);
    expect(result.status).not.toBe(0);
    expect(git("rev-parse", "HEAD")).toBe(before);
    expect(readFileSync(calls, "utf8")).not.toContain("pg_dump");
    expect(existsSync(join(backup, "last-deployed-commit"))).toBe(false);
    if (environment.TEST_MEDIA_SECRET)
      expect(result.stdout + result.stderr).not.toContain(environment.TEST_MEDIA_SECRET);
  });

  it("builds, starts and checks media alongside the existing coding and harness profiles", () => {
    const { target, calls, backup, run } = fixture();
    const result = run({
      TEST_COMPOSE_PROFILES: "coding,harness,media",
      TEST_CODING_SECRET: "synthetic-coding-secret",
      TEST_MEDIA_SECRET: "synthetic-media-secret-at-least-32-characters",
    });
    expect(result.status, result.stderr).toBe(0);
    const commands = readFileSync(calls, "utf8");
    expect(commands).toContain("build app coding-egress-proxy coding-worker media-worker");
    expect(commands).toContain("ps -q coding-worker");
    expect(commands).toContain("ps -q coding-egress-proxy");
    expect(commands).toContain("ps -q media-worker");
    expect(commands).toContain("inspect --format {{.State.Health.Status}} media-fixture");
    expect(commands).toContain("ps app db coding-worker coding-egress-proxy media-worker");
    expect(readFileSync(join(backup, "last-deployed-commit"), "utf8").trim()).toBe(target);
  });

  it.each(["x".repeat(32), "A+/=_-".repeat(43).slice(0, 256)])(
    "accepts permitted transport secret characters at both length bounds",
    (secret) => {
      const { calls, run } = fixture();
      const result = run({ TEST_COMPOSE_PROFILES: "media", TEST_MEDIA_SECRET: secret });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(calls, "utf8")).toContain("config --format json");
      expect(result.stdout + result.stderr).not.toContain(secret);
    },
  );

  it("includes media in a forced incremental startup without restarting database services", () => {
    const { calls, run } = fixture();
    expect(run().status).toBe(0);
    writeFileSync(calls, "");
    const result = run(
      {
        TEST_COMPOSE_PROFILES: "media",
        TEST_MEDIA_SECRET: "synthetic-media-secret-at-least-32-characters",
      },
      ["--version", "v1.0.0", "--force"],
    );
    expect(result.status, result.stderr).toBe(0);
    const commands = readFileSync(calls, "utf8");
    expect(commands).toContain("build app media-worker");
    expect(commands).toContain("up -d app media-worker");
    expect(commands).not.toContain("up -d --no-deps app");
    expect(commands).not.toContain("up -d app db");
  });

  it("stops and removes a disabled media container before startup while retaining its volumes", () => {
    const { calls, mediaContainer, run } = fixture();
    const result = run({ TEST_MEDIA_EXISTING: "1" });
    expect(result.status, result.stderr).toBe(0);
    const commands = readFileSync(calls, "utf8");
    expect(commands).toContain("label=com.docker.compose.project=existing-instance");
    expect(commands.indexOf("stop media-fixture")).toBeLessThan(
      commands.indexOf("rm media-fixture"),
    );
    expect(commands.indexOf("rm media-fixture")).toBeLessThan(commands.indexOf(" up -d"));
    expect(commands).not.toContain("volume rm");
    expect(commands).not.toMatch(/(?:rm|down)[^\n]*(?: -v|--volumes)/);
    expect(existsSync(mediaContainer)).toBe(false);
  });

  it.each([{ TEST_MEDIA_STOP_FAIL: "1" }, { TEST_MEDIA_REMOVE_FAIL: "1" }])(
    "refuses startup if a disabled worker cannot be removed: %j",
    (failure) => {
      const { calls, backup, run } = fixture();
      const result = run({ TEST_MEDIA_EXISTING: "1", ...failure });
      expect(result.status).not.toBe(0);
      expect(readFileSync(calls, "utf8")).not.toContain(" up -d");
      expect(existsSync(join(backup, "last-deployed-commit"))).toBe(false);
    },
  );

  it("does not record deployment success when app is ready but media-worker remains unhealthy", () => {
    const { calls, backup, run } = fixture();
    const result = run({
      TEST_COMPOSE_PROFILES: "media",
      TEST_MEDIA_SECRET: "synthetic-media-secret-at-least-32-characters",
      TEST_MEDIA_HEALTH_FAIL: "1",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("音频转换 worker");
    const commands = readFileSync(calls, "utf8");
    expect(commands).toContain("/api/health/ready");
    expect(
      commands.match(/inspect --format \{\{\.State.Health.Status\}\} media-fixture/g),
    ).toHaveLength(60);
    expect(existsSync(join(backup, "last-deployed-commit"))).toBe(false);
  });
});
