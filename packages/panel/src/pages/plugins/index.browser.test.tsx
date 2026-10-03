import "@/style.css";
import { i18n } from "@/i18n";
import type { PluginBotState, PluginCatalogEntry } from "@cos-tool-bot/shared";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { beforeEach, expect, test, vi } from "vitest";
import { PluginRequestError, type PluginsApi } from "./api";
import { PluginMarketplace, PluginsPage } from "./index";

const sha = "a".repeat(40);
const nextSha = "b".repeat(40);
const plugin: PluginCatalogEntry = {
  manifest: {
    apiVersion: 1,
    id: "test.search",
    name: "Test search",
    version: "1.0.0",
    description: "Search integration",
    author: "Test author",
    config: [
      { key: "region", label: "Region", type: "string", required: true },
      { key: "cookie", label: "Cookie", type: "text", secret: true, required: true },
    ],
  },
  source: "builtin",
  installed: true,
  repository: null,
  commit: null,
  previousCommit: null,
  revision: 1,
};
function state(overrides: Partial<PluginBotState> = {}): PluginBotState {
  return {
    configuration: { values: { region: "China" }, configuredSecrets: ["cookie"] },
    revision: 3,
    manifestHash: "reviewed-manifest-hash",
    configuredVersion: "1.0.0",
    enabled: false,
    needsReview: false,
    updatedAt: null,
    runtime: { status: "disabled", error: null },
    ...overrides,
  };
}
function api(overrides: Partial<PluginsApi> = {}): PluginsApi {
  return {
    catalog: vi.fn(async () => [plugin]),
    bots: vi.fn(async () => [
      { id: "bot-1", name: "First Bot" },
      { id: "bot-2", name: "Second Bot" },
    ]),
    install: vi.fn(async () => plugin),
    update: vi.fn(async () => plugin),
    rollback: vi.fn(async () => plugin),
    remove: vi.fn(async () => {}),
    botState: vi.fn(async () => state()),
    saveBot: vi.fn(async () => state({ revision: 4 })),
    test: vi.fn(async () => ({ success: true })),
    startLogin: vi.fn(async () => ({
      id: "synthetic-session",
      status: "waiting" as const,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      qrUrl: "https://example.test/login/synthetic",
    })),
    pollLogin: vi.fn(async () => ({
      id: "synthetic-session",
      status: "expired" as const,
      expiresAt: new Date().toISOString(),
    })),
    cancelLogin: vi.fn(async () => ({
      id: "synthetic-session",
      status: "cancelled" as const,
      expiresAt: new Date().toISOString(),
    })),
    ...overrides,
  };
}
async function configure() {
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  await expect.element(page.getByLabelText("Region")).toBeVisible();
}
beforeEach(async () => {
  await i18n.changeLanguage("en");
  await page.viewport(1024, 900);
});

test("QR login is capability-gated and blocks unsaved normal, secret, and clear-secret drafts", async () => {
  const input = api({
    catalog: vi.fn(async () => [
      { ...plugin, manifest: { ...plugin.manifest, login: { type: "qr" as const } } },
    ]),
  });
  render(<PluginMarketplace api={input} />);
  await configure();
  const login = page.getByRole("button", { name: "Sign in with QR code" });
  await expect.element(login).toBeEnabled();
  await page.getByLabelText("Region").fill("unsaved-region");
  await expect.element(login).toBeDisabled();
  await expect.element(page.getByText(/Save or undo your configuration/)).toBeVisible();
  await page.getByLabelText("Region").fill("China");
  await expect.element(login).toBeEnabled();
  await page.getByLabelText("Cookie").fill("synthetic-unsaved-cookie");
  await expect.element(login).toBeDisabled();
  await page.getByLabelText("Cookie").fill("");
  await page.getByRole("button", { name: "Clear saved secret" }).click();
  await expect.element(login).toBeDisabled();
  await page.getByRole("button", { name: "Cancel clearing" }).click();
  await expect.element(login).toBeEnabled();
  expect(input.startLogin).not.toHaveBeenCalled();
});

