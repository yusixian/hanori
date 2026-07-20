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
      return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>', {
        status: 200,
        headers: { "content-type": "image/svg+xml" },
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

test("renders an accessible person fallback when a profile has no avatar", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/bots/test-id/profiles")) {
      return new Response(
        JSON.stringify({
          ok: true,
          total: 1,
          data: [
            {
              id: 8,
              telegramId: 43,
              username: null,
              displayName: "No Photo",
              firstName: "No",
              lastName: "Photo",
              languageCode: null,
              isPremium: false,
              hasAvatar: false,
              avatarVersion: null,
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

  await expect.element(page.getByText("No Photo")).toBeVisible();
  await expect.element(page.getByRole("img", { name: "Avatar for No Photo" })).toBeVisible();
  expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/avatar"))).toBe(false);
});

test("renders the same person fallback when a cached avatar returns 404", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/bots/test-id/profiles/9/avatar")) {
      return new Response(null, { status: 404 });
    }
    if (url.includes("/api/bots/test-id/profiles")) {
      return new Response(
        JSON.stringify({
          ok: true,
          total: 1,
          data: [
            {
              id: 9,
              telegramId: 44,
              username: "missingphoto",
              displayName: "Missing Photo",
              firstName: "Missing",
              lastName: "Photo",
              languageCode: null,
              isPremium: false,
              hasAvatar: true,
              avatarVersion: "missing-v1",
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

  await expect.element(page.getByText("Missing Photo")).toBeVisible();
  await expect.element(page.getByRole("img", { name: "Avatar for Missing Photo" })).toBeVisible();
  expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/profiles/9/avatar"))).toBe(
    true,
  );
});
