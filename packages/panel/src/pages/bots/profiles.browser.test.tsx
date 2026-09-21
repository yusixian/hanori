import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { Link, MemoryRouter, Route, Routes } from "react-router";
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

const managedProfile = {
  id: 71,
  telegramId: 42,
  username: null,
  displayName: "Known person",
  firstName: null,
  lastName: null,
  languageCode: null,
  isPremium: false,
  hasAvatar: false,
  avatarVersion: null,
  notes: "Known notes",
  traits: [],
  interests: [],
  relationship: null,
  firstSeen: "2026-07-01T00:00:00.000Z",
  lastSeen: "2026-07-20T00:00:00.000Z",
};

function profileJson(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function profileList(name = "Known person") {
  return profileJson({ ok: true, total: 1, data: [{ ...managedProfile, displayName: name }] });
}

function profilePage(start: number, count: number, total = 25) {
  return profileJson({
    ok: true,
    total,
    data: Array.from({ length: count }, (_, index) => {
      const position = start + index;
      return {
        ...managedProfile,
        id: 100 + position,
        telegramId: 1_000 + position,
        displayName: `Search person ${position}`,
      };
    }),
  });
}

function mountManagedProfiles() {
  render(
    <MemoryRouter initialEntries={["/bots/test-id/profiles"]}>
      <Link to="/bots/other/profiles">Switch Bot</Link>
      <Routes>
        <Route path="/bots/:botId/profiles" element={<BotProfilesPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function failProfileRequest(kind: "http" | "application" | "network") {
  if (kind === "network") throw new TypeError("Offline");
  return profileJson({ ok: false, error: "fixture failure" }, kind === "http" ? 500 : 200);
}

test("links a profile to memories for that Telegram user", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).includes("/profiles")) return new Response(null, { status: 404 });
      return profileList();
    }),
  );
  mountManagedProfiles();

  const link = page.getByRole("link", { name: "View memories for user 42", exact: true });
  await expect.element(link).toBeVisible();
  await expect.element(link).toHaveAttribute("href", "/bots/test-id/memories?telegramId=42");
});

test("paginates all profile search matches and resets to page one when cleared", async () => {
  const requests: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const rawUrl = input instanceof Request ? input.url : String(input);
      const url = new URL(rawUrl, location.origin);
      if (!url.pathname.endsWith("/profiles")) return new Response(null, { status: 404 });
      requests.push(url);
      if (url.searchParams.get("search") !== "match") return profileList();
      return url.searchParams.get("page") === "2" ? profilePage(21, 5) : profilePage(1, 20);
    }),
  );
  mountManagedProfiles();
  await expect.element(page.getByText("Known person", { exact: true })).toBeVisible();

  await page.getByPlaceholder("Search by name, username, or notes…").fill("match");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect.element(page.getByText("25 total", { exact: true })).toBeVisible();
  await expect.element(page.getByText("1 / 2", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Search person 1", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Search person 20", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Search person 21", { exact: true })).not.toBeInTheDocument();

  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect.element(page.getByText("2 / 2", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Search person 21", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Search person 25", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Search person 1", { exact: true })).not.toBeInTheDocument();

  const searchRequests = requests.filter((url) => url.searchParams.get("search") === "match");
  expect(
    searchRequests.map((url) => ({
      limit: url.searchParams.get("limit"),
      page: url.searchParams.get("page"),
      search: url.searchParams.get("search"),
    })),
  ).toEqual([
    { limit: "20", page: "1", search: "match" },
    { limit: "20", page: "2", search: "match" },
  ]);

  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect.element(page.getByText("Known person", { exact: true })).toBeVisible();
  await expect.element(page.getByText("1 total", { exact: true })).toBeVisible();
  const clearedRequest = requests.at(-1)!;
  expect(clearedRequest.searchParams.get("search")).toBeNull();
  expect(clearedRequest.searchParams.get("page")).toBe("1");
  expect(clearedRequest.searchParams.get("limit")).toBe("20");
});

for (const failure of ["http", "application", "network"] as const) {
  test(`shows ${failure} profile list failure and retries without claiming an empty list`, async () => {
    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (!String(input).includes("/profiles")) return new Response(null, { status: 404 });
        return fail ? failProfileRequest(failure) : profileList();
      }),
    );
    mountManagedProfiles();
    await expect.element(page.getByRole("alert")).toHaveTextContent("Could not load records");
    await expect
      .element(page.getByText("No profiles found.", { exact: true }))
      .not.toBeInTheDocument();
    await expect.element(page.getByText("0 total", { exact: true })).not.toBeInTheDocument();
    fail = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect.element(page.getByText("Known person", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  });
}

for (const action of ["create", "save", "delete"] as const) {
  for (const failure of ["http", "application", "network"] as const) {
    test(`preserves profile ${action} state after ${failure} failure and allows a confirmed retry`, async () => {
      const method = { create: "POST", save: "PUT", delete: "DELETE" }[action];
      let fail = true;
      let writes = 0;
      let reads = 0;
      vi.spyOn(window, "confirm").mockReturnValue(true);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          if (!String(input).includes("/profiles")) return new Response(null, { status: 404 });
          if (init?.method === method) {
            writes += 1;
            return fail
              ? failProfileRequest(failure)
              : profileJson({ ok: true, data: managedProfile });
          }
          reads += 1;
          return profileList();
        }),
      );
      mountManagedProfiles();
      await expect.element(page.getByText("Known person", { exact: true })).toBeVisible();
      if (action === "create") {
        await page.getByRole("button", { name: "Add profile" }).click();
        await page.getByPlaceholder("123456789").fill("43");
        await page.getByLabelText("Display name").fill("Retained draft");
      } else if (action === "save") {
        await page.getByRole("button", { name: "Edit profile" }).click();
        await page.getByLabelText("Display name").fill("Retained draft");
      }
      const actionButton = page.getByRole("button", {
        name: { create: "Create", save: "Save", delete: "Delete profile" }[action],
        exact: true,
      });
      await actionButton.click();
      await expect.element(page.getByRole("alert")).toHaveTextContent("Could not confirm");
      expect(reads).toBe(1);
      expect(writes).toBe(1);
      if (action !== "delete") {
        await expect.element(page.getByLabelText("Display name")).toHaveValue("Retained draft");
        await expect.element(actionButton).toBeEnabled();
      } else {
        await expect.element(page.getByText("Known person", { exact: true })).toBeVisible();
      }
      await page.getByRole("button", { name: "Refresh list", exact: true }).click();
      await vi.waitFor(() => expect(reads).toBe(2));
      if (action !== "delete")
        await expect.element(page.getByLabelText("Display name")).toHaveValue("Retained draft");
      fail = false;
      await actionButton.click();
      await expect
        .element(
          page.getByText({ create: "Created.", save: "Saved.", delete: "Deleted." }[action], {
            exact: true,
          }),
        )
        .toBeVisible();
      await vi.waitFor(() => expect(reads).toBe(3));
      expect(writes).toBe(2);
      await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
      if (action !== "delete")
        await expect.element(page.getByLabelText("Display name")).not.toBeInTheDocument();
    });
  }
}

