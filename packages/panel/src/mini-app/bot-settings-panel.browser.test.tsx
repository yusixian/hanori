import { i18n } from "@/i18n";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BotSettingsPage } from "./bot-settings-panel";
import type { MiniAppSessionView } from "./session";
import "./i18n";

const BOT_ID = "00000000-0000-4000-8000-000000000001";
const SESSION: MiniAppSessionView = {
  user: { id: 42 },
  role: "admin",
  capabilities: [],
  chatScope: { kind: "all" },
  expiresAt: 1_800_000_900,
  csrfToken: "csrf-token",
};
const GLOBAL_SELECTION = {
  revision: "selection-1",
  applyState: "applied",
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
  ],
};

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function getResponse(url: string) {
  if (url.endsWith("/lifecycle")) {
    return Response.json({
      ok: true,
      lifecycle: { desiredActive: true, runtimeStatus: "running", reconciled: true },
    });
  }
  if (url.endsWith("/settings")) {
    return Response.json({
      ok: true,
      settings: { revision: "settings-1", ai: { enabled: true, systemPrompt: "Be kind." } },
    });
  }
  return Response.json({ ok: true, global: GLOBAL_SELECTION });
}

test("puts compact high-priority controls first", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input) => getResponse(String(input))),
  );

  render(<BotSettingsPage botId={BOT_ID} session={SESSION} />);
  await expect.element(page.getByRole("heading", { name: "Bot settings" })).toBeVisible();
  await expect.element(page.getByRole("heading", { name: "Runtime" })).toBeVisible();
  await expect.element(page.getByRole("heading", { name: "Provider & model" })).toBeVisible();
  await expect.element(page.getByRole("heading", { name: "Common AI settings" })).toBeVisible();

  const text = document.body.textContent ?? "";
  expect(text.indexOf("Runtime")).toBeLessThan(text.indexOf("Provider & model"));
  expect(text.indexOf("Provider & model")).toBeLessThan(text.indexOf("Common AI settings"));
  expect(text).not.toContain("Manage durable lifecycle state");
  expect(text).not.toContain("Provider and model are validated");
});

test("confirms disable and sends the Admin CSRF token", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const confirm = vi.fn(() => true);
  vi.stubGlobal("confirm", confirm);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/lifecycle/disable")) {
        return Response.json({
          ok: true,
          lifecycle: {
            desiredActive: false,
            runtimeStatus: "stopped",
            reconciled: true,
            persisted: true,
            applied: true,
          },
        });
      }
      if (url.endsWith("/lifecycle/enable")) {
        return Response.json({
          ok: true,
          lifecycle: {
            desiredActive: true,
            runtimeStatus: "running",
            reconciled: true,
            persisted: true,
            applied: true,
          },
        });
      }
      return getResponse(url);
    }),
  );

  render(<BotSettingsPage botId={BOT_ID} session={SESSION} />);
  await page.getByRole("button", { name: "Disable Bot" }).click();
  await expect.element(page.getByText("Bot disabled and stopped.")).toBeVisible();
  expect(confirm).toHaveBeenCalledOnce();
  expect(calls).toContainEqual({
    url: `/api/mini-app/${BOT_ID}/lifecycle/disable`,
    init: {
      method: "POST",
      credentials: "same-origin",
      headers: { "x-mini-app-csrf": "csrf-token" },
    },
  });
  await page.getByRole("button", { name: "Enable Bot" }).click();
  await expect.element(page.getByText("Bot enabled and running.")).toBeVisible();
  expect(confirm).toHaveBeenCalledOnce();
});

test("saves AI enabled and System Prompt as one revision-checked mutation", async () => {
  let mutation: { url: string; init?: RequestInit } | null = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/settings") && init?.method === "PATCH") {
        mutation = { url, init };
        return Response.json({
          ok: true,
          persisted: true,
          applied: true,
          applyState: "applied",
          settings: {
            revision: "settings-2",
            ai: { enabled: false, systemPrompt: "Be concise." },
          },
        });
      }
      return getResponse(url);
    }),
  );

  render(<BotSettingsPage botId={BOT_ID} session={SESSION} />);
  await expect.element(page.getByRole("heading", { name: "Bot settings" })).toBeVisible();
  await page.getByLabelText("AI replies enabled").click();
  await page.getByLabelText("System prompt").fill("Be concise.");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect.element(page.getByText("Saved and applied.")).toBeVisible();

  expect(mutation).not.toBeNull();
  expect(mutation!.url).toBe(`/api/mini-app/${BOT_ID}/settings`);
  expect(mutation!.init).toMatchObject({
    method: "PATCH",
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-mini-app-csrf": "csrf-token" },
    body: JSON.stringify({
      expectedRevision: "settings-1",
      patch: { enabled: false, systemPrompt: "Be concise." },
    }),
  });
});
