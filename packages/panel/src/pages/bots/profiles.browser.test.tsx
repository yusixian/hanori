import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { i18n } from "@/i18n";
import { BotProfilesPage } from "./profiles";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("renders observed Telegram identity details and the protected avatar", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/bots/test-id/profiles/7/avatar")) {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }
    if (url.includes("/api/bots/test-id/profiles")) {
      return new Response(
        JSON.stringify({
          ok: true,
          total: 1,
          data: [
            {
              id: 7,
              telegramId: 42,
              username: "sample",
              displayName: "Ai Chan",
              firstName: "Ai",
              lastName: "Chan",
              languageCode: "zh-hans",
              isPremium: true,
              hasAvatar: true,
              avatarVersion: "avatar-v1",
              notes: null,
              traits: [],
              interests: [],
              relationship: null,
              firstSeen: "2026-07-01T00:00:00.000Z",
              lastSeen: "2026-07-20T00:00:00.000Z",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/bots/test-id/profiles"]}>
      <Routes>
        <Route path="/bots/:botId/profiles" element={<BotProfilesPage />} />
      </Routes>
    </MemoryRouter>,
  );

  await expect.element(page.getByRole("heading", { name: "People profiles" })).toBeVisible();
  await expect.element(page.getByText("Ai Chan")).toBeVisible();
  await expect.element(page.getByText("Language: zh-hans")).toBeVisible();
  await expect.element(page.getByText("Telegram Premium")).toBeVisible();
  await expect.element(page.getByRole("img", { name: "Avatar for Ai Chan" })).toBeVisible();
  expect(fetchMock.mock.calls.some(([input]) => String(input).includes("avatar-v1"))).toBe(true);
});
