import { describe, expect, it, vi } from "vitest";
import { type HarnessAdminActor, HarnessAdmin, HarnessAdminError } from "./admin.js";
import { sourceOf } from "./config/layers.js";
import { MemoryHarnessStore } from "./memory-store.js";
import { HarnessService } from "./service.js";
import {
  FakeGitHub,
  FakeLody,
  TEST_CHAT_ID,
  TEST_OWNER,
  TEST_REPO,
  createTestService,
  testConfigRaw,
} from "./test-fakes.js";

const MACHINES = { mbp: { lody: "MBP-64G" }, mini: { lody: "Mac-mini" } };
const actor: HarnessAdminActor = { via: "panel", actorId: null, panelUserId: "user-1" };
const KOYORI = "example-owner/koyori";

function koyoriFiles() {
  return {
    "package.json": JSON.stringify({ scripts: { lint: "oxlint", typecheck: "tsc" } }),
    "pnpm-lock.yaml": "",
    ".agents/skills/oneshot/SKILL.md": "# oneshot",
  };
}

async function setup(options: Parameters<typeof createTestService>[0] = {}) {
  const github = options.github ?? new FakeGitHub();
  github.repos = [
    { fullName: TEST_REPO, private: true, defaultBranch: "main", installationId: 1 },
    { fullName: KOYORI, private: false, defaultBranch: "main", installationId: 1 },
    { fullName: "example-org/MoePeek", private: false, defaultBranch: "main", installationId: 2 },
  ];
  const ctx = await createTestService({
    raw: testConfigRaw({ machines: MACHINES }),
    ...options,
    github,
  });
  return { ...ctx, admin: new HarnessAdmin(ctx.service, { machineTimeoutMs: 50 }) };
}

async function rejection(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(HarnessAdminError);
  return error as HarnessAdminError;
}

