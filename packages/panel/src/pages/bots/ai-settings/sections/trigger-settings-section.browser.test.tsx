import { i18n } from "@/i18n";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { beforeEach, expect, test, vi } from "vitest";
import { TriggerSettingsSection } from "./trigger-settings-section";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

test("keeps a decimal random reply percentage browser-valid and bounds the cooldown", async () => {
  render(
    <TriggerSettingsSection
      config={{
        replyToBot: true,
        mentionBot: true,
        triggerWords: [],
        randomReplyPercent: 0.5,
        randomReplyCooldown: 60,
      }}
      triggerWordsText=""
      onTriggerWordsTextChange={vi.fn()}
      onUpdate={vi.fn()}
    />,
  );

  const percent = page.getByRole("spinbutton").nth(0);
  const cooldown = page.getByRole("spinbutton").nth(1);
  await expect.element(percent).toHaveAttribute("step", "any");
  expect((percent.element() as HTMLInputElement).validity.valid).toBe(true);
  await expect.element(cooldown).toHaveAttribute("step", "1");
  await expect.element(cooldown).toHaveAttribute("max", "86400");
});
