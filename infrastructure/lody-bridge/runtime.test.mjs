import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntime } from "./runtime.mjs";

const homes = [];
afterEach(async () =>
  Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))),
);

async function setup({
  sessions = [],
  fail = null,
  latest = "0.103.0",
  workspaces = [{ id: "default" }],
  sessionsByWorkspace = {},
} = {}) {
  const home = await mkdtemp(join(tmpdir(), "lody-runtime-"));
  homes.push(home);
  await writeFile(join(home, "machine-id"), "server-id");
  const exec = vi.fn(async (command, args) => {
    if (command[0] === "npm") {
      if (fail === "install") throw new Error("secret install stderr");
      const bin = join(args[args.indexOf("--prefix") + 1], "node_modules", ".bin");
      await mkdir(bin, { recursive: true });
      await writeFile(join(bin, "lody"), "fake executable");
      return "";
    }
    if (args[0] === "--version") return command[0] === "lody" ? "0.100.0" : latest;
    if (args[0] === "workspace") return JSON.stringify({ ok: true, workspaces });
    if (args[0] === "session")
      return `[ws] attached\n${JSON.stringify({ ok: true, sessions: sessionsByWorkspace[args[args.indexOf("--workspace") + 1]] ?? sessions })}`;
    if (fail === "start" && args[1] === "start" && command[0] !== "lody")
      throw new Error("secret startup stderr");
    return "";
  });
  const fetchImpl = vi.fn(async () => Response.json({ version: latest }));
  return { home, exec, fetchImpl, runtime: createRuntime({ home, exec, fetchImpl }) };
}

describe("Lody runtime updates", () => {
  it("installs an exact stable version and keeps using it after recreating the bridge", async () => {
    const { runtime, exec, home, fetchImpl } = await setup();
    const result = await runtime.update();
    expect(result).toMatchObject({ version: "0.103.0", updating: false, updated: true });
    const install = exec.mock.calls.find(([command]) => command[0] === "npm");
    expect(install[1]).toContain("lody@0.103.0");
    expect(install[1]).toContain("https://registry.npmjs.org");
    expect(
      exec.mock.calls.filter(([, args]) => args[0] === "daemon").map(([, args]) => args),
    ).toEqual([
      ["daemon", "stop"],
      ["daemon", "start", "--machine-name", "cos-tool-bot-server"],
    ]);
    expect(createRuntime({ home, exec, fetchImpl }).command()).toEqual(runtime.command());
    expect((await runtime.update()).updated).toBe(false);
    expect(exec.mock.calls.filter(([command]) => command[0] === "npm")).toHaveLength(1);
  });

  it.each(["running", "requestPermission", "initializing"])(
    "refuses to restart an external %s session",
    async (type) => {
      const { runtime, exec } = await setup({
        sessions: [{ id: "external", status: { type } }],
      });
      await expect(runtime.update()).rejects.toMatchObject({ code: "conflict" });
      expect(exec.mock.calls.some(([, args]) => args[0] === "daemon")).toBe(false);
      expect(runtime.command()).toEqual(["lody"]);
      expect(runtime.updating).toBe(false);
    },
  );

  it("restores the original command and daemon when the new daemon fails to start", async () => {
    const { runtime, exec, home } = await setup({ fail: "start" });
    await expect(runtime.update()).rejects.toThrow("已保留原版本");
    expect(runtime.command()).toEqual(["lody"]);
    await expect(readlink(join(home, "cli", "current"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(exec.mock.calls.at(-1)).toEqual([
      ["lody"],
      ["daemon", "start", "--machine-name", "cos-tool-bot-server"],
      60_000,
    ]);
  });

  it("protects sessions in another workspace on the same machine", async () => {
    const { runtime, exec } = await setup({
      workspaces: [{ id: "default" }, { id: "other" }],
      sessionsByWorkspace: { other: [{ status: { type: "requestPermission" } }] },
    });
    await expect(runtime.update()).rejects.toMatchObject({ code: "conflict" });
    expect(exec.mock.calls.some(([, args]) => args[0] === "daemon")).toBe(false);
    expect(exec.mock.calls.filter(([, args]) => args[0] === "session")).toHaveLength(2);
  });

  it("leaves the daemon running when the workspace catalog cannot be verified", async () => {
    const { runtime, exec } = await setup({ workspaces: [] });
    await expect(runtime.update()).rejects.toMatchObject({ code: "lody_unavailable" });
    expect(exec.mock.calls.some(([, args]) => args[0] === "daemon")).toBe(false);
  });

  it("leaves the running daemon alone on download failure and never exposes installer output", async () => {
    const { runtime, exec } = await setup({ fail: "install" });
    await expect(runtime.update()).rejects.toThrow("已保留原版本");
    expect(exec.mock.calls.some(([, args]) => args[0] === "daemon")).toBe(false);
  });

  it("rejects concurrent updates and untrusted version strings", async () => {
    const { runtime, fetchImpl, exec } = await setup();
    let resolve;
    fetchImpl.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const updating = runtime.update();
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    await expect(runtime.update()).rejects.toMatchObject({ code: "conflict" });
    resolve(Response.json({ version: "https://evil.test/package.tgz" }));
    await expect(updating).rejects.toMatchObject({ code: "lody_unavailable" });
    expect(exec).not.toHaveBeenCalled();
  });
});
