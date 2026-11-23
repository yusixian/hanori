import { i18n } from "@/i18n";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_GITHUB_TOOLS } from "../types";
import { GitHubToolsSection } from "./github-tools-section";

beforeEach(async () => {
  await i18n.changeLanguage("en");
  await page.viewport(1440, 900);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubUnavailableGitHubApp() {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            data: { available: false, connected: false, legacyPat: false },
          }),
          { status: 200 },
        ),
    ),
  );
}

test("hides credential operations from editors and viewers", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  render(
    <GitHubToolsSection
      botId="test-id"
      canManageCredentials={false}
      authorizationBlocked={false}
      providers={[]}
      config={{ ...DEFAULT_GITHUB_TOOLS, enabled: true }}
      onUpdate={vi.fn()}
    />,
  );

  await expect.element(page.getByText("Enable GitHub tools")).toBeVisible();
  expect(document.body.textContent).not.toContain("Connect GitHub");
  expect(document.body.textContent).not.toContain("GitHub App authorization");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("lets administrators make Create Issue confirmations non-expiring", async () => {
  stubUnavailableGitHubApp();
  const onUpdate = vi.fn();

  render(
    <GitHubToolsSection
      botId="test-id"
      canManageCredentials
      authorizationBlocked={false}
      providers={[]}
      config={{
        ...DEFAULT_GITHUB_TOOLS,
        enabled: true,
        createIssueConfirmationTtlMinutes: 15,
      }}
      onUpdate={onUpdate}
    />,
  );

  await page.getByRole("switch", { name: "Create Issue confirmations never expire" }).click();
  expect(onUpdate).toHaveBeenLastCalledWith({ createIssueConfirmationTtlMinutes: null });
});

test("switches to a finite confirmation period and saves its minute value", async () => {
  stubUnavailableGitHubApp();
  const onUpdate = vi.fn();
  const view = await render(
    <GitHubToolsSection
      botId="test-id"
      canManageCredentials
      authorizationBlocked={false}
      providers={[]}
      config={{
        ...DEFAULT_GITHUB_TOOLS,
        enabled: true,
      }}
      onUpdate={onUpdate}
    />,
  );

  await page.getByRole("switch", { name: "Create Issue confirmations never expire" }).click();
  expect(onUpdate).toHaveBeenLastCalledWith({ createIssueConfirmationTtlMinutes: 10 });

  await view.rerender(
    <GitHubToolsSection
      botId="test-id"
      canManageCredentials
      authorizationBlocked={false}
      providers={[]}
      config={{
        ...DEFAULT_GITHUB_TOOLS,
        enabled: true,
        createIssueConfirmationTtlMinutes: 10,
      }}
      onUpdate={onUpdate}
    />,
  );
  const minutes = page.getByRole("spinbutton", { name: "Confirmation validity (minutes)" });
  await minutes.fill("25");
  expect(onUpdate).toHaveBeenLastCalledWith({ createIssueConfirmationTtlMinutes: 25 });
  await minutes.fill("5256001");
  expect(onUpdate).toHaveBeenLastCalledWith({ createIssueConfirmationTtlMinutes: 5_256_001 });
});

test("does not save invalid confirmation minute values", async () => {
  stubUnavailableGitHubApp();
  const onUpdate = vi.fn();
  render(
    <GitHubToolsSection
      botId="test-id"
      canManageCredentials
      authorizationBlocked={false}
      providers={[]}
      config={{ ...DEFAULT_GITHUB_TOOLS, enabled: true, createIssueConfirmationTtlMinutes: 10 }}
      onUpdate={onUpdate}
    />,
  );
  const minutes = page.getByRole("spinbutton", { name: "Confirmation validity (minutes)" });
  for (const value of ["0", "1.5", "9007199254740992"]) {
    await minutes.fill(value);
    expect(onUpdate).not.toHaveBeenCalled();
  }
});

test("restricts the confirmation policy to credential managers and disables it with GitHub tools", async () => {
  stubUnavailableGitHubApp();
  const onUpdate = vi.fn();
  const view = await render(
    <GitHubToolsSection
      botId="test-id"
      canManageCredentials={false}
      authorizationBlocked={false}
      providers={[]}
      config={{
        ...DEFAULT_GITHUB_TOOLS,
        enabled: true,
        createIssueConfirmationTtlMinutes: 10,
      }}
      onUpdate={onUpdate}
    />,
  );

  expect(document.body.textContent).not.toContain("Create Issue confirmations never expire");

  await view.rerender(
    <GitHubToolsSection
      botId="test-id"
      canManageCredentials
      authorizationBlocked={false}
      providers={[]}
      config={{
        ...DEFAULT_GITHUB_TOOLS,
        enabled: false,
        createIssueConfirmationTtlMinutes: 10,
      }}
      onUpdate={onUpdate}
    />,
  );

  await expect
    .element(page.getByRole("switch", { name: "Create Issue confirmations never expire" }))
    .toBeDisabled();
  await expect
    .element(page.getByRole("spinbutton", { name: "Confirmation validity (minutes)" }))
    .toBeDisabled();
  expect(onUpdate).not.toHaveBeenCalled();
});

test("lets administrators select a dedicated coding provider and model", async () => {
  const onUpdate = vi.fn();
  const providers = [
    {
      id: "chat-provider",
      label: "Chat Provider",
      hasApiKey: true,
      baseURL: "https://chat.example/v1",
      providerFormat: "openai" as const,
      defaultModel: "chat-model",
    },
    {
      id: "coding-provider",
      label: "Coding Provider",
      hasApiKey: true,
      baseURL: "https://coding.example/v1",
      providerFormat: "openai" as const,
      defaultModel: "coding-default",
      models: [{ id: "coding-model", label: "Coding Model" }],
    },
  ];
  const view = await render(
    <GitHubToolsSection
      botId="test-id"
      canManageCredentials={false}
      authorizationBlocked={false}
      providers={providers}
      config={{
        ...DEFAULT_GITHUB_TOOLS,
        enabled: true,
        codingAgentEnabled: true,
      }}
      onUpdate={onUpdate}
    />,
  );

  await page.getByRole("combobox", { name: "Coding provider" }).click();
  await page.getByRole("option", { name: "Coding Provider" }).click();
  expect(onUpdate).toHaveBeenLastCalledWith({
    codingProviderId: "coding-provider",
    codingModelId: undefined,
  });

  await view.rerender(
    <GitHubToolsSection
      botId="test-id"
      canManageCredentials={false}
      authorizationBlocked={false}
      providers={providers}
      config={{
        ...DEFAULT_GITHUB_TOOLS,
        enabled: true,
        codingAgentEnabled: true,
        codingProviderId: "coding-provider",
      }}
      onUpdate={onUpdate}
    />,
  );
  await page.getByRole("combobox", { name: "Coding model" }).click();
  await page.getByRole("option", { name: "Coding Model" }).click();
  expect(onUpdate).toHaveBeenLastCalledWith({ codingModelId: "coding-model" });
});

test("disables providers without an API key but accepts a key entered in the same draft", async () => {
  const onUpdate = vi.fn();
  render(
    <GitHubToolsSection
      botId="test-id"
      canManageCredentials={false}
      authorizationBlocked={false}
      providers={[
        {
          id: "no-key",
          label: "Missing Key",
          hasApiKey: false,
          baseURL: "https://missing.example/v1",
          providerFormat: "openai",
          defaultModel: "missing-model",
        },
        {
          id: "draft-key",
          label: "Draft Key",
          hasApiKey: false,
          baseURL: "https://draft.example/v1",
          providerFormat: "openai",
          defaultModel: "draft-model",
        },
      ]}
      providerApiKeyDrafts={{ "draft-key": "new-secret" }}
      config={{
        ...DEFAULT_GITHUB_TOOLS,
        enabled: true,
        codingAgentEnabled: true,
        codingProviderId: "no-key",
      }}
      onUpdate={onUpdate}
    />,
  );

  await expect.element(page.getByText(/This coding provider has no API key/)).toBeVisible();
  await expect.element(page.getByRole("combobox", { name: "Coding model" })).toBeDisabled();

  await page.getByRole("combobox", { name: "Coding provider" }).click();
  await expect
    .element(page.getByRole("option", { name: "Missing Key (API key required)" }))
    .toBeDisabled();
  const draftOption = page.getByRole("option", { name: "Draft Key" });
  await expect.element(draftOption).toBeEnabled();
  await draftOption.click();
  expect(onUpdate).toHaveBeenLastCalledWith({
    codingProviderId: "draft-key",
    codingModelId: undefined,
  });
});

test("shows the installation account, repositories, and permissions to administrators", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            data: {
              available: true,
              connected: true,
              legacyPat: false,
              connectionError: "The installation was revoked on GitHub",
              installation: {
                installationId: 42,
                accountLogin: "hanori",
                accountType: "Organization",
                repositorySelection: "selected",
                repositories: ["cos/example", "cos/private"],
                permissions: { contents: "write", issues: "write", metadata: "read" },
              },
            },
          }),
          { status: 200 },
        ),
    ),
  );

  render(
    <GitHubToolsSection
      botId="test-id"
      canManageCredentials
      authorizationBlocked={false}
      providers={[]}
      config={{ ...DEFAULT_GITHUB_TOOLS, enabled: true }}
      onUpdate={vi.fn()}
    />,
  );

  await expect.element(page.getByText("hanori", { exact: true })).toBeVisible();
  await expect.element(page.getByText("cos/example", { exact: true })).toBeVisible();
  await expect.element(page.getByText("contents: write", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("The installation was revoked on GitHub");
  await expect.element(page.getByRole("button", { name: "Modify authorization" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
});

test("explains which server configuration is missing", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            data: {
              available: false,
              connected: false,
              legacyPat: false,
              configurationError: "GITHUB_APP_PRIVATE_KEY is missing",
            },
          }),
          { status: 200 },
        ),
    ),
  );

  render(
    <GitHubToolsSection
      botId="test-id"
      canManageCredentials
      authorizationBlocked={false}
      providers={[]}
      config={DEFAULT_GITHUB_TOOLS}
      onUpdate={vi.fn()}
    />,
  );

  await expect.element(page.getByText("GitHub App is not configured on the server")).toBeVisible();
  await expect.element(page.getByText("GITHUB_APP_PRIVATE_KEY is missing")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Connect GitHub" })).toBeDisabled();
});

