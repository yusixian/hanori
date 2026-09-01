import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { i18n } from "@/i18n";
import { BotGovernancePage } from "./governance";

const loadedDraft = {
  timezone: "UTC",
  connection: { status: "connected", scopes: ["mcp:pixai:generate"] },
  generalRouteMode: "semantic_auto",
  privateChatUserIds: [73],
  routes: [
    {
      purpose: "anime_illustration",
      enabled: false,
      label: "Custom anime route",
      useWhen: "custom anime",
      avoidWhen: "custom avoid",
      examples: ["custom request"],
      defaultPresetKey: "custom-preset",
      allowedPresetKeys: ["custom-preset"],
    },
    {
      purpose: "general_image",
      enabled: true,
      label: "Custom general route",
      useWhen: "custom general",
      avoidWhen: "custom avoid",
      examples: [],
      allowedPresetKeys: [],
    },
  ],
  limits: [
    { key: "ai_bot", label: "AI · Bot total", hourly: 1, daily: 2 },
    { key: "ai_chat_user", label: "AI · group user", hourly: 1, daily: 2 },
    { key: "ai_user_global", label: "AI · user across groups", hourly: 1, daily: 2 },
    { key: "ai_chat", label: "AI · group total", hourly: 1, daily: 2 },
    { key: "image_bot", label: "Image · Bot total", hourly: 1, daily: 2 },
    { key: "image_chat_user", label: "Image · group user", hourly: 1, daily: 2 },
    { key: "image_user_global", label: "Image · user across groups", hourly: 1, daily: 2 },
    { key: "image_chat", label: "Image · group total", hourly: 1, daily: 2 },
    { key: "proactive_bot", label: "Proactive replies · Bot", hourly: 1 },
  ],
  overrides: [
    {
      resource: "image",
      scope: "chat_user",
      subjectKey: "-100:42",
      hourly: 1,
      daily: 2,
    },
  ],
};

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("resets the complete governance draft to the raised defaults before saving", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const data =
      init?.method === "PUT"
        ? { ...JSON.parse(String(init.body)), connection: loadedDraft.connection }
        : loadedDraft;
    return new Response(JSON.stringify({ ok: true, data }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/bots/test-id/governance"]}>
      <Routes>
        <Route path="/bots/:botId/governance" element={<BotGovernancePage />} />
      </Routes>
    </MemoryRouter>,
  );

  await expect
    .element(page.getByRole("heading", { name: "Usage & image governance" }))
    .toBeVisible();
  await page.getByRole("button", { name: "Reset to defaults" }).click();

  await expect.element(page.getByRole("status")).toHaveTextContent("Defaults restored");
  await expect.element(page.getByLabelText("Budget timezone")).toHaveValue("Asia/Shanghai");
  await expect.element(page.getByLabelText("General image backend")).toHaveValue("off");
  await expect
    .element(
      page.getByText(
        "No non-admin users are authorized. Private-chat image generation is off by default.",
      ),
    )
    .toBeVisible();
  await expect.element(page.getByLabelText("Image · Bot total hourly")).toHaveValue(500);
  await expect.element(page.getByLabelText("Image · group user cooldownSeconds")).toHaveValue(5);
  await expect.element(page.getByLabelText("Image · group user hourly")).toHaveValue(30);
  await expect.element(page.getByLabelText("Image · group user daily")).toHaveValue(120);
  await expect.element(page.getByLabelText("Image · user across groups daily")).toHaveValue(300);
  await expect.element(page.getByLabelText("Image · group total daily")).toHaveValue(1_000);
  await expect.element(page.getByText("No exact overrides are configured.")).toBeVisible();
  expect(fetchMock).toHaveBeenCalledTimes(1);

  await page.getByRole("button", { name: "Save" }).click();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const request = fetchMock.mock.calls[1]?.[1];
  const body = JSON.parse(String(request?.body)) as typeof loadedDraft;
  expect(body).toMatchObject({
    timezone: "Asia/Shanghai",
    generalRouteMode: "off",
    privateChatUserIds: [],
    overrides: [],
  });
  expect(body.limits.find((limit) => limit.key === "image_bot")).toMatchObject({
    hourly: 500,
    daily: 5_000,
  });
});

test("adds a private-chat image user and includes it in the saved governance config", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const data =
      init?.method === "PUT"
        ? { ...JSON.parse(String(init.body)), connection: loadedDraft.connection }
        : loadedDraft;
    return new Response(JSON.stringify({ ok: true, data }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/bots/test-id/governance"]}>
      <Routes>
        <Route path="/bots/:botId/governance" element={<BotGovernancePage />} />
      </Routes>
    </MemoryRouter>,
  );

  await expect
    .element(page.getByRole("heading", { name: "Private-chat image access" }))
    .toBeVisible();
  await expect.element(page.getByLabelText("Telegram user ID")).toHaveValue(73);
  await page.getByRole("button", { name: "Add user" }).click();
  await page.getByLabelText("Telegram user ID").nth(1).fill("4242");
  await page.getByRole("button", { name: "Save" }).click();

  const request = fetchMock.mock.calls[1]?.[1];
  const body = JSON.parse(String(request?.body)) as typeof loadedDraft;
  expect(body.privateChatUserIds).toEqual([73, 4242]);
});
