import { i18n } from "@/i18n";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { beforeEach, expect, test, vi } from "vitest";
import { MessageSplittingSection } from "./message-splitting-section";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

test("defaults Rich Messages on and exposes the global setting", async () => {
  const onUpdate = vi.fn();
  render(
    <MessageSplittingSection
      config={{ replyMode: "segment", autoSplitThreshold: 0, splitDelayMs: 800 }}
      platform="telegram"
      onUpdate={onUpdate}
    />,
  );

  const toggle = page.getByRole("switch", { name: "Telegram Native Rich Messages" });
  await expect.element(toggle).toBeChecked();
  await toggle.click();

  expect(onUpdate).toHaveBeenCalledWith({ richMessageEnabled: false });
  await expect.element(page.getByText(/\/richtext on\|off/)).toBeVisible();
});

test("hides Telegram Rich Messages while the platform is unavailable", async () => {
  render(
    <MessageSplittingSection
      config={{ replyMode: "stream", autoSplitThreshold: 0, splitDelayMs: 800 }}
      platform={undefined}
      onUpdate={vi.fn()}
    />,
  );

  await expect.element(page.getByText("Reply Mode", { exact: true })).toBeVisible();
  expect(document.body.textContent).not.toContain("Telegram Native Rich Messages");
});
