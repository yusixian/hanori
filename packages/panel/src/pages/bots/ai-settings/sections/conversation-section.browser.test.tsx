import { i18n } from "@/i18n";
import { DEFAULT_CONVERSATION_CONFIG, type AiProviderEntryPublic } from "@cos-tool-bot/shared";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { beforeEach, expect, test, vi } from "vitest";
import { ConversationSection } from "./conversation-section";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

const providers: AiProviderEntryPublic[] = [
  {
    id: "chat-provider",
    label: "Chat Provider",
    hasApiKey: true,
    baseURL: "https://chat.example/v1",
    providerFormat: "openai",
    defaultModel: "chat-model",
  },
  {
    id: "summary-provider",
    label: "Summary Provider",
    hasApiKey: true,
    baseURL: "https://summary.example/v1",
    providerFormat: "openai",
    defaultModel: "summary-model",
  },
];

test("selects an optional dedicated Provider for conversation compression", async () => {
  const onUpdate = vi.fn();
  render(
    <ConversationSection
      config={DEFAULT_CONVERSATION_CONFIG}
      providers={providers}
      activeProviderId="chat-provider"
      onUpdate={onUpdate}
    />,
  );

  await expect
    .element(page.getByRole("combobox", { name: "Compression Provider" }))
    .toHaveTextContent("Follow active Provider (Chat Provider)");

  await page.getByRole("combobox", { name: "Compression Provider" }).click();
  await page.getByRole("option", { name: "Summary Provider (summary-model)" }).click();

  expect(onUpdate).toHaveBeenCalledWith({ compressionProviderId: "summary-provider" });
});

test("bounds the context inputs by the shared settings and keeps the coarse token step", async () => {
  render(
    <ConversationSection
      config={DEFAULT_CONVERSATION_CONFIG}
      providers={providers}
      activeProviderId="chat-provider"
      onUpdate={vi.fn()}
    />,
  );

  const maxContext = page.getByRole("spinbutton").nth(0);
  const historyBudget = page.getByRole("spinbutton").nth(1);
  await expect.element(maxContext).toHaveAttribute("max", "100");
  await expect.element(maxContext).toHaveAttribute("step", "1");
  await expect.element(historyBudget).toHaveAttribute("max", "64000");
  await expect.element(historyBudget).toHaveAttribute("step", "1000");
});
