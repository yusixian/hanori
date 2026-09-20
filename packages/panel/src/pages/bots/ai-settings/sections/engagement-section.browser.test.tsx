import { useState } from "react";
import { i18n } from "@/i18n";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { beforeEach, expect, test, vi } from "vitest";
import {
  DEFAULT_ENGAGEMENT_POLICY,
  type AiGroupOverride,
  type EngagementConfigPublic,
} from "@cos-tool-bot/shared";
import { EngagementSection } from "./engagement-section";
import { GroupOverrideRow } from "../components/group-override-row";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

test("defaults off and natural; exposes preferences, key and explicit-request guarantee", async () => {
  function Form() {
    const [config, setConfig] = useState<EngagementConfigPublic>();
    const [key, setKey] = useState("");
    return (
      <EngagementSection
        config={config}
        onChange={setConfig}
        apiKey={key}
        onApiKeyChange={setKey}
      />
    );
  }
  render(<Form />);
  await expect.element(page.getByRole("combobox", { name: "Run mode" })).toHaveValue("off");
  await expect
    .element(page.getByRole("combobox", { name: "Conversation style" }))
    .toHaveValue("natural");
  await page.getByRole("combobox", { name: "Run mode" }).selectOptions("active");
  await expect.element(page.getByText(/Private messages, explicit mentions/)).toBeVisible();
  await page.getByRole("textbox", { name: "Additional preferences" }).fill("Anime jokes welcome");
  await expect
    .element(page.getByRole("textbox", { name: "Additional preferences" }))
    .toHaveValue("Anime jokes welcome");
  await expect
    .element(page.getByRole("switch", { name: "Reply directly to trigger words" }))
    .not.toBeChecked();
  await page.getByRole("switch", { name: "Reply directly to trigger words" }).click();
  await expect
    .element(page.getByRole("switch", { name: "Reply directly to trigger words" }))
    .toBeChecked();
});

test("group shows effective defaults and can customize then restore inheritance", async () => {
  function Form() {
    const [override, setOverride] = useState<AiGroupOverride>({ chatId: -1, whitelisted: true });
    return (
      <GroupOverrideRow
        groupKey="-1"
        override={override}
        engagement={{ ...DEFAULT_ENGAGEMENT_POLICY, style: "assistant", cooldownSeconds: 90 }}
        onUpdate={(updates) => setOverride((previous) => ({ ...previous, ...updates }))}
        onRemove={vi.fn()}
      />
    );
  }
  render(<Form />);
  await page.getByRole("button", { name: /expand/i }).click();
  const style = page.getByRole("combobox", { name: "Conversation style" });
  await expect.element(style).toHaveValue("assistant");
  await expect.element(style).toBeDisabled();
  await page.getByRole("checkbox", { name: "Customize engagement for this group" }).click();
  await expect.element(style).toBeEnabled();
  await style.selectOptions("filter");
  await expect.element(style).toHaveValue("filter");
  await page.getByRole("checkbox", { name: "Customize engagement for this group" }).click();
  await expect.element(style).toHaveValue("assistant");
  await expect.element(style).toBeDisabled();
});