test("locks profile draft and duplicate submits until completion, then distinguishes refresh failure", async () => {
  let resolveWrite!: (res: Response) => void;
  let reads = 0;
  let writes = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes("/profiles")) return new Response(null, { status: 404 });
      if (init?.method === "PUT") {
        writes += 1;
        return new Promise<Response>((resolve) => {
          resolveWrite = resolve;
        });
      }
      reads += 1;
      return reads > 1 ? failProfileRequest("http") : profileList();
    }),
  );
  mountManagedProfiles();
  await page.getByRole("button", { name: "Edit profile" }).click();
  await page.getByLabelText("Display name").fill("Saved person");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.element(page.getByLabelText("Display name")).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Add profile" })).toBeDisabled();
  await expect.element(page.getByPlaceholder("Search by name, username, or notes…")).toBeDisabled();
  (page.getByRole("button", { name: "Save", exact: true }).element() as HTMLButtonElement).click();
  expect(writes).toBe(1);
  resolveWrite(profileJson({ ok: true, data: managedProfile }));
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Refresh failed. Showing the last loaded records.");
  await expect.element(page.getByRole("status")).toHaveTextContent("Saved.");
  await expect.element(page.getByText("Known person", { exact: true })).toBeVisible();
  expect(writes).toBe(1);
});