test("QR login locks editing, uses confirmed revision, refreshes saved state, and preserves disabled status", async () => {
  const input = api({
    catalog: vi.fn(async () => [
      { ...plugin, manifest: { ...plugin.manifest, login: { type: "qr" as const } } },
    ]),
    pollLogin: vi.fn(async () => ({
      id: "synthetic-session",
      status: "connected" as const,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      account: { name: "Synthetic account" },
      botState: state({
        revision: 4,
        configuration: { values: { region: "Server saved region" }, configuredSecrets: ["cookie"] },
      }),
    })),
  });
  render(<PluginMarketplace api={input} />);
  await configure();
  await page.getByRole("button", { name: "Sign in with QR code" }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  expect(input.startLogin).toHaveBeenCalledWith("test.search", "bot-1", {
    expectedRevision: 3,
    manifestHash: "reviewed-manifest-hash",
  });
  expect((page.getByLabelText("Region").element() as HTMLInputElement).disabled).toBe(true);
  expect(
    (page.getByRole("button", { name: "Enable", exact: true }).element() as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await vi.waitFor(
    () => expect(document.body.textContent).toContain("Credentials have been saved"),
    { timeout: 4_000 },
  );
  expect(input.startLogin).toHaveBeenCalledTimes(1);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect.element(page.getByLabelText("Region")).toHaveValue("Server saved region");
  await expect.element(page.getByLabelText("Cookie")).toHaveValue("");
  await expect.element(page.getByRole("button", { name: "Enable", exact: true })).toBeEnabled();
  expect(input.saveBot).not.toHaveBeenCalled();
  expect(input.cancelLogin).not.toHaveBeenCalled();
}, 8_000);

test("plugins without login capability have no QR button and changed manifests require review first", async () => {
  const view = await render(<PluginMarketplace api={api()} />);
  await configure();
  await expect
    .element(page.getByRole("button", { name: "Sign in with QR code" }))
    .not.toBeInTheDocument();
  await view.unmount();
  const input = api({
    catalog: vi.fn(async () => [
      { ...plugin, manifest: { ...plugin.manifest, login: { type: "qr" as const } } },
    ]),
    botState: vi.fn(async () =>
      state({ needsReview: true, runtime: { status: "needs_review", error: null } }),
    ),
  });
  render(<PluginMarketplace api={input} />);
  await configure();
  await expect.element(page.getByRole("button", { name: "Sign in with QR code" })).toBeDisabled();
  await expect.element(page.getByText(/Review the plugin and save/)).toBeVisible();
  expect(input.startLogin).not.toHaveBeenCalled();
});

test("installs a builtin only after explicit server access confirmation then opens Bot configuration", async () => {
  const input = api({ catalog: vi.fn(async () => [{ ...plugin, installed: false }]) });
  render(<PluginMarketplace api={input} />);
  await page.getByRole("button", { name: "Install", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect.element(dialog.getByText(/server process permissions/)).toBeVisible();
  await expect.element(dialog.getByRole("button", { name: "Install", exact: true })).toBeDisabled();
  expect(input.install).not.toHaveBeenCalled();
  await dialog.getByRole("checkbox").click();
  await dialog.getByRole("button", { name: "Install", exact: true }).click();
  expect(input.install).toHaveBeenCalledWith({ builtinId: "test.search", trustHostAccess: true });
  await expect.element(page.getByLabelText("Cookie")).toHaveValue("");
  await expect
    .element(page.getByRole("combobox", { name: "Bot", exact: true }))
    .toHaveValue("bot-1");
});

test("validates canonical GitHub URL and full SHA before third-party installation", async () => {
  const input = api({
    install: vi.fn(async () => ({
      ...plugin,
      source: "git" as const,
      repository: "https://github.com/owner/search",
      commit: sha,
    })),
  });
  render(<PluginMarketplace api={input} />);
  await page.getByRole("button", { name: "Install from GitHub" }).click();
  await page
    .getByLabelText("GitHub repository URL")
    .fill("https://github.com/owner/search/tree/main");
  await page.getByLabelText("Full commit SHA").fill("main");
  await page.getByRole("checkbox").click();
  await page.getByRole("button", { name: "Install", exact: true }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("canonical GitHub repository URL");
  expect(input.install).not.toHaveBeenCalled();
  await page.getByLabelText("GitHub repository URL").fill("https://github.com/owner/search");
  await page.getByLabelText("Full commit SHA").fill(sha.toUpperCase());
  await page.getByRole("button", { name: "Install", exact: true }).click();
  expect(input.install).toHaveBeenCalledWith({
    repository: "https://github.com/owner/search",
    commit: sha,
    trustHostAccess: true,
  });
  await expect.element(page.getByLabelText("New commit SHA")).toBeVisible();
});

test("saves Cookie as write-only configuration and enables with the confirmed revision and manifest", async () => {
  const saveBot = vi
    .fn<PluginsApi["saveBot"]>()
    .mockResolvedValueOnce(state({ revision: 4 }))
    .mockResolvedValueOnce(
      state({ revision: 5, enabled: true, runtime: { status: "ready", error: null } }),
    );
  const input = api({ saveBot });
  render(<PluginMarketplace api={input} />);
  await configure();
  await page.getByLabelText("Region").fill("Japan");
  await page.getByLabelText("Cookie").fill("synthetic-private-cookie");
  await page.getByRole("button", { name: "Save configuration" }).click();
  expect(saveBot).toHaveBeenNthCalledWith(1, "test.search", "bot-1", {
    expectedRevision: 3,
    manifestHash: "reviewed-manifest-hash",
    configuration: { values: { region: "Japan" }, secrets: { cookie: "synthetic-private-cookie" } },
  });
  await expect.element(page.getByLabelText("Cookie")).toHaveValue("");
  expect(document.body.textContent).not.toContain("synthetic-private-cookie");
  await page.getByRole("button", { name: "Enable", exact: true }).click();
  expect(saveBot).toHaveBeenNthCalledWith(2, "test.search", "bot-1", {
    expectedRevision: 4,
    manifestHash: "reviewed-manifest-hash",
    enabled: true,
  });
  await expect.element(page.getByText("Ready", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Disable", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Test saved configuration" }).click();
  expect(input.test).toHaveBeenCalledWith("test.search", "bot-1");
  await expect.element(page.getByText("Plugin configuration test passed.")).toBeVisible();
});

test("a save conflict retains the secret draft and requires explicit reload before retry", async () => {
  const input = api({
    saveBot: vi.fn(async () => {
      throw new PluginRequestError(true);
    }),
  });
  render(<PluginMarketplace api={input} />);
  await configure();
  await page.getByLabelText("Cookie").fill("synthetic-unsaved-cookie");
  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect.element(page.getByText(/This plugin changed elsewhere/)).toBeVisible();
  await expect.element(page.getByLabelText("Cookie")).toHaveValue("synthetic-unsaved-cookie");
  await expect.element(page.getByRole("button", { name: "Enable", exact: true })).toBeDisabled();
  expect(document.body.textContent).not.toContain("synthetic-unsaved-cookie");
  await page.getByRole("button", { name: "Reload saved configuration" }).click();
  await expect.element(page.getByLabelText("Cookie")).toHaveValue("");
  await expect.element(page.getByRole("button", { name: "Enable", exact: true })).toBeEnabled();
  expect(input.botState).toHaveBeenCalledTimes(2);
});

test("reviewing and saving a changed configuration unlocks enable and preserves stored secrets", async () => {
  const input = api({
    botState: vi.fn(async () =>
      state({ needsReview: true, runtime: { status: "needs_review", error: null } }),
    ),
  });
  render(<PluginMarketplace api={input} />);
  await configure();
  await expect.element(page.getByRole("button", { name: "Enable", exact: true })).toBeDisabled();
  await expect
    .element(page.getByRole("button", { name: "Test saved configuration" }))
    .toBeDisabled();
  await page.getByRole("button", { name: "Save configuration" }).click();
  expect(input.saveBot).toHaveBeenCalledWith("test.search", "bot-1", {
    expectedRevision: 3,
    manifestHash: "reviewed-manifest-hash",
    configuration: { values: { region: "China" } },
  });
  await expect.element(page.getByRole("button", { name: "Enable", exact: true })).toBeEnabled();
  await expect.element(page.getByLabelText("Cookie")).toHaveValue("");
});

test("switching Bot discards private drafts and ignores a late save response", async () => {
  let finish!: (value: PluginBotState) => void;
  const saveBot = vi.fn(
    () =>
      new Promise<PluginBotState>((resolve) => {
        finish = resolve;
      }),
  );
  const input = api({
    saveBot,
    botState: vi.fn(async (_id, botId) =>
      state({
        configuration: {
          values: { region: botId === "bot-1" ? "First region" : "Second region" },
          configuredSecrets: [],
        },
      }),
    ),
  });
  render(<PluginMarketplace api={input} />);
  await configure();
  await page.getByLabelText("Cookie").fill("synthetic-first-bot-cookie");
  await page.getByRole("button", { name: "Save configuration" }).click();
  await page.getByRole("combobox", { name: "Bot", exact: true }).selectOptions("bot-2");
  await expect.element(page.getByLabelText("Region")).toHaveValue("Second region");
  await expect.element(page.getByLabelText("Cookie")).toHaveValue("");
  await page.getByLabelText("Region").fill("Second draft");
  finish(
    state({
      revision: 10,
      enabled: true,
      configuration: { values: { region: "Late first Bot" }, configuredSecrets: ["cookie"] },
    }),
  );
  await expect.element(page.getByLabelText("Region")).toHaveValue("Second draft");
  await expect.element(page.getByText("No secret is saved.")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Enable", exact: true })).toBeEnabled();
});

test("ignores a stale Bot load after switching and keeps runtime errors private", async () => {
  let finish!: (value: PluginBotState) => void;
  const input = api({
    botState: vi.fn((_id, botId) =>
      botId === "bot-1"
        ? new Promise<PluginBotState>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(
            state({
              configuration: { values: { region: "Second region" }, configuredSecrets: [] },
              runtime: { status: "error", error: "synthetic-server-secret" },
            }),
          ),
    ),
  });
  render(<PluginMarketplace api={input} />);
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  await page.getByRole("combobox", { name: "Bot", exact: true }).selectOptions("bot-2");
  await expect.element(page.getByLabelText("Region")).toHaveValue("Second region");
  finish(state());
  await expect.element(page.getByLabelText("Region")).toHaveValue("Second region");
  await expect
    .element(page.getByText("The plugin could not start. Check its configuration and retry."))
    .toBeVisible();
  expect(document.body.textContent).not.toContain("synthetic-server-secret");
});

test("updates a pinned version, blocks enable before config review, rolls back and confirms global removal", async () => {
  const gitEntry = {
    ...plugin,
    source: "git" as const,
    repository: "https://github.com/owner/search",
    commit: sha,
    previousCommit: "c".repeat(40),
  };
  const input = api({
    catalog: vi.fn(async () => [gitEntry]),
    update: vi.fn(async () => ({ ...gitEntry, revision: 2, commit: nextSha, previousCommit: sha })),
    rollback: vi.fn(async () => ({ ...gitEntry, revision: 3 })),
    botState: vi.fn(async () =>
      state({ needsReview: true, runtime: { status: "needs_review", error: null } }),
    ),
  });
  render(<PluginMarketplace api={input} />);
  await configure();
  await expect.element(page.getByRole("button", { name: "Enable", exact: true })).toBeDisabled();
  await page.getByLabelText("New commit SHA").fill("main");
  await expect.element(page.getByRole("button", { name: "Update to this commit" })).toBeDisabled();
  await page.getByLabelText("New commit SHA").fill(nextSha);
  await page.getByRole("button", { name: "Update to this commit" }).click();
  expect(input.update).toHaveBeenCalledWith("test.search", nextSha, 1);
  await expect.element(page.getByText(nextSha, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Roll back to previous commit" }).click();
  expect(input.rollback).toHaveBeenCalledWith("test.search", 2);
  await page.getByRole("button", { name: "Uninstall", exact: true }).click();
  await expect
    .element(page.getByRole("dialog").getByText(/Saved Bot configurations are retained/))
    .toBeVisible();
  expect(input.remove).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Confirm uninstall" }).click();
  expect(input.remove).toHaveBeenCalledWith("test.search", 3);
});

test("long third-party metadata and secrets fit a narrow screen and Chinese guidance is localized", async () => {
  await page.viewport(320, 844);
  await i18n.changeLanguage("zh-CN");
  const input = api({
    catalog: vi.fn(async () => [
      {
        ...plugin,
        manifest: {
          ...plugin.manifest,
          name: "x".repeat(120),
          description: "<script>test</script>" + "x".repeat(500),
        },
        source: "git" as const,
        repository: "https://github.com/owner/" + "x".repeat(120),
        commit: sha,
        previousCommit: nextSha,
      },
    ]),
  });
  render(<PluginMarketplace api={input} />);
  await page.getByRole("button", { name: "配置", exact: true }).click();
  await expect.element(page.getByLabelText("Cookie")).toBeVisible();
  await page.getByLabelText("Cookie").fill("synthetic-cookie=" + "x".repeat(8000));
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320);
  expect(document.querySelector("section script")).toBeNull();
  await page.getByRole("button", { name: "从 GitHub 安装" }).click();
  await expect.element(page.getByText(/插件以服务器进程权限运行/)).toBeVisible();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320);
});

test("viewer role cannot open the marketplace", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ data: { member: { role: "viewer" } } })),
  );
  try {
    render(<PluginsPage />);
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Only owners and administrators");
    expect(document.body.textContent).not.toContain("Install from GitHub");
  } finally {
    vi.unstubAllGlobals();
  }
});
