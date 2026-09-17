import { i18n } from "@/i18n";
import type { ModelEntry } from "@cos-tool-bot/shared";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ModelsSection } from "./models-section";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderModels(overrides: Partial<Parameters<typeof ModelsSection>[0]> = {}) {
  const props: Parameters<typeof ModelsSection>[0] = {
    botId: "bot-id",
    models: [],
    activeModel: "",
    modelCommandAccess: "admin",
    providerId: "provider-id",
    providerLabel: "Provider One",
    baseURL: "https://provider.example/v1",
    apiKey: "draft-key",
    modelDiscoveryPath: "/models",
    onModelsChange: vi.fn(),
    onActiveModelChange: vi.fn(),
    onModelRename: vi.fn(),
    onModelCommandAccessChange: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
  return { props, view: await render(<ModelsSection {...props} />) };
}

test("adds comma and newline separated model IDs and makes the first model default", async () => {
  const onModelsChange = vi.fn();
  const onActiveModelChange = vi.fn();
  await renderModels({ onModelsChange, onActiveModelChange });

  await page
    .getByRole("textbox", { name: "Model IDs to add" })
    .fill("gpt-4.1, gpt-4.1\n  Claude-3  \n");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  expect(onModelsChange).toHaveBeenCalledWith([{ id: "gpt-4.1" }, { id: "Claude-3" }]);
  expect(onActiveModelChange).toHaveBeenCalledWith("gpt-4.1");
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Added 2 model(s); skipped 1 duplicate(s).");
});

test("blocks removing the default model and rejects a conflicting rename", async () => {
  const models: ModelEntry[] = [{ id: "model-a" }, { id: "model-b" }];
  const onModelsChange = vi.fn();
  const onModelRename = vi.fn();
  const onError = vi.fn();
  await renderModels({
    models,
    activeModel: "model-a",
    onModelsChange,
    onModelRename,
    onError,
  });

  await page.getByRole("button", { name: "Remove model-a" }).click();
  expect(onError).toHaveBeenCalledWith("Choose another default model before removing this one.");
  expect(onModelsChange).not.toHaveBeenCalled();

  await page.getByRole("button", { name: "Configure model-a" }).click();
  await page.getByRole("textbox", { name: "Model ID", exact: true }).fill("model-b");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect(onError).toHaveBeenLastCalledWith(
    "A model with ID “model-b” already exists for this provider.",
  );
  expect(onModelRename).not.toHaveBeenCalled();
});

test("reports the all-users command access selection to the settings form", async () => {
  const onModelCommandAccessChange = vi.fn();
  await renderModels({ onModelCommandAccessChange });

  await page.getByText("All Users", { exact: true }).click();

  expect(onModelCommandAccessChange).toHaveBeenCalledWith("all");
});

test("fetches for the explicit target and tolerates a missing owner", async () => {
  const fetchMock = vi.fn<typeof fetch>(
    async (_input, _init) =>
      new Response(
        JSON.stringify({
          ok: true,
          data: [{ id: "ownerless-model", capabilities: [] }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
  await renderModels();

  await page.getByRole("button", { name: "Fetch Models" }).click();
  await expect.element(page.getByText("ownerless-model")).toBeVisible();

  const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
  expect(JSON.parse(String(requestInit.body))).toMatchObject({
    providerId: "provider-id",
    baseURL: "https://provider.example/v1",
    apiKey: "draft-key",
    modelDiscoveryPath: "/models",
  });
});

test("ignores stale fetch results after switching the managed provider", async () => {
  let resolveFetch!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    ),
  );
  const { props, view } = await renderModels();

  await page.getByRole("button", { name: "Fetch Models" }).click();
  await view.rerender(
    <ModelsSection {...props} providerId="other-provider" providerLabel="Provider Two" />,
  );
  resolveFetch(
    new Response(
      JSON.stringify({
        ok: true,
        data: [{ id: "stale-model", capabilities: [] }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );

  await expect.element(page.getByText("Models for Provider Two")).toBeVisible();
  expect(document.body.textContent).not.toContain("stale-model");
});

test("ignores stale fetch results after navigating to another bot", async () => {
  let resolveFetch!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    ),
  );
  const { props, view } = await renderModels();

  await page.getByRole("button", { name: "Fetch Models" }).click();
  await view.rerender(<ModelsSection {...props} botId="other-bot" />);
  resolveFetch(
    new Response(
      JSON.stringify({
        ok: true,
        data: [{ id: "previous-bot-model", capabilities: [] }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );

  expect(document.body.textContent).not.toContain("previous-bot-model");
});

test("clears fetched results when the managed provider connection changes", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            data: [{ id: "old-connection-model", capabilities: [] }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ),
  );
  const { props, view } = await renderModels();

  await page.getByRole("button", { name: "Fetch Models" }).click();
  await expect.element(page.getByText("old-connection-model")).toBeVisible();
  await view.rerender(<ModelsSection {...props} baseURL="https://other.example/v1" />);

  expect(document.body.textContent).not.toContain("old-connection-model");
});

test("clears a manual model draft when switching the managed provider", async () => {
  const { props, view } = await renderModels();
  const input = page.getByRole("textbox", { name: "Model IDs to add" });

  await input.fill("draft-model");
  await view.rerender(
    <ModelsSection {...props} providerId="other-provider" providerLabel="Provider Two" />,
  );

  await expect.element(input).toHaveValue("");
});

test("de-duplicates fetched models before importing them", async () => {
  const onModelsChange = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            data: [
              { id: "duplicate-model", capabilities: [] },
              { id: "duplicate-model", capabilities: ["vision"] },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ),
  );
  await renderModels({ onModelsChange });

  await page.getByRole("button", { name: "Fetch Models" }).click();
  await page.getByText("duplicate-model").click();
  await page.getByRole("button", { name: "Add selected (1)" }).click();

  expect(onModelsChange).toHaveBeenCalledWith([{ id: "duplicate-model", capabilities: [] }]);
});

test("formats structured validation errors instead of showing an object placeholder", async () => {
  const onError = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: {
              issues: [
                {
                  path: ["modelDiscoveryPath"],
                  message: "Must begin with a single slash",
                },
              ],
            },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
    ),
  );
  await renderModels({ onError });

  await page.getByRole("button", { name: "Fetch Models" }).click();

  expect(onError).toHaveBeenCalledWith("modelDiscoveryPath: Must begin with a single slash");
});
