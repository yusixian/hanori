import { describe, expect, it } from "vitest";
import { getPath, sourceOf } from "./layers.js";
import {
  loadHarnessConfigFile,
  parseRepoPolicy,
  parseYamlObject,
  validateHarnessConfig,
} from "./loader.js";
import {
  GLOBAL_SCOPE,
  type HarnessOverride,
  isLockedPath,
  resolveGlobalConfig,
  resolveProjectConfig,
} from "./resolve.js";
import { parseDuration, parsePercent } from "./units.js";

const NOW = new Date("2026-09-24T12:00:00Z");

function minimalRaw(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    telegram: { bot: "example-dev", chatId: -1001234567890, owners: [123456789] },
    projects: { koyori: { repo: "example-owner/koyori" } },
    ...extra,
  };
}

function override(
  path: string,
  value: unknown,
  scope = GLOBAL_SCOPE,
  expiresAt: Date | null = null,
): HarnessOverride {
  return { scope, path, value, expiresAt, actorId: 1, updatedAt: NOW };
}

describe("units", () => {
  it("parses durations and percents", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("45m")).toBe(2_700_000);
    expect(parseDuration("6h")).toBe(21_600_000);
    expect(parseDuration("7d")).toBe(604_800_000);
    expect(parseDuration("0m")).toBeNull();
    expect(parseDuration("1h30m")).toBeNull();
    expect(parsePercent("10%")).toBe(10);
    expect(parsePercent("100%")).toBe(100);
    expect(parsePercent("101%")).toBeNull();
    expect(parsePercent("10")).toBeNull();
  });
});