test("ignores a stale status response after switching bots", async () => {
  let resolveFirst!: (response: Response) => void;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes("first-bot")) {
      return new Promise<Response>((resolve) => {
        resolveFirst = resolve;
      });
    }
    return new Response(
      JSON.stringify({
        ok: true,
        data: {
          available: true,
          connected: true,
          legacyPat: false,
          installation: {
            installationId: 2,
            accountLogin: "second-account",
            accountType: "User",
            repositorySelection: "selected",
            repositories: ["second/repository"],
            permissions: { contents: "read" },
          },
        },
      }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", fetchMock);

  const view = await render(
    <GitHubToolsSection
      botId="first-bot"
      canManageCredentials
      authorizationBlocked={false}
      providers={[]}
      config={DEFAULT_GITHUB_TOOLS}
      onUpdate={vi.fn()}
    />,
  );
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

  await view.rerender(
    <GitHubToolsSection
      botId="second-bot"
      canManageCredentials
      authorizationBlocked={false}
      providers={[]}
      config={DEFAULT_GITHUB_TOOLS}
      onUpdate={vi.fn()}
    />,
  );
  await expect.element(page.getByText("second-account", { exact: true })).toBeVisible();

  resolveFirst(
    new Response(
      JSON.stringify({
        ok: true,
        data: {
          available: true,
          connected: true,
          legacyPat: false,
          installation: {
            installationId: 1,
            accountLogin: "first-account",
            accountType: "User",
            repositorySelection: "selected",
            repositories: ["first/repository"],
            permissions: { contents: "write" },
          },
        },
      }),
      { status: 200 },
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(document.body.textContent).not.toContain("first-account");
  await expect.element(page.getByText("second-account", { exact: true })).toBeVisible();
});

test.each([1440, 390])(
  "shows the Issue confirmation controls in a %s px viewport",
  async (width) => {
    await page.viewport(width, width === 390 ? 844 : 900);
    stubUnavailableGitHubApp();
    const view = await render(
      <GitHubToolsSection
        botId="test-id"
        canManageCredentials
        authorizationBlocked={false}
        providers={[]}
        config={{ ...DEFAULT_GITHUB_TOOLS, enabled: true, createIssueConfirmationTtlMinutes: 60 }}
        onUpdate={vi.fn()}
      />,
    );
    await expect
      .element(page.getByRole("switch", { name: "Create Issue confirmations never expire" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("spinbutton", { name: "Confirmation validity (minutes)" }))
      .toBeVisible();
    const input = document.querySelector<HTMLInputElement>(
      "#githubCreateIssueConfirmationMinutes",
    )!;
    const bounds = input.getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(width);
    await i18n.changeLanguage("zh-CN");
    await view.rerender(
      <GitHubToolsSection
        botId="test-id"
        canManageCredentials
        authorizationBlocked={false}
        providers={[]}
        config={{ ...DEFAULT_GITHUB_TOOLS, enabled: true }}
        onUpdate={vi.fn()}
      />,
    );
    await expect.element(page.getByRole("switch", { name: "创建 Issue 确认不过期" })).toBeVisible();
  },
);
