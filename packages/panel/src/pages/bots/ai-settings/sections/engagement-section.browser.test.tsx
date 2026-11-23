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

test("defaults off and natural; exposes routed thresholds and explicit preference examples", async () => {
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
  await expect
    .element(page.getByRole("textbox", { name: "Additional preferences" }))
    .toHaveValue("");
  await expect.element(page.getByRole("combobox", { name: "Preference example" })).toHaveValue("");
  await page.getByRole("combobox", { name: "Run mode" }).selectOptions("active");
  await expect.element(page.getByText(/Private chats, mentions, and replies/)).toBeVisible();
  await page.getByRole("combobox", { name: "Preference example" }).selectOptions("active");
  await expect.element(page.getByText("Preview: Active group member")).toBeVisible();
  await expect
    .element(page.getByRole("textbox", { name: "Additional preferences" }))
    .toHaveValue("");
  await page.getByRole("button", { name: "Use this example" }).click();
  expect(
    (page.getByRole("textbox", { name: "Additional preferences" }).element() as HTMLTextAreaElement)
      .value,
  ).toContain("Join everyday complaints");
  await page.getByRole("textbox", { name: "Additional preferences" }).fill("Anime jokes welcome");
  expect(
    (page.getByRole("textbox", { name: "Additional preferences" }).element() as HTMLTextAreaElement)
      .value,
  ).toBe("Anime jokes welcome");
  await page.getByRole("combobox", { name: "Preference example" }).selectOptions("restrained");
  await expect.element(page.getByText("Preview: Restrained helper")).toBeVisible();
  expect(
    (page.getByRole("textbox", { name: "Additional preferences" }).element() as HTMLTextAreaElement)
      .value,
  ).toBe("Anime jokes welcome");
  await page.getByRole("button", { name: "Replace existing preferences" }).click();
  expect(
    (page.getByRole("textbox", { name: "Additional preferences" }).element() as HTMLTextAreaElement)
      .value,
  ).toContain("Prefer concrete questions");
  await expect
    .element(page.getByRole("switch", { name: "Reply directly to trigger words" }))
    .not.toBeChecked();
  await page.getByRole("switch", { name: "Reply directly to trigger words" }).click();
  await expect
    .element(page.getByRole("switch", { name: "Reply directly to trigger words" }))
    .toBeChecked();

  await page.getByText("Advanced settings", { exact: true }).click();
  await page.getByRole("spinbutton", { name: "Reply confidence threshold" }).fill("0.35");
  await page.getByRole("spinbutton", { name: "Direct address confidence threshold" }).fill("0.65");
  await page.getByRole("spinbutton", { name: "Continuation confidence threshold" }).fill("0.7");
  await page.getByRole("spinbutton", { name: "Continuation window (seconds)" }).fill("90");
  await expect
    .element(page.getByRole("spinbutton", { name: "Reply confidence threshold" }))
    .toHaveValue(0.35);
  await expect
    .element(page.getByRole("spinbutton", { name: "Direct address confidence threshold" }))
    .toHaveValue(0.65);
  await expect
    .element(page.getByRole("spinbutton", { name: "Continuation confidence threshold" }))
    .toHaveValue(0.7);
  await expect
    .element(page.getByRole("spinbutton", { name: "Continuation window (seconds)" }))
    .toHaveValue(90);
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
  await page.getByText("Advanced settings", { exact: true }).click();
  const style = page.getByRole("combobox", { name: "Conversation style" });
  await expect.element(style).toHaveValue("assistant");
  await expect.element(style).toBeDisabled();
  const addressedThreshold = page.getByRole("spinbutton", {
    name: "Direct address confidence threshold",
  });
  await expect.element(addressedThreshold).toHaveValue(0.8);
  await expect.element(addressedThreshold).toBeDisabled();
  await page.getByRole("checkbox", { name: "Customize engagement for this group" }).click();
  await expect.element(style).toBeEnabled();
  await expect.element(addressedThreshold).toBeEnabled();
  await addressedThreshold.fill("0.65");
  await expect.element(addressedThreshold).toHaveValue(0.65);
  await style.selectOptions("filter");
  await expect.element(style).toHaveValue("filter");
  await page.getByRole("checkbox", { name: "Customize engagement for this group" }).click();
  await expect.element(style).toHaveValue("assistant");
  await expect.element(style).toBeDisabled();
  await expect.element(addressedThreshold).toHaveValue(0.8);
  await expect.element(addressedThreshold).toBeDisabled();
});
