import { i18n } from "@/i18n";
import { DEFAULT_IMAGE_GENERATION_RECEIPT_CONFIG } from "@cos-tool-bot/shared";
import { beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ImageGenerationReceiptSection } from "./image-generation-receipt-section";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

test("edits Prompt preview and independent receipt notices", async () => {
  const onUpdate = vi.fn();
  render(
    <ImageGenerationReceiptSection
      config={DEFAULT_IMAGE_GENERATION_RECEIPT_CONFIG}
      onUpdate={onUpdate}
    />,
  );

  const previewLength = page.getByRole("spinbutton", { name: "Prompt Preview Length" });
  await expect.element(previewLength).toHaveValue(200);
  await previewLength.fill("0");
  expect(onUpdate).toHaveBeenCalledWith({ promptPreviewLength: 0 });

  const truncationSwitch = page.getByRole("switch", { name: "Prompt truncation notice" });
  const albumSwitch = page.getByRole("switch", { name: "Album task-details notice" });
  await expect.element(truncationSwitch).toBeChecked();
  await expect.element(albumSwitch).toBeChecked();
  await truncationSwitch.click();
  await albumSwitch.click();

  expect(onUpdate).toHaveBeenCalledWith({ truncationNoticeEnabled: false });
  expect(onUpdate).toHaveBeenCalledWith({ albumNoticeEnabled: false });

  const truncationText = page.getByRole("textbox", { name: "Prompt truncation notice text" });
  const albumText = page.getByRole("textbox", { name: "Album task-details notice text" });
  await expect.element(truncationText).toHaveAttribute("maxlength", "200");
  await expect.element(albumText).toHaveAttribute("maxlength", "200");
});