test("does not let an old search response overwrite the latest profile query", async () => {
  let resolveOld!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.includes("/profiles")) return new Response(null, { status: 404 });
      if (url.includes("search=old"))
        return new Promise<Response>((resolve) => {
          resolveOld = resolve;
        });
      return profileList(url.includes("search=new") ? "Latest person" : "Known person");
    }),
  );
  mountManagedProfiles();
  await expect.element(page.getByText("Known person", { exact: true })).toBeVisible();
  await page.getByPlaceholder("Search by name, username, or notes…").fill("old");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await vi.waitFor(() => expect(resolveOld).toBeTypeOf("function"));
  await expect.element(page.getByText("Known person", { exact: true })).not.toBeInTheDocument();
  await page.getByPlaceholder("Search by name, username, or notes…").fill("new");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect.element(page.getByText("Latest person", { exact: true })).toBeVisible();
  resolveOld(profileList("Stale person"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  await expect.element(page.getByText("Latest person", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Stale person", { exact: true })).not.toBeInTheDocument();
});

test("an old Bot write cannot clear a new Bot draft or refresh its list", async () => {
  let resolveWrite!: (res: Response) => void;
  let otherReads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("/profiles")) return new Response(null, { status: 404 });
      if (init?.method === "POST")
        return new Promise<Response>((resolve) => {
          resolveWrite = resolve;
        });
      if (url.includes("/bots/other/")) otherReads += 1;
      return profileList();
    }),
  );
  mountManagedProfiles();
  await page.getByRole("button", { name: "Add profile" }).click();
  await page.getByPlaceholder("123456789").fill("42");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name: "Switch Bot" }).click();
  await page.getByRole("button", { name: "Add profile" }).click();
  await page.getByPlaceholder("123456789").fill("43");
  await page.getByLabelText("Display name").fill("Other Bot draft");
  resolveWrite(profileJson({ ok: true, data: managedProfile }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  await expect.element(page.getByLabelText("Display name")).toHaveValue("Other Bot draft");
  await expect.element(page.getByRole("button", { name: "Create", exact: true })).toBeEnabled();
  expect(otherReads).toBe(1);
});

test("waits for a failure confirmation refresh before accepting another write", async () => {
  let resolveRefresh!: (res: Response) => void;
  let reads = 0;
  let writes = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes("/profiles")) return new Response(null, { status: 404 });
      if (init?.method === "POST") {
        writes += 1;
        return failProfileRequest("network");
      }
      reads += 1;
      if (reads > 1)
        return new Promise<Response>((resolve) => {
          resolveRefresh = resolve;
        });
      return profileList();
    }),
  );
  mountManagedProfiles();
  await expect.element(page.getByText("Known person", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add profile" }).click();
  await page.getByPlaceholder("123456789").fill("43");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("button", { name: "Refresh list", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Delete profile" })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Edit profile" })).toBeDisabled();
  await expect.element(page.getByPlaceholder("123456789")).toBeDisabled();
  (
    page.getByRole("button", { name: "Create", exact: true }).element() as HTMLButtonElement
  ).click();
  expect(writes).toBe(1);
  resolveRefresh(profileList());
  await expect.element(page.getByRole("button", { name: "Create", exact: true })).toBeEnabled();
  await expect.element(page.getByPlaceholder("123456789")).toHaveValue("43");
});

test("does not refresh old Bot bindings after a pending binding write finishes", async () => {
  let resolveWrite!: (res: Response) => void;
  let bindingReads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/authz/me"))
        return profileJson({ data: { member: { role: "owner" } } });
      if (url.includes("/generation-library/bindings/42")) {
        if (init?.method === "PUT")
          return new Promise<Response>((resolve) => {
            resolveWrite = resolve;
          });
        bindingReads += 1;
        return profileJson({ ok: true, data: [] });
      }
      if (url.includes("/generation-library/characters"))
        return profileJson({
          ok: true,
          total: 1,
          data: [
            { id: 5, name: "Mira", source: "original", aliases: [], appearance: "silver hair" },
          ],
        });
      if (url.includes("/profiles"))
        return profileList(url.includes("/bots/other/") ? "Other person" : "Known person");
      return new Response(null, { status: 404 });
    }),
  );
  mountManagedProfiles();
  await page.getByRole("button", { name: "Manage characters" }).click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await vi.waitFor(() => expect(resolveWrite).toBeTypeOf("function"));
  await page.getByRole("link", { name: "Switch Bot" }).click();
  await expect.element(page.getByText("Other person", { exact: true })).toBeVisible();
  resolveWrite(profileJson({ ok: true }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(bindingReads).toBe(1);
});

test("does not present the previous empty list as current after a confirmed create and failed refresh", async () => {
  let created = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes("/profiles")) return new Response(null, { status: 404 });
      if (init?.method === "POST") {
        created = true;
        return profileJson({ ok: true, data: managedProfile });
      }
      return created ? failProfileRequest("http") : profileJson({ ok: true, total: 0, data: [] });
    }),
  );
  mountManagedProfiles();
  await expect.element(page.getByText("No profiles found.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add profile" }).click();
  await page.getByPlaceholder("123456789").fill("42");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Refresh failed");
  await expect.element(page.getByRole("status")).toHaveTextContent("Created.");
  await expect
    .element(page.getByText("No profiles found.", { exact: true }))
    .not.toBeInTheDocument();
  await expect.element(page.getByText("0 total", { exact: true })).not.toBeInTheDocument();
});
