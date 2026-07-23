import { i18n } from "@/i18n";
import type { AiProviderEntryPublic } from "@cos-tool-bot/shared";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { beforeEach, expect, test, vi } from "vitest";
import { ProvidersSection } from "./providers-section";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

const providers: AiProviderEntryPublic[] = [
  {
    id: "default-provider",
    label: "Default Provider",
    hasApiKey: true,
    baseURL: "https://default.example/v1",
    providerFormat: "openai",
    defaultModel: "default-model",
    modelDiscoveryPath: "/models",
  },
  {
    id: "managed-provider",
    label: "Managed Provider",
    hasApiKey: true,
    baseURL: "https://managed.example/v1",
    providerFormat: "openai",
    defaultModel: "",
    modelDiscoveryPath: "/catalog",
  },
];

test("keeps the managed provider independent from the runtime default", async () => {
  const onActiveProviderChange = vi.fn();
  const onManagedProviderChange = vi.fn();

  render(
    <ProvidersSection
      providers={providers}
      activeProviderId="default-provider"
      managedProviderId="managed-provider"
      draftApiKeys={{}}
      onProvidersChange={vi.fn()}
      onActiveProviderChange={onActiveProviderChange}
      onManagedProviderChange={onManagedProviderChange}
      onDraftApiKeyChange={vi.fn()}
    />,
  );

  await expect.element(page.getByText("Default", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Managing", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("textbox", { name: "Model discovery path" }))
    .toHaveValue("/catalog");

  await page.getByRole("button", { name: "Set as default" }).click();
  expect(onActiveProviderChange).toHaveBeenCalledWith("managed-provider");
  expect(onManagedProviderChange).not.toHaveBeenCalled();

  await page.getByRole("button", { name: /Default Provider/ }).click();
  expect(onManagedProviderChange).toHaveBeenCalledWith("default-provider");
});

test("allows a provider draft without a default model and gives Gemini no discovery path", async () => {
  const onProvidersChange = vi.fn();

  render(
    <ProvidersSection
      providers={[]}
      draftApiKeys={{}}
      onProvidersChange={onProvidersChange}
      onActiveProviderChange={vi.fn()}
      onManagedProviderChange={vi.fn()}
      onDraftApiKeyChange={vi.fn()}
    />,
  );

  await page.getByRole("button", { name: "Add Provider" }).click();
  await page.getByPlaceholder("OpenAI", { exact: true }).fill("Gemini");
  await page
    .getByPlaceholder("https://api.openai.com/v1/")
    .fill("https://generativelanguage.googleapis.com");
  await page.getByRole("combobox", { name: "Provider Format" }).click();
  await page.getByRole("option", { name: "Gemini Native" }).click();

  await expect.element(page.getByLabelText("Model discovery path")).toHaveValue("");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  expect(onProvidersChange).toHaveBeenCalledWith([
    expect.objectContaining({
      label: "Gemini",
      providerFormat: "gemini",
      defaultModel: "",
      modelDiscoveryPath: "",
      models: [],
    }),
  ]);
});

test("preserves a customized discovery path when switching provider formats", async () => {
  const onProvidersChange = vi.fn();
  const customizedProviders: AiProviderEntryPublic[] = [
    {
      ...providers[0]!,
      modelDiscoveryPath: "/custom/catalog",
    },
  ];

  render(
    <ProvidersSection
      providers={customizedProviders}
      activeProviderId="default-provider"
      managedProviderId="default-provider"
      draftApiKeys={{}}
      onProvidersChange={onProvidersChange}
      onActiveProviderChange={vi.fn()}
      onManagedProviderChange={vi.fn()}
      onDraftApiKeyChange={vi.fn()}
    />,
  );

  await page.getByRole("combobox", { name: "Provider Format" }).click();
  await page.getByRole("option", { name: "Gemini Native" }).click();

  expect(onProvidersChange).toHaveBeenCalledWith([
    expect.objectContaining({
      providerFormat: "gemini",
      modelDiscoveryPath: "/custom/catalog",
    }),
  ]);
});
