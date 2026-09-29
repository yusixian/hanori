import { i18n } from "@/i18n";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { beforeEach, expect, test, vi } from "vitest";
import { GroupOverrideRow } from "./group-override-row";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

test("warns when a group override exceeds the default history budget", async () => {
  render(
    <GroupOverrideRow
      groupKey="-100"
      override={{
        chatId: -100,
        whitelisted: true,
        groupHistoryMaxTokens: 16_000,
      }}
      onUpdate={vi.fn()}
      onRemove={vi.fn()}
    />,
  );

  await page.getByRole("button", { name: "Expand group settings" }).click();

  await expect.element(page.getByText(/This budget exceeds the default/)).toBeVisible();
  const historyBudget = page.getByRole("spinbutton").last();
  await expect.element(historyBudget).toHaveAttribute("min", "2000");
  await expect.element(historyBudget).toHaveAttribute("step", "1000");
});