describe("panel projects", () => {
  it("applies a new project live: topic, inferred policy, and repo lookup", async () => {
    const ctx = await setup();
    ctx.github.repoFiles = koyoriFiles();
    const project = await ctx.admin.createProject(
      { key: "koyori", repo: "example-owner/Koyori", machines: ["mbp", "mbp"] },
      actor,
    );
    expect(project).toMatchObject({
      key: "koyori",
      repo: KOYORI,
      source: "panel",
      editable: true,
      machines: ["mbp"],
      localProject: "koyori",
      topic: { threadId: 502, url: "https://t.me/c/1234567890/502", error: null },
      policy: { source: "inferred", verify: { quick: "pnpm lint && pnpm typecheck" } },
      policyPatch: null,
    });
    expect(project.policy.preferSkills).not.toContain("oneshot");
    expect(ctx.telegram.topics).toEqual(["sandbox", "koyori"]);
    expect(ctx.service.projectKeys()).toEqual(["koyori", "sandbox"]);
    expect(ctx.service.projectKeyForRepo("example-owner/KOYORI")).toBe("koyori");
    expect(ctx.service.projectKeyForThread(502)).toBe("koyori");
    expect(ctx.store.events.find((e) => e.type === "project.created")).toMatchObject({
      projectKey: "koyori",
      actorId: null,
      payload: { repo: KOYORI, via: "panel", panelUserId: "user-1" },
    });
  });

  it("layers the panel patch above the repo and below Telegram overrides", async () => {
    const ctx = await setup();
    ctx.github.repoFiles = koyoriFiles();
    await ctx.admin.createProject({ key: "koyori", repo: KOYORI, machines: ["mbp"] }, actor);
    const updated = await ctx.admin.updateProject(
      "koyori",
      { machines: ["mini"], policyPatch: { kind: "electron", verify: { quick: "pnpm check" } } },
      actor,
    );
    expect(updated.machines).toEqual(["mini"]);
    expect(updated.policy).toMatchObject({
      source: "inferred",
      kind: "electron",
      verify: { quick: "pnpm check" },
    });
    expect(updated.policyPatch).toEqual({ kind: "electron", verify: { quick: "pnpm check" } });
    const view = ctx.service.projectView("koyori")!;
    expect(view.config.policy.kind).toBe("electron");
    expect(view.config.policy.verify.quick).toBe("pnpm check");
    expect(view.config.policy.risk).toEqual(ctx.service.projectView("sandbox")!.config.policy.risk);
    expect(sourceOf(view.layers, ["policy", "verify", "quick"])).toBe("panel");
    expect(sourceOf(view.layers, ["project", "machines"])).toBe("panel");
    ctx.service.setOverrides([
      {
        scope: "koyori",
        path: "policy.verify.quick",
        value: "pnpm test",
        expiresAt: null,
        actorId: TEST_OWNER,
        updatedAt: ctx.service.now(),
      },
    ]);
    expect(ctx.service.projectView("koyori")!.config.policy.verify.quick).toBe("pnpm test");
  });

  it("rejects risk and other locked fields in the policy patch", async () => {
    const ctx = await setup();
    const error = await rejection(
      ctx.admin.createProject(
        { key: "koyori", repo: KOYORI, machines: [], policyPatch: { risk: { T3: [] } } },
        actor,
      ),
    );
    expect(error.code).toBe("invalid");
    expect(error.issues?.[0]?.path).toBe("policyPatch");
  });

  it("deletes a panel project without touching harness.yaml projects", async () => {
    const ctx = await setup();
    await ctx.admin.createProject({ key: "koyori", repo: KOYORI, machines: [] }, actor);
    await ctx.admin.deleteProject("koyori", actor);
    expect(ctx.service.projectKeys()).toEqual(["sandbox"]);
    expect(ctx.store.projects.get("koyori")).toMatchObject({ binding: null, policyPatch: null });
    expect(ctx.store.events.at(-1)).toMatchObject({
      type: "project.deleted",
      projectKey: "koyori",
    });
    expect((await rejection(ctx.admin.deleteProject("koyori", actor))).code).toBe("not_found");
    expect((await rejection(ctx.admin.deleteProject("sandbox", actor))).code).toBe("read_only");
    expect((await rejection(ctx.admin.updateProject("sandbox", {}, actor))).code).toBe("read_only");
  });

  it("refuses to delete a project with work in flight", async () => {
    const ctx = await setup();
    await ctx.admin.createProject({ key: "koyori", repo: KOYORI, machines: [] }, actor);
    await ctx.store.insertRequest({
      projectKey: "koyori",
      type: "bug",
      state: "running",
      repo: KOYORI,
    });
    expect((await rejection(ctx.admin.deleteProject("koyori", actor))).code).toBe("conflict");
  });

  it("works with a harness.yaml that has no projects", async () => {
    const { projects: _, ...raw } = testConfigRaw({ machines: MACHINES });
    const ctx = await setup({ raw });
    expect(ctx.service.projectKeys()).toEqual([]);
    await ctx.admin.createProject({ key: "koyori", repo: KOYORI, machines: ["mbp"] }, actor);
    expect(ctx.service.projectKeys()).toEqual(["koyori"]);
    expect(ctx.telegram.topics).toEqual(["koyori"]);
  });
});

