import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readlink, rename, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const REGISTRY = "https://registry.npmjs.org";
const VERSION = /^\d+\.\d+\.\d+$/;

function run(command, args, timeout) {
  const env = { ...process.env, LODY_CLI_TOKEN: undefined, HARNESS_LODY_BRIDGE_SECRET: undefined };
  if (args[0] === "daemon") {
    return new Promise((resolve, reject) => {
      const child = spawn(command[0], [...command.slice(1), ...args], { stdio: "ignore", env });
      const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        code === 0 ? resolve("") : reject(new Error("daemon"));
      });
    });
  }
  return new Promise((resolve, reject) => {
    execFile(
      command[0],
      [...command.slice(1), ...args],
      {
        timeout,
        maxBuffer: 1024 * 1024,
        env,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    );
  });
}

export class RuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Installs an exact stable release beside the running CLI; switches only after verification. */
export function createRuntime({
  home = join(homedir(), ".lody"),
  machineName = "cos-tool-bot-server",
  fallback = ["lody"],
  exec = run,
  fetchImpl = fetch,
  beforeUpdate = async () => {},
} = {}) {
  const root = join(home, "cli");
  const current = join(root, "current");
  const binary = (prefix) => join(prefix, "node_modules", ".bin", "lody");
  let updating = false;
  const command = () => (existsSync(binary(current)) ? [binary(current)] : fallback);
  const switchTo = async (target) => {
    const link = join(root, `current-${randomUUID()}`);
    await symlink(target, link);
    await rename(link, current);
  };
  const status = async () => {
    const version = await exec(command(), ["--version"], 10_000).catch(() => null);
    return {
      version: VERSION.test(version ?? "") ? version : null,
      machineName,
      updating,
      canUpdate: true,
    };
  };

  return {
    command,
    status,
    get updating() {
      return updating;
    },
    async update() {
      if (updating) throw new RuntimeError("conflict", "Lody CLI 正在更新，请稍后刷新查看版本。");
      updating = true;
      let candidate = null;
      let switched = false;
      let stopped = false;
      const previousCommand = command();
      const previousTarget = await readlink(current).catch(() => null);
      try {
        await beforeUpdate();
        const response = await fetchImpl(`${REGISTRY}/lody/latest`, {
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error("registry");
        const { version } = await response.json();
        if (typeof version !== "string" || !VERSION.test(version)) throw new Error("version");
        const before = await status();
        if (before.version && compareVersions(before.version, version) >= 0)
          return { ...before, updating: false, updated: false };
        candidate = join(root, "releases", `${version}-${randomUUID()}`);
        await mkdir(candidate, { recursive: true });
        await exec(
          ["npm"],
          [
            "install",
            "--prefix",
            candidate,
            "--registry",
            REGISTRY,
            "--omit=dev",
            "--no-audit",
            "--no-fund",
            `lody@${version}`,
          ],
          180_000,
        );
        const next = [binary(candidate)];
        if ((await exec(next, ["--version"], 10_000)) !== version) throw new Error("verification");

        // Check all local sessions, including ones created outside Harness, before restarting.
        const machineId = (await readFile(join(home, "machine-id"), "utf8")).trim();
        if (!/^[\w-]{1,128}$/.test(machineId)) throw new Error("machine");
        const catalog = parseOutput(await exec(next, ["workspace", "list", "--json"], 15_000));
        if (
          catalog?.ok === false ||
          !Array.isArray(catalog?.workspaces) ||
          !catalog.workspaces.length ||
          catalog.workspaces.length > 100
        )
          throw new Error("workspaces");
        // One shared budget keeps preflight bounded even with many workspaces.
        const deadline = Date.now() + 30_000;
        for (const workspace of catalog.workspaces) {
          if (typeof workspace?.id !== "string" || !/^[\w-]{1,128}$/.test(workspace.id))
            throw new Error("workspace");
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error("sessions timeout");
          const output = await exec(
            next,
            [
              "session",
              "list",
              "--workspace",
              workspace.id,
              "--machine-id",
              machineId,
              "--all",
              "--limit",
              "1000",
              "--json",
            ],
            remaining,
          );
          const json = parseOutput(output);
          const sessions = json?.sessions ?? json?.items;
          if (json?.ok === false || !Array.isArray(sessions) || sessions.length >= 1000)
            throw new Error("sessions");
          if (
            sessions.some(
              (session) =>
                session.executionState === "busy" ||
                ["running", "requestPermission", "initializing"].includes(session.status?.type) ||
                ["running", "waiting", "initializing"].includes(session.liveStatus?.state),
            )
          )
            throw new RuntimeError("conflict", "服务器上仍有运行中的 Lody 会话，请结束后再更新。");
        }
        stopped = true;
        await exec(previousCommand, ["daemon", "stop"], 30_000);
        await switchTo(candidate);
        switched = true;
        await exec(next, ["daemon", "start", "--machine-name", machineName], 60_000);
        return { version, machineName, updating: false, canUpdate: true, updated: true };
      } catch (error) {
        let recovered = true;
        if (switched) {
          await exec([binary(candidate)], ["daemon", "stop"], 30_000).catch(() => {});
          try {
            if (previousTarget) await switchTo(previousTarget);
            else await rm(current);
          } catch {
            recovered = false;
          }
        }
        if (stopped && recovered) {
          try {
            await exec(previousCommand, ["daemon", "start", "--machine-name", machineName], 60_000);
          } catch {
            recovered = false;
          }
        }
        if (candidate && recovered)
          await rm(candidate, { recursive: true, force: true }).catch(() => {});
        if (error instanceof RuntimeError) throw error;
        throw new RuntimeError(
          "lody_unavailable",
          recovered
            ? "Lody CLI 更新失败，已保留原版本。请检查 bridge 的网络与 daemon 状态。"
            : "Lody CLI 更新失败，旧版本恢复未完成。请检查 bridge 的 daemon 状态。",
        );
      } finally {
        updating = false;
      }
    },
  };
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

function parseOutput(stdout) {
  const lines = stdout.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trimStart().startsWith("{")) continue;
    try {
      return JSON.parse(lines.slice(index).join("\n"));
    } catch {
      /* scan transport prelude */
    }
  }
  return null;
}
