import { i18n } from "@/i18n";
import { useState } from "react";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { beforeEach, expect, test, vi } from "vitest";
import type { GlobalAiSelection } from "../types";
import {
  GlobalAiSelectionSection,
  type GlobalAiSelectionDraft,
} from "./global-ai-selection-section";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

const selection: GlobalAiSelection = {
  revision: "revision-1",
  applyState: "pending",
  displayDefault: "show",
  selection: {
    providerId: "provider-a",
    modelId: "model-a",
    providerLabel: "Provider A",
    modelLabel: "Model A",
  },
  options: [
    {
      id: "provider-a",
      label: "Provider A",
      defaultModelId: "model-a",
      models: [{ id: "model-a", label: "Model A" }],
    },
    {
      id: "provider-b",
      label: "Provider B",
      defaultModelId: "model-b-default",
      models: [
        { id: "model-b-default", label: "Model B Default" },
        { id: "model-b-fast", label: "Model B Fast" },
      ],
    },
  ],
};

test("edits the live pair separately and exposes retry for pending state", async () => {
  const onSave = vi.fn();
  const onRetry = vi.fn();
  let latestDraft: GlobalAiSelectionDraft | undefined;

  function Harness() {
    const [draft, setDraft] = useState<GlobalAiSelectionDraft>({
      providerId: selection.selection.providerId,
      modelId: selection.selection.modelId,
      displayDefault: selection.displayDefault,
    });
    latestDraft = draft;
    return (
      <GlobalAiSelectionSection
        selection={selection}
        draft={draft}
        canManage
        saving={false}
        retrying={false}
        onChange={setDraft}
        onSave={onSave}
        onRetry={onRetry}
      />
    );
  }

  render(<Harness />);

  await expect.element(page.getByText("Saved · waiting for runtime")).toBeVisible();
  await page.getByRole("combobox", { name: "Live reply Provider" }).click();
  await page.getByRole("option", { name: "Provider B" }).click();
  expect(latestDraft).toMatchObject({
    providerId: "provider-b",
    modelId: "model-b-default",
  });

  await page.getByRole("button", { name: "Apply selection" }).click();
  await page.getByRole("button", { name: "Retry sync" }).click();
  expect(onSave).toHaveBeenCalledOnce();
  expect(onRetry).toHaveBeenCalledOnce();
});

test("keeps selection controls read-only for non-admin members", async () => {
  render(
    <GlobalAiSelectionSection
      selection={{ ...selection, applyState: "applied" }}
      draft={{
        providerId: selection.selection.providerId,
        modelId: selection.selection.modelId,
        displayDefault: selection.displayDefault,
      }}
      canManage={false}
      saving={false}
      retrying={false}
      onChange={vi.fn()}
      onSave={vi.fn()}
      onRetry={vi.fn()}
    />,
  );

  await expect
    .element(page.getByText("Only workspace owners and admins can change the live selection."))
    .toBeVisible();
  await expect.element(page.getByRole("combobox", { name: "Live reply Provider" })).toBeDisabled();
  await expect
    .element(page.getByRole("button", { name: "Apply selection" }))
    .not.toBeInTheDocument();
});
