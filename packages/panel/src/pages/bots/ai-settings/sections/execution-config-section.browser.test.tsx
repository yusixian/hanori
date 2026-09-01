import { i18n } from "@/i18n";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { beforeEach, expect, test, vi } from "vitest";
import { createExecutionConfigDraft, toExecutionConfigUpdate } from "../execution-config";
import { DEFAULT_EXECUTION_CONFIG } from "../types";
import { ExecutionConfigSection } from "./execution-config-section";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

test("shows the defaults and reports concurrency and queue-notice edits", async () => {
  const onUpdate = vi.fn();
  const config = createExecutionConfigDraft(DEFAULT_EXECUTION_CONFIG);

  render(<ExecutionConfigSection config={config} onUpdate={onUpdate} />);

  const concurrency = page.getByRole("spinbutton", { name: "Concurrent AI replies" });
  const queueNotice = page.getByRole("switch", { name: "Queue notice" });
  const waitingMessage = page.getByRole("textbox", { name: "Waiting message" });

  await expect.element(concurrency).toHaveValue(32);
  await expect.element(queueNotice).toBeChecked();
  await expect.element(waitingMessage).toHaveValue(DEFAULT_EXECUTION_CONFIG.queueNotice.text);

  await concurrency.fill("8");
  expect(onUpdate).toHaveBeenLastCalledWith({ ...config, maxConcurrentReplies: 8 });

  await queueNotice.click();
  expect(onUpdate).toHaveBeenLastCalledWith({
    ...config,
    queueNotice: { ...config.queueNotice, enabled: false },
  });
});

test("shows actionable errors for invalid execution settings", async () => {
  render(
    <ExecutionConfigSection
      config={{
        maxConcurrentReplies: 0,
        queueNotice: { enabled: true, text: "   " },
      }}
      onUpdate={vi.fn()}
    />,
  );

  await expect.element(page.getByText("Enter a whole number from 1 to 128.")).toBeVisible();
  await expect
    .element(page.getByText("Enter a waiting message while queue notices are enabled."))
    .toBeVisible();
  await expect
    .element(page.getByRole("spinbutton", { name: "Concurrent AI replies" }))
    .toHaveAttribute("aria-invalid", "true");
  await expect
    .element(page.getByRole("textbox", { name: "Waiting message" }))
    .toHaveAttribute("aria-invalid", "true");
});

test("normalizes valid drafts and rejects values outside the saved contract", () => {
  expect(
    toExecutionConfigUpdate({
      maxConcurrentReplies: 6,
      queueNotice: { enabled: true, text: "  Please wait  " },
    }),
  ).toEqual({
    maxConcurrentReplies: 6,
    queueNotice: { enabled: true, text: "Please wait" },
  });

  expect(
    toExecutionConfigUpdate({
      maxConcurrentReplies: 2.5,
      queueNotice: { enabled: true, text: "Ready" },
    }),
  ).toBeNull();
  expect(
    toExecutionConfigUpdate({
      maxConcurrentReplies: 4,
      queueNotice: { enabled: false, text: "   " },
    }),
  ).toEqual({
    maxConcurrentReplies: 4,
    queueNotice: { enabled: false, text: "" },
  });
  expect(
    toExecutionConfigUpdate({
      maxConcurrentReplies: 4,
      queueNotice: { enabled: true, text: "x".repeat(201) },
    }),
  ).toBeNull();
});