describe("harness.yaml wins over the panel", () => {
  it("reports shadowed panel entries instead of dropping them silently", async () => {
    const store = new MemoryHarnessStore();
    await store.upsertProject("sandbox", "example-owner/other", {
      binding: { repo: "example-owner/other", machines: [] },
    });
    await store.upsertProject("dup", TEST_REPO, { binding: { repo: TEST_REPO, machines: [] } });
    const ctx = await setup({ store });
    expect(ctx.service.projectKeys()).toEqual(["sandbox"]);
    expect(ctx.service.projectKeyForRepo(TEST_REPO)).toBe("sandbox");
    expect(ctx.service.projectView("sandbox")!.config.project.repo).toBe(TEST_REPO);
    const overview = await ctx.admin.overview();
    expect(overview.warnings).toEqual([
      "面板项目 dup 未生效：仓库已由 harness.yaml 项目 sandbox 绑定",
      "面板项目 sandbox 未生效：harness.yaml 中有同名项目，以 YAML 为准",
    ]);
    expect(overview.projects.map((p) => [p.key, p.source, p.editable])).toEqual([
      ["sandbox", "yaml", false],
      ["dup", "panel", true],
    ]);
    expect(overview.projects[1]!.topic.error).toContain("harness.yaml 项目 sandbox");
    await ctx.admin.deleteProject("dup", actor);
    expect((await ctx.admin.overview()).projects.map((p) => p.key)).toEqual(["sandbox"]);
  });

  it("keeps a shadowed panel patch away from the harness.yaml project", async () => {
    const store = new MemoryHarnessStore();
    await store.upsertProject("sandbox", "example-owner/other", {
      binding: { repo: "example-owner/other", machines: [] },
      policyPatch: { kind: "library" },
    });
    const ctx = await setup({ store });
    expect(ctx.service.projectView("sandbox")!.config.policy.kind).toBe("web");
    const error = await rejection(
      ctx.admin.updateProject("constructor", { execution: null }, actor),
    );
    expect(error.code).toBe("not_found");
  });

  it("rejects a new project that clashes with an existing key or repo", async () => {
    const ctx = await setup();
    const clashKey = await rejection(
      ctx.admin.createProject({ key: "sandbox", repo: KOYORI, machines: [] }, actor),
    );
    expect(clashKey.code).toBe("conflict");
    const clashRepo = await rejection(
      ctx.admin.createProject({ key: "other", repo: TEST_REPO, machines: [] }, actor),
    );
    expect(clashRepo.code).toBe("conflict");
  });
});

describe("admin validation", () => {
  it.each([
    [{ key: "Bad Key", repo: KOYORI, machines: [] }, "key"],
    [{ key: "global", repo: KOYORI, machines: [] }, "key"],
    [{ key: "koyori", repo: "not-a-repo", machines: [] }, "repo"],
    [{ key: "koyori", repo: KOYORI, machines: ["studio"] }, "machines"],
    [{ key: "koyori", repo: KOYORI, machines: ["constructor"] }, "machines"],
    [{ key: "koyori", repo: "someone/private", machines: [] }, "repo"],
    [{ key: "koyori", repo: KOYORI, machines: [], topic: 5 }, "(根)"],
  ])("rejects %j", async (input, path) => {
    const ctx = await setup();
    const error = await rejection(ctx.admin.createProject(input, actor));
    expect(error.code).toBe("invalid");
    expect(error.issues?.[0]?.path).toBe(path);
  });

  it("reports a missing harness and a harness.yaml that failed to load", async () => {
    await expect(new HarnessAdmin(null).overview()).resolves.toEqual({
      enabled: false,
      configError: null,
      chatId: null,
      projects: [],
      machines: [],
      execution: {
        effective: { agentConfig: null, model: null, effort: null },
        panel: null,
        agents: null,
      },
    });
    expect((await rejection(new HarnessAdmin(null).repos())).code).toBe("not_enabled");
    const service = new HarnessService({
      configPath: "/etc/harness.yaml",
      store: new MemoryHarnessStore(),
      github: null,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      loadConfig: async () => ({
        ok: false,
        issues: [{ path: "telegram.chatId", message: "必填" }],
      }),
    });
    await service.init();
    const overview = await new HarnessAdmin(service).overview();
    expect(overview).toMatchObject({ enabled: true, configError: "telegram.chatId: 必填" });
  });
});

