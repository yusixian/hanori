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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("keeps the manual profile form when creation conflicts", async () => {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.includes("/api/bots/test-id/profiles") && init?.method === "POST") {
        return new Response(JSON.stringify({ ok: false, error: "Profile already exists" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/bots/test-id/profiles")) {
        return new Response(JSON.stringify({ ok: true, total: 0, data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});

  render(
    <MemoryRouter initialEntries={["/bots/test-id/profiles"]}>
      <Routes>
        <Route path="/bots/:botId/profiles" element={<BotProfilesPage />} />
      </Routes>
    </MemoryRouter>,
  );

  await expect.element(page.getByRole("heading", { name: "People profiles" })).toBeVisible();
  await page.getByRole("button", { name: "Add profile" }).click();
  await page.getByPlaceholder("123456789").fill("42");
  await page.getByLabelText("Display name").fill("Manual replacement");
  await page.getByRole("button", { name: "Create" }).click();

  await vi.waitFor(() =>
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true),
  );
  await expect.element(page.getByRole("heading", { name: "New profile" })).toBeVisible();
  await expect.element(page.getByPlaceholder("123456789")).toHaveValue("42");
  await expect.element(page.getByLabelText("Display name")).toHaveValue("Manual replacement");
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

test("lets administrators bind a default representation without exposing character fields", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/authz/me")) {
      return new Response(JSON.stringify({ data: { member: { role: "owner" } } }), { status: 200 });
    }
    if (url.includes("/generation-library/bindings/42")) {
      if (init?.method === "PUT") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, data: [] }), { status: 200 });
    }
    if (url.includes("/generation-library/characters")) {
      return new Response(
        JSON.stringify({
          ok: true,
          total: 1,
          data: [
            {
              id: 5,
              name: "Mira",
              source: "original",
              aliases: ["mira oc"],
              appearance: "silver hair, amber eyes",
            },
          ],
        }),
        { status: 200 },
      );
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
        { status: 200 },
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

  await expect.element(page.getByText("Ai Chan")).toBeVisible();
  await page.getByRole("button", { name: "Manage characters" }).click();
  await expect.element(page.getByText("Character bindings", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Mira", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add", exact: true }).click();

  await vi.waitFor(() => {
    const request = fetchMock.mock.calls.find(
      ([input, requestInit]) =>
        String(input).includes("/generation-library/bindings/42") && requestInit?.method === "PUT",
    )?.[1];
    expect(request).toBeDefined();
    expect(JSON.parse(String(request?.body))).toEqual({
      characterId: 5,
      relation: "representation",
      isDefault: true,
    });
  });
});

test("keeps binding and candidate loading independent and ignores stale searches", async () => {
  let resolveBindings!: (response: Response) => void;
  let resolveOldSearch!: (response: Response) => void;
  let resolveNewSearch!: (response: Response) => void;
  const bindingsResponse = new Promise<Response>((resolve) => {
    resolveBindings = resolve;
  });
  const oldSearchResponse = new Promise<Response>((resolve) => {
    resolveOldSearch = resolve;
  });
  const newSearchResponse = new Promise<Response>((resolve) => {
    resolveNewSearch = resolve;
  });
  const characterResponse = (id: number, name: string) =>
    new Response(
      JSON.stringify({
        ok: true,
        total: 1,
        data: [{ id, name, source: "original", aliases: [], appearance: name }],
      }),
      { status: 200 },
    );
  const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/api/authz/me")) {
      return new Response(JSON.stringify({ data: { member: { role: "owner" } } }), { status: 200 });
    }
    if (url.includes("/generation-library/bindings/42")) return bindingsResponse;
    if (url.includes("/generation-library/characters")) {
      if (url.includes("search=old")) return oldSearchResponse;
      if (url.includes("search=new")) return newSearchResponse;
      return characterResponse(1, "Initial character");
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
        { status: 200 },
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

  await expect.element(page.getByText("Ai Chan")).toBeVisible();
  await page.getByRole("button", { name: "Manage characters" }).click();
  await expect.element(page.getByText("Initial character")).toBeVisible();
  await expect.element(page.getByText("No character bindings yet.")).not.toBeInTheDocument();

  resolveBindings(new Response(JSON.stringify({ ok: true, data: [] }), { status: 200 }));
  await expect.element(page.getByText("No character bindings yet.")).toBeVisible();

  const search = page.getByLabelText("Search characters…");
  await search.fill("old");
  await vi.waitFor(() =>
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("search=old"))).toBe(true),
  );
  await search.fill("new");
  await vi.waitFor(() =>
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("search=new"))).toBe(true),
  );

  resolveNewSearch(characterResponse(3, "New result"));
  await expect.element(page.getByText("New result")).toBeVisible();
  resolveOldSearch(characterResponse(2, "Old result"));
  await vi.waitFor(() => expect(page.getByText("Old result").query()).toBeNull());
  await expect.element(page.getByText("New result")).toBeVisible();
});