describe("harness.yaml schema", () => {
  it("fills every default from the required fields alone", () => {
    const result = resolveGlobalConfig(minimalRaw(), [], NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.approvals).toEqual({
      ttl: "7d",
      stableConfirm: "twice",
      rollbackConfirm: "twice",
      mergeConfirm: "once",
    });
    expect(result.value.guardrails.concurrency).toEqual({
      perMachine: 4,
      perProject: 3,
      sameAreaWriters: 1,
    });
    expect(result.value.guardrails.quota.pauseAt).toEqual({ fiveHour: "95%", week: "90%" });
    expect(result.value.telegram.chat.casualReplies).toBe(false);
    expect(result.value.github.mergeMethod).toBe("squash");
    expect(result.value.projects.koyori!.topic).toBe("auto");
    expect(result.value.executors.lody.agentConfig).toBe("Codex");
    expect(result.value.roles.worker).toEqual({ effort: "high" });
    // Subworker and reviewer follow the lead's vendor at prompt time (execution.ts).
    expect(result.value.roles.reviewer).toBeUndefined();
  });

  it("merges partial roles over the built-in ones and accepts every effort", () => {
    const result = resolveGlobalConfig(
      minimalRaw({ roles: { worker: { model: "sonnet", effort: "ultra" } } }),
      [],
      NOW,
    );
    expect(result.ok && result.value.roles).toMatchObject({
      triage: { model: "sonnet", effort: "low" },
      worker: { model: "sonnet", effort: "ultra" },
    });
  });

  it("puts the panel execution above harness.yaml and below Telegram overrides", () => {
    const raw = minimalRaw({ roles: { worker: { model: "sonnet", effort: "medium" } } });
    const panel = { roles: { worker: { agent: "Codex", model: "gpt-6-astra" } } };
    const global = resolveGlobalConfig(raw, [override("roles.worker.effort", "max")], NOW, panel);
    expect(global.ok && global.value.roles.worker).toEqual({
      agent: "Codex",
      model: "gpt-6-astra",
      effort: "max",
    });
    expect(sourceOf(global.layers, ["roles", "worker", "model"])).toBe("panel:global");
    const project = resolveProjectConfig({
      raw,
      projectKey: "koyori",
      policy: null,
      panel: {
        binding: false,
        policyPatch: null,
        execution: { roles: { worker: { model: "gpt-6-luna" } } },
      },
      panelGlobal: panel,
      overrides: [override("roles.worker.model", "gpt-5.5", "koyori")],
      now: NOW,
    });
    expect(project.ok && project.value.roles.worker?.model).toBe("gpt-5.5");
    const layers = project.layers.map((layer) => layer.name);
    expect(layers.indexOf("panel:global")).toBeGreaterThan(layers.indexOf("yaml:project"));
    expect(layers.indexOf("panel")).toBeGreaterThan(layers.indexOf("panel:global"));
    expect(layers.indexOf("override:global")).toBeGreaterThan(layers.indexOf("panel"));
  });

  it("allows a harness.yaml without projects", () => {
    const { projects: _, ...raw } = minimalRaw();
    const result = validateHarnessConfig({ raw, sourcePath: "harness.yaml", now: NOW });
    expect(result.ok && result.config.file.projects).toEqual({});
  });

  it("reports invalid values with their field path", () => {
    const result = validateHarnessConfig({
      raw: minimalRaw({
        guardrails: { time: { idleRemindAfter: "soon" } },
        approvals: { ttl: "7d", typo: true },
      }),
      sourcePath: "harness.yaml",
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.issues.map((issue) => issue.path);
    expect(paths).toContain("guardrails.time.idleRemindAfter");
    expect(paths).toContain("approvals.typo");
  });

  it("locates project-level errors under projects.<key>", () => {
    const result = validateHarnessConfig({
      raw: minimalRaw({
        projects: {
          koyori: { repo: "example-owner/koyori", guardrails: { autoFixRounds: -1 } },
        },
      }),
      sourcePath: "harness.yaml",
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toEqual([
      "projects.koyori.guardrails.autoFixRounds",
    ]);
  });

  it("rejects the reserved global project key and missing owners", () => {
    const result = validateHarnessConfig({
      raw: {
        version: 1,
        telegram: { bot: "example-dev", chatId: -100, owners: [] },
        projects: { global: { repo: "a/b" } },
      },
      sourcePath: "harness.yaml",
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.issues.map((issue) => issue.path);
    expect(paths).toContain("telegram.owners");
    expect(paths).toContain("projects.global");
  });

  it("accepts the committed harness.example.yaml", async () => {
    const example = new URL("../../../../../harness.example.yaml", import.meta.url);
    const result = await loadHarnessConfigFile(example.pathname, NOW);
    expect(result.ok ? [] : result.issues).toEqual([]);
  });

  it("reports a missing file without throwing", async () => {
    const result = await loadHarnessConfigFile("/nonexistent/harness.yaml", NOW);
    expect(result).toEqual({
      ok: false,
      issues: [{ path: "/nonexistent/harness.yaml", message: "文件不存在" }],
    });
  });

  it("reports YAML syntax errors with a line position", () => {
    const parsed = parseYamlObject("version: 1\ntelegram: [\n", "harness.yaml");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues[0]!.path).toMatch(/^harness\.yaml:\d+:\d+$/);
  });
});

describe("layered merge", () => {
  const policy = { kind: "electron", risk: { T0: ["docs/**"] } };

  it("applies built-in → kind → yaml → yaml project → repo → overrides in order", () => {
    const raw = minimalRaw({
      guardrails: { autoFixRounds: 3 },
      projects: {
        koyori: {
          repo: "example-owner/koyori",
          guardrails: { concurrency: { perProject: 2 } },
        },
      },
    });
    const resolved = resolveProjectConfig({
      raw,
      projectKey: "koyori",
      policy,
      overrides: [
        override("guardrails.autoFixRounds", 5),
        override("guardrails.concurrency.perProject", 1, "koyori"),
      ],
      now: NOW,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const config = resolved.value;
    expect(config.guardrails.time.idleRemindAfter).toBe("90m");
    expect(config.policy.deploy.target).toBe("github-release");
    expect(config.policy.risk.T0).toEqual(["docs/**"]);
    expect(config.guardrails.autoFixRounds).toBe(5);
    expect(config.guardrails.concurrency.perProject).toBe(1);
    expect(config.guardrails.concurrency.perMachine).toBe(4);

    const layers = resolved.layers;
    expect(sourceOf(layers, ["guardrails", "time", "idleRemindAfter"])).toBe("kind");
    expect(sourceOf(layers, ["guardrails", "concurrency", "perMachine"])).toBe("default");
    expect(sourceOf(layers, ["guardrails", "autoFixRounds"])).toBe("override:global");
    expect(sourceOf(layers, ["guardrails", "concurrency", "perProject"])).toBe("override:project");
    expect(sourceOf(layers, ["policy", "risk", "T0"])).toBe("repo");
    expect(sourceOf(layers, ["project", "repo"])).toBe("yaml:project");
    expect(sourceOf(layers, ["telegram", "owners"])).toBe("yaml");
  });

  it("lets explicit YAML beat kind defaults and replaces arrays instead of merging", () => {
    const raw = minimalRaw({ guardrails: { time: { idleRemindAfter: "30m" } } });
    const resolved = resolveProjectConfig({
      raw,
      projectKey: "koyori",
      policy: { kind: "electron", contract: { sections: ["verify"] } },
      overrides: [],
      now: NOW,
    });
    expect(resolved.ok && resolved.value.guardrails.time.idleRemindAfter).toBe("30m");
    expect(resolved.ok && resolved.value.policy.contract.sections).toEqual(["verify"]);
  });

  it("ignores expired overrides so a TTL restores the YAML value", () => {
    const expiring = override(
      "guardrails.autoFixRounds",
      9,
      GLOBAL_SCOPE,
      new Date(NOW.getTime() + 60_000),
    );
    const before = resolveGlobalConfig(minimalRaw(), [expiring], NOW);
    const after = resolveGlobalConfig(minimalRaw(), [expiring], new Date(NOW.getTime() + 60_001));
    expect(before.ok && before.value.guardrails.autoFixRounds).toBe(9);
    expect(after.ok && after.value.guardrails.autoFixRounds).toBe(2);
  });

  it("attributes invalid override values to the override layer", () => {
    const resolved = resolveGlobalConfig(
      minimalRaw(),
      [override("guardrails.quota.pauseAt.week", "lots")],
      NOW,
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.issues[0]!.path).toBe("覆盖层 guardrails.quota.pauseAt.week");
  });

  it("reads nested values", () => {
    expect(getPath({ a: { b: [1] } }, ["a", "b"])).toEqual([1]);
    expect(getPath({ a: 1 }, ["a", "b"])).toBeUndefined();
  });
});

describe("locked fields", () => {
  it.each([
    "telegram.owners",
    "telegram.chatId",
    "telegram",
    "approvals.ttl",
    "risk.T0",
    "policy.risk",
    "executors.lody.cli",
    "executors.lody.bridge.urlEnv",
    "executors.lody.bridge.secretEnv",
    "executors",
    "guardrails.autonomy.autoMergeTiers",
    "guardrails.autonomy",
    "deploy.dokploy.apiKeyEnv",
    "github.webhookSecretEnv",
    "project.repo",
  ])("refuses %s", (path) => {
    expect(isLockedPath(path.split("."))).toBe(true);
  });

  it.each([
    "guardrails.time.idleRemindAfter",
    "telegram.cards.summary",
    "policy.contract.sections",
  ])("allows %s", (path) => {
    expect(isLockedPath(path.split("."))).toBe(false);
  });
});

describe("repo policy", () => {
  it("parses a valid policy with defaults", () => {
    const parsed = parseRepoPolicy("version: 1\nkind: library\n");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.policy.kind).toBe("library");
    expect(parsed.policy.risk.default).toBe("T2");
    expect(parsed.policy.contract.screenshots).toBe("when-ui");
  });

  it("reports policy errors against .cos/harness.yml paths", () => {
    const parsed = parseRepoPolicy("kind: desktop\nrisk:\n  T4: []\n");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const paths = parsed.issues.map((issue) => issue.path);
    expect(paths).toContain(".cos/harness.yml: kind");
    expect(paths).toContain(".cos/harness.yml: risk.T4");
  });
});
