import type {
  HarnessAdminAgentOption,
  HarnessAdminExecution,
  HarnessAdminOverview,
  HarnessAdminPolicySummary,
  HarnessAdminProject,
  HarnessAdminProjectPatch,
} from "@cos-tool-bot/shared";
import { i18n } from "@/i18n";
import { HarnessAdminApiError, type HarnessAdminApi } from "@/lib/harness-admin-client";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { beforeEach, expect, test, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
import { HarnessAdminScreen } from "./harness-admin-screen";

const POLICY: HarnessAdminPolicySummary = {
  source: "repo",
  kind: "web",
  verify: { quick: "pnpm test", full: "pnpm build", acceptance: null },
  releaseFragment: "optional",
  preferSkills: [],
  riskDefault: "T1",
  riskT3: [],
  error: null,
};

const AGENTS: HarnessAdminAgentOption[] = [
  {
    id: "agent-codex",
    name: "Codex",
    agentType: "codex",
    models: [
      { id: "gpt-6-sol", name: "gpt-6-sol", efforts: ["low", "medium", "high", "xhigh"] },
      { id: "gpt-6-mini", name: "gpt-6-mini", efforts: ["low", "medium"] },
    ],
  },
  {
    id: "agent-claude",
    name: "Claude",
    agentType: "claude",
    models: [{ id: "opus", name: "Opus", efforts: ["high", "max"] }],
  },
];
const EFFECTIVE: HarnessAdminExecution = {
  agentConfig: "agent-codex",
  model: "gpt-6-sol",
  effort: "xhigh",
};

const YAML_PROJECT: HarnessAdminProject = {
  key: "cosine",
  repo: "example-owner/example-gallery",
  source: "yaml",
  editable: false,
  machines: ["mbp"],
  localProject: "example-gallery",
  topic: { threadId: 12, url: "https://t.me/c/1/12", error: null },
  policy: POLICY,
  policyPatch: null,
  execution: { effective: EFFECTIVE, panel: null },
};

const PANEL_PROJECT: HarnessAdminProject = {
  key: "koyori",
  repo: "example-org/koyori",
  source: "panel",
  editable: true,
  machines: ["mbp"],
  localProject: "koyori",
  topic: { threadId: null, url: null, error: "Topic creation failed" },
  policy: { ...POLICY, source: "inferred", error: "harness.yml is invalid" },
  policyPatch: null,
  execution: { effective: EFFECTIVE, panel: null },
};

function overview(patch: Partial<HarnessAdminOverview> = {}): HarnessAdminOverview {
  return {
    enabled: true,
    configError: null,
    chatId: -100,
    projects: [YAML_PROJECT, PANEL_PROJECT],
    machines: [
      { key: "mbp", lodyName: "MacBook Pro", online: true },
      { key: "mini", lodyName: "mini", online: false },
      { key: "studio", lodyName: "studio", online: null },
    ],
    execution: { effective: EFFECTIVE, panel: EFFECTIVE, agents: AGENTS },
    ...patch,
  };
}

function fakeApi(patch: Partial<HarnessAdminApi> = {}) {
  return {
    overview: vi.fn(async () => overview()),
    repos: vi.fn(async () => ({
      repos: [
        {
          fullName: "example-owner/example-gallery",
          private: false,
          defaultBranch: "main",
          tracked: true,
        },
        { fullName: "SomeACG/site", private: true, defaultBranch: "main", tracked: false },
        { fullName: "example-org/koyori", private: false, defaultBranch: "main", tracked: true },
        { fullName: "example-owner/notes", private: false, defaultBranch: "main", tracked: false },
      ],
      installUrl: "https://github.com/apps/cos/installations/new",
    })),
    preview: vi.fn(async (repo: string) => ({
      repo,
      suggestedKey: "notes",
      suggestedLocalProject: "notes",
      policy: { ...POLICY, source: "inferred" as const, kind: "library" as const },
    })),
    createProject: vi.fn(async (input) => ({ ...PANEL_PROJECT, key: input.key, repo: input.repo })),
    updateProject: vi.fn(async (key: string, body: HarnessAdminProjectPatch) => ({
      ...PANEL_PROJECT,
      key,
      machines: body.machines ?? PANEL_PROJECT.machines,
    })),
    deleteProject: vi.fn(async () => undefined),
    updateExecution: vi.fn(async (execution: HarnessAdminExecution) => ({
      effective: execution,
      panel: execution,
      agents: AGENTS,
    })),
    refreshExecution: vi.fn(async () => overview().execution),
    updateRuntime: vi.fn(async () => ({
      version: "0.103.0",
      machineName: "server",
      canUpdate: true,
      updating: false,
      updated: true,
    })),
    ...patch,
  } satisfies HarnessAdminApi;
}

function renderScreen(api: HarnessAdminApi, path = "/harness") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/harness/*"
          element={<HarnessAdminScreen api={api} basePath="/harness" surface="panel" />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  await page.viewport(1280, 900);
});

test.each([1280, 390])(
  "updates the CLI and refreshes models without discarding a draft at %i px",
  async (width) => {
    await page.viewport(width, 844);
    const runtime = { version: "0.100.0", machineName: "server", updating: false, canUpdate: true };
    const fresh = {
      ...overview().execution,
      runtime: { ...runtime, version: "0.103.0" },
      agents: AGENTS.map((agent) => ({
        ...agent,
        models: [...agent.models, { id: "new-model", name: "New model", efforts: ["high"] }],
      })),
    };
    let refreshed = false;
    const api = fakeApi({
      overview: vi.fn(async () =>
        overview({ execution: refreshed ? fresh : { ...overview().execution, runtime } }),
      ),
      refreshExecution: vi.fn(async () => {
        refreshed = true;
        return fresh;
      }),
    });
    renderScreen(api);
    await expect.element(page.getByText("server · Lody CLI 0.100.0")).toBeVisible();
    await page.getByText("修改执行设置").click();
    const model = page.getByRole("combobox", { name: "模型" });
    await model.selectOptions("gpt-6-mini");
    await page.getByRole("button", { name: "更新服务器 CLI" }).click();
    await expect.element(page.getByText("服务器 Lody CLI 已更新至 0.103.0。")).toBeVisible();
    await expect.element(model).toHaveValue("gpt-6-mini");
    await expect.element(page.getByRole("option", { name: "New model" })).toBeInTheDocument();
    expect(api.updateRuntime).toHaveBeenCalledOnce();
    expect(api.refreshExecution).toHaveBeenCalledOnce();
    expect(api.updateExecution).not.toHaveBeenCalled();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  },
);

test("shows refresh failures while CLI updates remain unavailable", async () => {
  const api = fakeApi({
    refreshExecution: vi.fn(async () => {
      throw new HarnessAdminApiError("共享密钥不匹配", 503, "lody_unavailable");
    }),
  });
  renderScreen(api);
  await expect.element(page.getByRole("button", { name: "更新服务器 CLI" })).toBeDisabled();
  await page.getByRole("button", { name: "刷新 Agent / 模型" }).click();
  await expect.element(page.getByText("共享密钥不匹配")).toBeVisible();
  expect(api.updateRuntime).not.toHaveBeenCalled();
});

test("clears inherited reasoning effort for models that do not support it", async () => {
  const agents = AGENTS.map((agent) => ({
    ...agent,
    models: [...agent.models, { id: "no-effort", name: "No effort model", efforts: [] }],
  }));
  const api = fakeApi({
    overview: vi.fn(async () => overview({ execution: { ...overview().execution, agents } })),
  });
  renderScreen(api);
  await expect.element(page.getByRole("heading", { name: "执行设置" })).toBeVisible();
  await page.getByText("修改执行设置").click();
  await page.getByRole("combobox", { name: "模型" }).selectOptions("no-effort");
  await page.getByRole("button", { name: "保存执行设置" }).click();
  expect(api.updateExecution).toHaveBeenLastCalledWith({
    agentConfig: "agent-codex",
    model: "no-effort",
    effort: "default",
  });
});

test("lists projects with source, machines, topic, policy, and problems", async () => {
  renderScreen(fakeApi());

  await expect.element(page.getByRole("heading", { name: "cosine" })).toBeVisible();
  await expect.element(page.getByText("来自 harness.yaml")).toBeVisible();
  await expect.element(page.getByText("面板管理")).toBeVisible();
  await expect.element(page.getByText("仓库配置")).toBeVisible();
  await expect.element(page.getByText("自动推断")).toBeVisible();
  expect(page.getByText("pnpm test").all()).toHaveLength(2);
  await expect
    .element(page.getByRole("link", { name: "打开话题" }))
    .toHaveAttribute("href", "https://t.me/c/1/12");
  await expect.element(page.getByText("话题异常：Topic creation failed")).toBeVisible();
  await expect.element(page.getByText("策略读取失败：harness.yml is invalid")).toBeVisible();
  await expect.element(page.getByRole("link", { name: "查看 cosine" })).toBeVisible();
  await expect.element(page.getByRole("link", { name: "编辑 koyori" })).toBeVisible();
});

test("explains that Harness must be configured first", async () => {
  renderScreen(fakeApi({ overview: vi.fn(async () => overview({ enabled: false })) }));
  await expect.element(page.getByRole("heading", { name: "Dev Harness 尚未启用" })).toBeVisible();
  await expect.element(page.getByText(/HARNESS_CONFIG_PATH/)).toBeVisible();
  expect(page.getByRole("link", { name: "添加项目" }).query()).toBeNull();
});

test("shows a config error instead of the list", async () => {
  renderScreen(
    fakeApi({ overview: vi.fn(async () => overview({ configError: "line 3: bad indent" })) }),
  );
  await expect.element(page.getByRole("heading", { name: "harness.yaml 加载失败" })).toBeVisible();
  await expect.element(page.getByText("line 3: bad indent")).toBeVisible();
  expect(page.getByRole("heading", { name: "cosine" }).query()).toBeNull();
});

test("shows a forbidden state for non-owners", async () => {
  renderScreen(
    fakeApi({
      overview: vi.fn(async () => {
        throw new HarnessAdminApiError("no", 403, "forbidden");
      }),
    }),
  );
  await expect.element(page.getByRole("heading", { name: "无权管理 Dev Harness" })).toBeVisible();
});

test("points an empty list to Add project", async () => {
  renderScreen(fakeApi({ overview: vi.fn(async () => overview({ projects: [] })) }));
  await expect.element(page.getByRole("heading", { name: "还没有项目" })).toBeVisible();
  expect(page.getByRole("link", { name: "添加项目" }).all().length).toBeGreaterThan(0);
});

test("adds a project from a repository with only changed policy fields", async () => {
  const api = fakeApi({
    createProject: vi
      .fn<HarnessAdminApi["createProject"]>()
      .mockRejectedValueOnce(
        new HarnessAdminApiError("Invalid", 400, "invalid", [
          { path: "key", message: "key already exists" },
          { path: "repo", message: "repo is archived" },
        ]),
      )
      .mockImplementation(async (input) => ({ ...PANEL_PROJECT, key: input.key })),
  });
  renderScreen(api, "/harness/new");

  await expect.element(page.getByText("SomeACG", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("radio", { name: "example-org/koyori" })).toBeDisabled();
  expect(page.getByText("已接入").all()).toHaveLength(2);
  await expect
    .element(page.getByRole("link", { name: "去 GitHub 授权更多仓库" }))
    .toHaveAttribute("href", "https://github.com/apps/cos/installations/new");

  await userEvent.fill(page.getByRole("searchbox"), "example-owner");
  expect(page.getByText("SomeACG", { exact: true }).query()).toBeNull();
  await page.getByRole("radio", { name: "example-owner/notes" }).click();

  expect(api.preview).toHaveBeenCalledWith("example-owner/notes");
  await expect.element(page.getByRole("textbox", { name: "项目标识" })).toHaveValue("notes");
  await expect.element(page.getByRole("checkbox", { name: /mbp/ })).toBeChecked();
  await expect.element(page.getByRole("checkbox", { name: /mini/ })).not.toBeChecked();
  await expect.element(page.getByRole("checkbox", { name: /studio/ })).toBeChecked();
  await expect.element(page.getByText("离线")).toBeVisible();
  await expect.element(page.getByText("状态未知")).toBeVisible();

  await userEvent.fill(page.getByRole("textbox", { name: "项目标识" }), "Notes!");
  await expect.element(page.getByText(/以小写字母或数字开头/)).toBeVisible();
  await expect.element(page.getByRole("button", { name: "保存项目" })).toBeDisabled();
  await userEvent.fill(page.getByRole("textbox", { name: "项目标识" }), "notes");

  await page.getByText("高级", { exact: true }).click();
  await page.getByRole("combobox", { name: "项目类型" }).selectOptions("native");
  await page.getByRole("button", { name: "保存项目" }).click();

  await expect.element(page.getByText("key already exists")).toBeVisible();
  await expect.element(page.getByText("repo is archived")).toBeVisible();

  await page.getByRole("button", { name: "保存项目" }).click();
  await expect.element(page.getByText("已添加 notes，立即生效。")).toBeVisible();
  expect(api.createProject).toHaveBeenLastCalledWith({
    key: "notes",
    repo: "example-owner/notes",
    machines: ["mbp", "studio"],
    policyPatch: { kind: "native" },
  });
});

test("lets harness.yaml projects override only execution", async () => {
  const api = fakeApi();
  renderScreen(api, "/harness/cosine");
  await expect.element(page.getByText("在 harness.yaml 中修改", { exact: true })).toBeVisible();
  expect(page.getByRole("button", { name: "删除项目" }).query()).toBeNull();
  expect(page.getByRole("checkbox", { name: /mbp/ }).query()).toBeNull();
  expect(page.getByText("高级", { exact: true }).query()).toBeNull();

  const save = page.getByRole("button", { name: "保存修改" });
  await expect.element(save).toBeDisabled();
  await page.getByRole("checkbox", { name: "此项目单独设置模型" }).click();
  await page.getByRole("combobox", { name: "Agent" }).selectOptions("agent-claude");
  await expect.element(page.getByRole("combobox", { name: "模型" })).toHaveValue("opus");
  await expect.element(page.getByRole("combobox", { name: "推理强度" })).toHaveValue("high");
  await save.click();

  expect(api.updateProject).toHaveBeenCalledWith("cosine", {
    execution: { agentConfig: "agent-claude", model: "opus", effort: "high" },
  });
});

test("edits the global execution settings", async () => {
  const api = fakeApi();
  renderScreen(api);

  await expect.element(page.getByRole("heading", { name: "执行设置" })).toBeVisible();
  expect(page.getByText("Codex · gpt-6-sol · xhigh").all().length).toBeGreaterThanOrEqual(3);

  await page.getByText("修改执行设置").click();
  const model = page.getByRole("combobox", { name: "模型" });
  const effort = page.getByRole("combobox", { name: "推理强度" });
  await model.selectOptions("gpt-6-mini");
  await expect.element(effort).toHaveValue("low");

  await model.selectOptions("__custom__");
  await userEvent.fill(page.getByRole("textbox", { name: "自定义模型 ID" }), "gpt-7-preview");
  await page.getByRole("button", { name: "保存执行设置" }).click();
  expect(api.updateExecution).toHaveBeenLastCalledWith({
    agentConfig: "agent-codex",
    model: "gpt-7-preview",
    effort: "low",
  });
  await expect.element(page.getByText("执行设置已保存")).toBeVisible();

  await page.getByRole("button", { name: "恢复默认" }).click();
  expect(api.updateExecution).toHaveBeenLastCalledWith({
    agentConfig: null,
    model: null,
    effort: null,
  });
});

test("keeps the execution value readable when Lody is unreachable", async () => {
  renderScreen(
    fakeApi({
      overview: vi.fn(async () =>
        overview({ execution: { effective: EFFECTIVE, panel: null, agents: null } }),
      ),
    }),
  );
  await expect.element(page.getByText(/无法连接 Lody/)).toBeVisible();
  await page.getByText("修改执行设置").click();
  await expect.element(page.getByRole("textbox", { name: "Agent" })).toHaveValue("");
  await expect.element(page.getByText("agent-codex · gpt-6-sol · xhigh").first()).toBeVisible();
});

test("edits machines and deletes a panel project after confirmation", async () => {
  const api = fakeApi();
  renderScreen(api, "/harness/koyori");

  const save = page.getByRole("button", { name: "保存修改" });
  await expect.element(save).toBeDisabled();
  await page.getByRole("checkbox", { name: /studio/ }).click();
  await save.click();
  expect(api.updateProject).toHaveBeenCalledWith("koyori", { machines: ["mbp", "studio"] });
  await expect.element(page.getByText("已保存")).toBeVisible();

  await page.getByRole("button", { name: "删除项目" }).click();
  expect(api.deleteProject).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "确认删除" }).click();
  expect(api.deleteProject).toHaveBeenCalledWith("koyori");
  await expect.element(page.getByText("已删除 koyori。")).toBeVisible();
  expect(page.getByRole("heading", { name: "koyori" }).query()).toBeNull();
});
