import { i18n } from "@/i18n";
import "@/style.css";
import { useState } from "react";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { beforeEach, expect, test, vi } from "vitest";
import type {
  AiGroupOverride,
  AiProviderEntryPublic,
  ModelRecoveryConfig,
} from "@cos-tool-bot/shared";
import { ModelRecoveryFields } from "./model-recovery-fields";
import { GroupOverrideRow } from "./group-override-row";

const providers: AiProviderEntryPublic[] = [
  {
    id: "fallback-provider",
    label: "Example Provider",
    baseURL: "https://example.invalid/v1",
    providerFormat: "openai",
    hasApiKey: true,
    defaultModel: "example-model",
    models: [{ id: "example-model" }],
  },
];
const configured: ModelRecoveryConfig = {
  maxRetries: 1,
  fallback: { providerId: "fallback-provider", modelId: "example-model" },
};
beforeEach(async () => {
  await i18n.changeLanguage("en");
  await page.viewport(1440, 900);
});
function Fields() {
  const [value, setValue] = useState<ModelRecoveryConfig>({ maxRetries: 1, fallback: null });
  return (
    <>
      <ModelRecoveryFields value={value} providers={providers} onChange={setValue} />
      <output>{JSON.stringify(value)}</output>
    </>
  );
}
test("fallback requires an explicit provider and catalog model", async () => {
  render(<Fields />);
  await expect.element(page.getByText("No fallback set.", { exact: false })).toBeVisible();
  await page.getByRole("checkbox", { name: "Use a fallback model" }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Choose an available provider");
  await page.getByRole("combobox", { name: "Fallback provider" }).click();
  await page.getByRole("option", { name: "Example Provider" }).click();
  await page.getByRole("combobox", { name: "Fallback model", exact: true }).click();
  await page.getByRole("option", { name: "example-model", exact: true }).click();
  await expect.element(page.getByRole("status")).toHaveTextContent('"modelId":"example-model"');
  await page.getByRole("checkbox", { name: "Use a fallback model" }).click();
  await expect.element(page.getByRole("status")).toHaveTextContent('"fallback":null');
});
test("same primary pair is explained without silently selecting another model", async () => {
  render(
    <ModelRecoveryFields
      value={configured}
      providers={providers}
      primary={configured.fallback!}
      onChange={vi.fn()}
    />,
  );
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("won't act as a separate fallback");
});
test.each([1440, 390])(
  "a chat can explicitly disable fallback and return to global inheritance on %dpx",
  async (width) => {
    await page.viewport(width, width === 390 ? 844 : 900);
    const changed = vi.fn();
    function Chat() {
      const [override, setOverride] = useState<AiGroupOverride>({
        chatId: -100,
        whitelisted: true,
        chatTitle: "Example chat",
      });
      return (
        <GroupOverrideRow
          groupKey="-100"
          override={override}
          modelRecovery={configured}
          providers={providers}
          onUpdate={(patch) => {
            changed(patch);
            setOverride({ ...override, ...patch });
          }}
          onRemove={vi.fn()}
        />
      );
    }
    render(<Chat />);
    await page.getByRole("button", { name: "Expand group settings" }).click();
    await expect
      .element(page.getByRole("checkbox", { name: "Use a fallback model" }))
      .toBeDisabled();
    await page.getByRole("checkbox", { name: "Customize recovery for this chat" }).click();
    await page.getByRole("checkbox", { name: "Use a fallback model" }).click();
    await page
      .getByRole("checkbox", { name: "Customize recovery for this chat" })
      .element()
      .scrollIntoView({ block: "center" });
    if (import.meta.env.VITE_RECOVERY_SCREENSHOTS)
      await page
        .elementLocator(
          page.getByText("Retries and fallback", { exact: true }).element().parentElement!,
        )
        .screenshot({ path: `/tmp/recovery-208-chat-${width}.png` });
    expect(changed).toHaveBeenLastCalledWith({ modelRecovery: { maxRetries: 1, fallback: null } });
    await page.getByRole("checkbox", { name: "Customize recovery for this chat" }).click();
    expect(changed).toHaveBeenLastCalledWith({ modelRecovery: undefined });
  },
);