describe("lead execution", () => {
  async function withLody() {
    const ctx = await setup({ lody: new FakeLody(() => new Date("2026-09-24T12:00:00Z")) });
    return ctx;
  }

  it("stores the global setting above harness.yaml and lists agents with models", async () => {
    const ctx = await withLody();
    const { execution } = await ctx.admin.setExecution(
      { agentConfig: "cfg-claude", model: "opus[1m]", effort: "max" },
      actor,
    );
    expect(execution.effective).toEqual({
      agentConfig: "cfg-claude",
      model: "opus[1m]",
      effort: "max",
    });
    expect(execution.panel).toEqual({
      agentConfig: "cfg-claude",
      model: "opus[1m]",
      effort: "max",
    });
    expect(execution.agents?.map((agent) => [agent.name, agent.models[0]?.id])).toEqual([
      ["Codex", "gpt-6-sol"],
      ["Claude Code", "default"],
    ]);
    expect(ctx.store.settings.get("execution")).toMatchObject({ model: "opus[1m]" });
    const view = ctx.service.projectView("sandbox")!;
    expect(sourceOf(view.layers, ["roles", "worker", "model"])).toBe("panel:global");
    await ctx.admin.setExecution({ agentConfig: null, model: null, effort: null }, actor);
    expect(ctx.store.settings.has("execution")).toBe(false);
    expect((await ctx.admin.overview()).execution.effective).toEqual({
      agentConfig: "Codex",
      model: "gpt-6-sol",
      effort: "high",
    });
  });

  it("uses newly reported model capabilities and preserves explicit YAML catalogs", async () => {
    const lody = new FakeLody(() => new Date());
    lody.agentConfigs = [
      {
        id: "new-agent",
        name: "New Codex",
        agentType: "codex",
        machineId: "server",
        models: [{ id: "new-model", name: "New model", efforts: ["low"] }],
      },
    ];
    const ctx = await setup({ lody });
    expect((await ctx.admin.overview()).execution.agents?.[0]?.models).toEqual(
      lody.agentConfigs[0]!.models,
    );
    const clear = vi.spyOn(lody, "clearCatalogCache");
    expect((await ctx.admin.refreshExecution()).execution.agents?.[0]?.models[0]?.id).toBe(
      "new-model",
    );
    expect(clear).toHaveBeenCalledOnce();
    const invalid = await rejection(
      ctx.admin.setExecution(
        { agentConfig: "new-agent", model: "new-model", effort: "high" },
        actor,
      ),
    );
    expect(invalid.issues?.[0]?.path).toBe("execution.effort");
    ctx.setRaw(
      testConfigRaw({
        machines: MACHINES,
        executors: {
          lody: { models: { codex: [{ id: "manual", name: "Manual", efforts: ["high"] }] } },
        },
      }),
    );
    await ctx.service.reload();
    expect((await ctx.admin.overview()).execution.agents?.[0]?.models[0]?.id).toBe("manual");
  });

  it("reports the connection failure instead of silently hiding model options", async () => {
    const ctx = await setup();
    expect((await ctx.admin.overview()).execution.agentError).toContain("未找到 lody CLI");
    expect((await rejection(ctx.admin.refreshExecution())).code).toBe("lody_unavailable");
  });

  it("updates the bridge runtime and records the resulting version", async () => {
    const ctx = await withLody();
    const runtime = {
      version: "0.103.0",
      machineName: "server",
      updating: false,
      canUpdate: true,
      updated: true,
    };
    const update = vi.fn(async () => runtime);
    vi.spyOn(ctx.service, "lodyRuntime").mockReturnValue({ status: async () => runtime, update });
    await expect(ctx.admin.updateRuntime(actor)).resolves.toEqual({ runtime });
    expect(update).toHaveBeenCalledOnce();
    expect(ctx.store.events.at(-1)).toMatchObject({
      type: "runtime.updated",
      payload: { version: "0.103.0" },
    });
  });

  it("refuses updates with live work and clears the maintenance flag", async () => {
    const ctx = await withLody();
    const runtime = {
      version: "0.103.0",
      machineName: "server",
      updating: false,
      canUpdate: true,
      updated: true,
    };
    const update = vi.fn(async () => runtime);
    vi.spyOn(ctx.service, "lodyRuntime").mockReturnValue({ status: async () => runtime, update });
    await ctx.store.insertRequest({
      projectKey: "sandbox",
      type: "bug",
      state: "running",
      repo: TEST_REPO,
    });
    expect((await rejection(ctx.admin.updateRuntime(actor))).code).toBe("conflict");
    expect(update).not.toHaveBeenCalled();
    expect(ctx.service.lodyUpdating).toBe(false);
  });

  it("discards cached availability after losing the update response", async () => {
    const ctx = await withLody();
    const clear = vi.spyOn(ctx.service.lody(), "clearCatalogCache");
    vi.spyOn(ctx.service, "lodyRuntime").mockReturnValue({
      status: async () => ({
        version: "0.100.0",
        machineName: "server",
        updating: true,
        canUpdate: true,
      }),
      update: async () => {
        throw new Error("connection lost");
      },
    });
    expect((await rejection(ctx.admin.updateRuntime(actor))).code).toBe("lody_unavailable");
    expect(clear).toHaveBeenCalledOnce();
    expect(ctx.service.lodyUpdating).toBe(false);
  });

  it.each([
    [{ agentConfig: "Missing", model: null, effort: null }, "execution.agentConfig"],
    [{ agentConfig: "cfg-codex", model: "gpt-5.5", effort: "ultra" }, "execution.effort"],
    [{ agentConfig: null, model: "bad model", effort: null }, "execution.model"],
    [{ agentConfig: null, model: null, effort: "turbo" }, "execution.effort"],
  ])("rejects %j", async (body, path) => {
    const ctx = await withLody();
    const error = await rejection(ctx.admin.setExecution(body, actor));
    expect(error.code).toBe("invalid");
    expect(error.issues?.[0]?.path).toBe(path);
  });

  it("accepts custom models and any agent while Lody is unreachable", async () => {
    const ctx = await setup();
    const { execution } = await ctx.admin.setExecution(
      { agentConfig: "Anything", model: "my-fork-model", effort: "ultra" },
      actor,
    );
    expect(execution.agents).toBeNull();
    expect(execution.effective.model).toBe("my-fork-model");
  });

  it("overrides one harness.yaml project but nothing else about it", async () => {
    const ctx = await withLody();
    const project = await ctx.admin.updateProject(
      "sandbox",
      { execution: { agentConfig: null, model: "gpt-6-astra", effort: null } },
      actor,
    );
    expect(project.source).toBe("yaml");
    expect(project.execution).toEqual({
      effective: { agentConfig: "Codex", model: "gpt-6-astra", effort: "high" },
      panel: { agentConfig: null, model: "gpt-6-astra", effort: null },
    });
    const error = await rejection(
      ctx.admin.updateProject("sandbox", { machines: [], execution: null }, actor),
    );
    expect(error.code).toBe("read_only");
  });
});

