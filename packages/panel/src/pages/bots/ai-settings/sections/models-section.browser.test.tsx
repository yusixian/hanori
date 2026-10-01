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
    models: [],
    activeModel: "",
    modelCommandAccess: "admin",
    providerLabel: "Provider One",
    canFetch: true,
    fetchingModels: false,
    onRefresh: vi.fn(),
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

test("refreshes immediately and disables discovery for incomplete providers", async () => {
  const { props, view } = await renderModels();
  await page.getByRole("button", { name: "Refresh Models" }).click();
  expect(props.onRefresh).toHaveBeenCalledOnce();
  await view.rerender(<ModelsSection {...props} canFetch={false} />);
  await expect.element(page.getByRole("button", { name: "Refresh Models" })).toBeDisabled();
});

test("filters the configured catalog by ID, label and capability", async () => {
  await renderModels({
    models: [
      { id: "alpha", label: "Favorite", capabilities: ["vision"] },
      { id: "beta", capabilities: ["reasoning"] },
    ],
  });
  const search = page.getByRole("textbox", { name: "Search model IDs, labels, capabilities…" });
  await search.fill("favorite");
  await expect.element(page.getByText("alpha", { exact: true })).toBeVisible();
  await expect.element(page.getByText("beta", { exact: true })).not.toBeInTheDocument();
  await search.fill("reasoning");
  await expect.element(page.getByText("beta", { exact: true })).toBeVisible();
  await search.fill("unknown");
  await expect.element(page.getByText('No models match "unknown"')).toBeVisible();
});
