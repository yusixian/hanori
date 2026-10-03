import { i18n } from "@/i18n";
import "@/style.css";
import "./settings.css";
import {
  defaultAsrAccounts,
  type AsrSettingsPublic,
  type AsrSettingsUpdate,
} from "@cos-tool-bot/shared";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { AsrSettingsRequestError } from "./asr-settings-api";
import { AsrSettingsPanel } from "./asr-settings-panel";

const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn() }));
vi.mock("./asr-settings-api", async (original) => ({
  ...(await original<typeof import("./asr-settings-api")>()),
  asrSettingsApi: mocks,
}));
let view: AsrSettingsPublic;
beforeEach(async () => {
  await i18n.changeLanguage("en");
  await page.viewport(1440, 900);
  view = {
    revision: 7,
    accounts: defaultAsrAccounts().map((account) => ({
      ...account,
      configuredSecrets: account.provider === "tencent" ? ["secretId", "secretKey"] : [],
    })),
  };
  mocks.get.mockReset().mockImplementation(async () => structuredClone(view));
  mocks.save.mockReset().mockImplementation(async () => structuredClone({ ...view, revision: 8 }));
});
afterEach(async () => {
  await page.viewport(1440, 900);
  vi.restoreAllMocks();
});

test("starts disabled, shows the standard Tencent engine, and saves without reading stored secrets", async () => {
  await render(<AsrSettingsPanel />);
  await expect.element(page.getByLabelText("Model / engine")).toHaveValue("16k_zh");
  await expect
    .element(page.getByRole("checkbox", { name: "Enable this account" }))
    .not.toBeChecked();
  await expect.element(page.getByLabelText("SecretKey", { exact: true })).toHaveValue("");
  await page.viewport(1440, document.documentElement.scrollHeight);
  window.scrollTo(0, 0);
  await page.screenshot({
    element: document.getElementById("asr-settings")!,
    path: "../../../../.acceptance/asr-settings-desktop.png",
  });
  await page.viewport(1440, 900);
  await expect
    .element(page.getByText("Account balance is unknown.", { exact: false }))
    .toBeVisible();
  await page.getByLabelText("Price per minute (CNY)").fill("0.03");
  await page.getByRole("button", { name: "Save ASR settings", exact: true }).click();
  await expect.element(page.getByRole("status")).toHaveTextContent("Transcription settings saved");
  const input = mocks.save.mock.calls[0]![0] as AsrSettingsUpdate;
  expect(input.revision).toBe(7);
  expect(input.accounts[0]).toMatchObject({ provider: "tencent", costPerMinute: 0.03 });
  expect(input.accounts[0]).not.toHaveProperty("secrets");
  expect(input.accounts[0]).not.toHaveProperty("configuredSecrets");
  expect(input.accounts[0]).not.toHaveProperty("currency");
});

test("explicit secret clearing waits for save and a newly entered secret is cleared from page memory afterwards", async () => {
  await render(<AsrSettingsPanel />);
  await expect.element(page.getByLabelText("SecretKey", { exact: true })).toBeVisible();
  await page.getByLabelText("SecretKey", { exact: true }).fill("synthetic-new-key");
  await page.getByRole("button", { name: "Clear saved secret", exact: true }).nth(0).click();
  expect(mocks.save).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Save ASR settings", exact: true }).click();
  const input = mocks.save.mock.calls[0]![0] as AsrSettingsUpdate;
  expect(input.accounts[0]?.secrets).toEqual({ secretId: null, secretKey: "synthetic-new-key" });
  await expect.element(page.getByLabelText("SecretKey", { exact: true })).toHaveValue("");
});

test("requires the administrator to explicitly select Groq free-plan use and keeps provider edits across switches", async () => {
  await render(<AsrSettingsPanel />);
  await expect.element(page.getByLabelText("Model / engine")).toBeVisible();
  await page.getByLabelText("SecretKey", { exact: true }).fill("synthetic-key");
  await page.getByRole("combobox", { name: "Transcription provider" }).click();
  await page.getByRole("option", { name: "Groq · Whisper", exact: true }).click();
  await expect.element(page.getByLabelText("Model / engine")).toHaveValue("whisper-large-v3-turbo");
  const freePlan = page.getByRole("checkbox", {
    name: /I confirm this key belongs to a Groq Free Plan account/,
  });
  await expect.element(freePlan).not.toBeChecked();
  await freePlan.click();
  await page.getByRole("button", { name: "Save ASR settings", exact: true }).click();
  const input = mocks.save.mock.calls[0]![0] as AsrSettingsUpdate;
  expect(input.accounts.find((account) => account.provider === "tencent")?.secrets?.secretKey).toBe(
    "synthetic-key",
  );
  expect(input.accounts.find((account) => account.provider === "groq")?.freeOnly).toBe(true);
});

test("keeps unsaved inputs on revision conflict and reloads the current saved version", async () => {
  mocks.save.mockRejectedValue(new AsrSettingsRequestError(true));
  await render(<AsrSettingsPanel />);
  await expect.element(page.getByLabelText("SecretKey", { exact: true })).toBeVisible();
  await page.getByLabelText("SecretKey", { exact: true }).fill("synthetic-unsaved-key");
  await page.getByRole("button", { name: "Save ASR settings", exact: true }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Another administrator changed these settings");
  await expect
    .element(page.getByLabelText("SecretKey", { exact: true }))
    .toHaveValue("synthetic-unsaved-key");
  await page.getByRole("button", { name: "Reload saved settings", exact: true }).click();
  await expect.element(page.getByLabelText("SecretKey", { exact: true })).toHaveValue("");
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
});

test("offers retry after load failure without rendering credential fields", async () => {
  mocks.get.mockRejectedValueOnce(new Error("synthetic-error"));
  await render(<AsrSettingsPanel />);
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Transcription settings could not be loaded");
  await expect.element(page.getByLabelText("SecretKey", { exact: true })).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Reload saved settings", exact: true }).click();
  await expect.element(page.getByLabelText("SecretKey", { exact: true })).toBeVisible();
});

test("keeps labeled settings and save controls usable on a narrow screen", async () => {
  await page.viewport(390, 844);
  await render(<AsrSettingsPanel />);
  await expect.element(page.getByLabelText("Model / engine")).toHaveValue("16k_zh");
  await expect
    .element(page.getByRole("button", { name: "Save ASR settings", exact: true }))
    .toBeVisible();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  await page.getByLabelText("Account monthly budget (CNY)").fill("8");
  await page.getByRole("button", { name: "Save ASR settings", exact: true }).click();
  await expect.element(page.getByRole("status")).toHaveTextContent("Transcription settings saved");
  await page.viewport(390, document.documentElement.scrollHeight);
  window.scrollTo(0, 0);
  await page.screenshot({
    element: document.getElementById("asr-settings")!,
    path: "../../../../.acceptance/asr-settings-mobile.png",
  });
});