describe("repos and preview", () => {
  it("lists App-accessible repos with tracking and the install link", async () => {
    const ctx = await setup();
    const list = await ctx.admin.repos();
    expect(list.installUrl).toBe("https://github.com/apps/cos-harness/installations/new");
    expect(list.repos.map((repo) => [repo.fullName, repo.tracked])).toEqual([
      ["example-org/MoePeek", false],
      [TEST_REPO, true],
      [KOYORI, false],
    ]);
    ctx.github.available = false;
    expect((await rejection(ctx.admin.repos())).code).toBe("github_unavailable");
  });

  it("previews the repo policy, inference, and a free key", async () => {
    const ctx = await setup();
    ctx.github.repoFiles = { "Tuist.swift": "", "Project.swift": 'Project(name: "MoePeek")' };
    const native = await ctx.admin.preview({ repo: "example-org/MoePeek" });
    expect(native).toMatchObject({
      repo: "example-org/MoePeek",
      suggestedKey: "moepeek",
      suggestedLocalProject: "MoePeek",
      policy: { source: "inferred", kind: "native" },
    });
    ctx.github.policyText = "version: 1\nkind: library\n";
    const repo = await ctx.admin.preview({ repo: TEST_REPO });
    expect(repo.policy).toMatchObject({ source: "repo", kind: "library", error: null });
    expect(repo.suggestedKey).toBe("harness-sandbox");
  });

  it("shows Lody machines as unknown when Lody cannot be reached", async () => {
    const ctx = await setup();
    const overview = await ctx.admin.overview();
    expect(overview).toMatchObject({ enabled: true, configError: null, chatId: TEST_CHAT_ID });
    expect(overview.machines).toEqual([
      { key: "mbp", lodyName: "MBP-64G", online: null },
      { key: "mini", lodyName: "Mac-mini", online: null },
    ]);
  });
});
