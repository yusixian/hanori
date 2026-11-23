import "@/style.css";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { StrictMode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { i18n } from "@/i18n";
import { BotGovernancePage } from "./governance";

function stubFetch(fetchMock: typeof fetch) {
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).includes("/api/image-mcp-platform")
      ? Promise.resolve(
          new Response(JSON.stringify({ ok: true, data: { baseUrl: "", revision: 0 } })),
        )
      : fetchMock(input, init),
  );
}

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

test("applies the shared platform without discarding unsaved governance fields", async () => {
  let configured = false;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/api/image-mcp-platform")) {
      if (init?.method === "PUT") configured = true;
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            baseUrl: configured ? "https://mcp.example.com" : "",
            revision: configured ? 1 : 0,
          },
        }),
      );
    }
    if (String(input).includes("/governance/subjects"))
      return new Response(JSON.stringify({ ok: true, subjects: [] }));
    const status = {
      status: "disconnected",
      scopes: [],
      ...(configured ? {} : { lastError: "NOT_CONFIGURED" }),
    };
    return new Response(
      JSON.stringify({
        ok: true,
        data: { ...loadedDraft, connections: { mcp_openai: status, mcp_gemini: status } },
      }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  render(
    <MemoryRouter initialEntries={["/bots/test-id/governance"]}>
      <Routes>
        <Route path="/bots/:botId/governance" element={<BotGovernancePage />} />
      </Routes>
    </MemoryRouter>,
  );
  await expect.element(page.getByLabelText("Platform address")).toBeEnabled();
  await expect
    .element(page.getByRole("button", { name: "Connect MCP", exact: true }).first())
    .toBeDisabled();
  await page.getByLabelText("Budget timezone").fill("Europe/Paris");
  await page.getByLabelText("Platform address").fill("mcp.example.com");
  await page.getByRole("button", { name: "Save platform address" }).click();
  await expect
    .element(page.getByRole("button", { name: "Connect MCP", exact: true }).first())
    .toBeEnabled();
  await expect.element(page.getByLabelText("Budget timezone")).toHaveValue("Europe/Paris");
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
});

test("resets the complete governance draft to the raised defaults before saving", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/governance/subjects")) {
      return new Response(JSON.stringify({ ok: true, subjects: [] }), { status: 200 });
    }
    const data =
      init?.method === "PUT"
        ? { ...JSON.parse(String(init.body)), connection: loadedDraft.connection }
        : loadedDraft;
    return new Response(JSON.stringify({ ok: true, data }), { status: 200 });
  });
  stubFetch(fetchMock);

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
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const request = fetchMock.mock.calls.find((call) => call[1]?.method === "PUT")?.[1];
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
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/governance/subjects")) {
      return new Response(JSON.stringify({ ok: true, subjects: [] }), { status: 200 });
    }
    const data =
      init?.method === "PUT"
        ? { ...JSON.parse(String(init.body)), connection: loadedDraft.connection }
        : loadedDraft;
    return new Response(JSON.stringify({ ok: true, data }), { status: 200 });
  });
  stubFetch(fetchMock);

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
  await page.getByRole("button", { name: "Save", exact: true }).click();

  const request = fetchMock.mock.calls.find((call) => call[1]?.method === "PUT")?.[1];
  const body = JSON.parse(String(request?.body)) as typeof loadedDraft;
  expect(body.privateChatUserIds).toEqual([73, 4242]);
});

test("selects a recognized group instead of requiring a raw chat ID", async () => {
  const draft = { ...loadedDraft, overrides: [] };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/governance/subjects")) {
      return new Response(
        JSON.stringify({
          ok: true,
          subjects: [{ id: "-100001", name: "Acceptance Art Group", username: "art_group" }],
        }),
        { status: 200 },
      );
    }
    const data =
      init?.method === "PUT"
        ? { ...JSON.parse(String(init.body)), connection: draft.connection }
        : draft;
    return new Response(JSON.stringify({ ok: true, data }), { status: 200 });
  });
  stubFetch(fetchMock);

  render(
    <MemoryRouter initialEntries={["/bots/test-id/governance"]}>
      <Routes>
        <Route path="/bots/:botId/governance" element={<BotGovernancePage />} />
      </Routes>
    </MemoryRouter>,
  );

  await expect.element(page.getByRole("button", { name: "Add override" })).toBeVisible();
  await page.getByRole("button", { name: "Add override" }).click();
  await page.getByRole("combobox", { name: "Group" }).click();
  await page.getByRole("option", { name: /Acceptance Art Group/ }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();

  const request = fetchMock.mock.calls.find((call) => call[1]?.method === "PUT")?.[1];
  const body = JSON.parse(String(request?.body)) as typeof loadedDraft;
  expect(body.overrides).toMatchObject([
    { resource: "ai_reply", scope: "chat", subjectKey: "-100001" },
  ]);
});

test.each([
  {
    name: "person",
    scope: "user_global" as const,
    expectedSubjectKey: "900001",
  },
  {
    name: "person in a group",
    scope: "chat_user" as const,
    expectedSubjectKey: "-100001:900001",
  },
])(
  "builds the $name subject key from recognized selections",
  async ({ scope, expectedSubjectKey }) => {
    const draft = {
      ...loadedDraft,
      overrides: [{ resource: "ai_reply" as const, scope, subjectKey: "", daily: 10 }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/governance/subjects")) {
        const subjects = url.includes("kind=chat")
          ? [{ id: "-100001", name: "Acceptance Art Group", username: "art_group" }]
          : [{ id: "900001", name: "Acceptance Artist", username: "acceptance_artist" }];
        return new Response(JSON.stringify({ ok: true, subjects }), { status: 200 });
      }
      const data =
        init?.method === "PUT"
          ? { ...JSON.parse(String(init.body)), connection: draft.connection }
          : draft;
      return new Response(JSON.stringify({ ok: true, data }), { status: 200 });
    });
    stubFetch(fetchMock);

    render(
      <MemoryRouter initialEntries={["/bots/test-id/governance"]}>
        <Routes>
          <Route path="/bots/:botId/governance" element={<BotGovernancePage />} />
        </Routes>
      </MemoryRouter>,
    );

    if (scope === "chat_user") {
      await expect.element(page.getByRole("combobox", { name: "Group" })).toBeVisible();
      await page.getByRole("combobox", { name: "Group" }).click();
      await page.getByRole("option", { name: /Acceptance Art Group/ }).click();
    }
    await page.getByRole("combobox", { name: "Person" }).click();
    await page.getByRole("option", { name: /Acceptance Artist/ }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();

    const request = fetchMock.mock.calls.find((call) => call[1]?.method === "PUT")?.[1];
    const body = JSON.parse(String(request?.body)) as typeof loadedDraft;
    expect(body.overrides).toMatchObject([{ scope, subjectKey: expectedSubjectKey }]);
  },
);

test("blocks a positive user ID selected as a group with an actionable error", async () => {
  const draft = {
    ...loadedDraft,
    overrides: [
      { resource: "image" as const, scope: "chat" as const, subjectKey: "3522396394", daily: 10 },
    ],
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    if (String(input).includes("/governance/subjects")) {
      return new Response(JSON.stringify({ ok: true, subjects: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, data: draft }), { status: 200 });
  });
  stubFetch(fetchMock);

  render(
    <MemoryRouter initialEntries={["/bots/test-id/governance"]}>
      <Routes>
        <Route path="/bots/:botId/governance" element={<BotGovernancePage />} />
      </Routes>
    </MemoryRouter>,
  );

  await expect
    .element(page.getByRole("combobox", { name: "Group" }))
    .toHaveTextContent("Unknown group (ID 3522396394)");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("does not match the selected target type");
  expect(fetchMock.mock.calls.some((call) => call[1]?.method === "PUT")).toBe(false);
});

test("resolves saved group and person IDs to recognized names", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes("kind=chat")) {
      return new Response(
        JSON.stringify({
          ok: true,
          subjects: [{ id: "-100", name: "Saved Art Group", username: null }],
        }),
        { status: 200 },
      );
    }
    if (url.includes("kind=user")) {
      return new Response(
        JSON.stringify({
          ok: true,
          subjects: [{ id: "42", name: "Saved Artist", username: "saved_artist" }],
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ ok: true, data: loadedDraft }), { status: 200 });
  });
  stubFetch(fetchMock);

  render(
    <StrictMode>
      <MemoryRouter initialEntries={["/bots/test-id/governance"]}>
        <Routes>
          <Route path="/bots/:botId/governance" element={<BotGovernancePage />} />
        </Routes>
      </MemoryRouter>
    </StrictMode>,
  );

  await expect
    .element(page.getByRole("combobox", { name: "Group" }))
    .toHaveTextContent("Saved Art Group");
  await expect
    .element(page.getByRole("combobox", { name: "Person" }))
    .toHaveTextContent("Saved Artist");
});

test("refresh resolves saved IDs again instead of keeping stale names", async () => {
  let groupName = "Original Art Group";
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes("kind=chat")) {
      return new Response(
        JSON.stringify({
          ok: true,
          subjects: [{ id: "-100", name: groupName, username: null }],
        }),
        { status: 200 },
      );
    }
    if (url.includes("kind=user")) {
      return new Response(
        JSON.stringify({
          ok: true,
          subjects: [{ id: "42", name: "Saved Artist", username: "saved_artist" }],
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ ok: true, data: loadedDraft }), { status: 200 });
  });
  stubFetch(fetchMock);

  render(
    <MemoryRouter initialEntries={["/bots/test-id/governance"]}>
      <Routes>
        <Route path="/bots/:botId/governance" element={<BotGovernancePage />} />
      </Routes>
    </MemoryRouter>,
  );

  await expect
    .element(page.getByRole("combobox", { name: "Group" }))
    .toHaveTextContent("Original Art Group");
  groupName = "Renamed Art Group";
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect
    .element(page.getByRole("combobox", { name: "Group" }))
    .toHaveTextContent("Renamed Art Group");
});

test("blocks duplicate resource and target overrides before sending the update", async () => {
  const draft = {
    ...loadedDraft,
    overrides: [loadedDraft.overrides[0], { ...loadedDraft.overrides[0], daily: 9 }],
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    if (String(input).includes("/governance/subjects")) {
      return new Response(JSON.stringify({ ok: true, subjects: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, data: draft }), { status: 200 });
  });
  stubFetch(fetchMock);

  render(
    <MemoryRouter initialEntries={["/bots/test-id/governance"]}>
      <Routes>
        <Route path="/bots/:botId/governance" element={<BotGovernancePage />} />
      </Routes>
    </MemoryRouter>,
  );

  await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("already has an override for this target");
  expect(fetchMock.mock.calls.some((call) => call[1]?.method === "PUT")).toBe(false);
});

for (const [width, height] of [
  [1440, 900],
  [390, 844],
]) {
  test(`keeps provider presets independent when changing the default at ${width}px`, async () => {
    await page.viewport(width!, height!);
    const data = {
      ...loadedDraft,
      routes: loadedDraft.routes.map((route) => ({ ...route, enabled: true })),
    };
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Response(
          JSON.stringify({
            ok: true,
            data:
              init?.method === "PUT"
                ? { ...JSON.parse(String(init.body)), connection: data.connection }
                : data,
          }),
          { status: 200 },
        ),
    );
    stubFetch(fetchMock);
    render(
      <MemoryRouter initialEntries={["/bots/test-id/governance"]}>
        <Routes>
          <Route path="/bots/:botId/governance" element={<BotGovernancePage />} />
        </Routes>
      </MemoryRouter>,
    );
    await expect.element(page.getByLabelText("Default provider").nth(0)).toHaveValue("mcp_pixai");
    await page.getByLabelText("Default provider").nth(0).selectOptions("mcp_gemini");
    const geminiPreset = document.getElementById(
      "preset-anime_illustration-mcp_gemini",
    ) as HTMLInputElement;
    expect(geminiPreset.value).toBe("");
    expect(
      (document.getElementById("preset-anime_illustration-mcp_pixai") as HTMLInputElement).value,
    ).toBe("custom-preset");
    await page.getByLabelText("Default preset key").nth(2).fill("gemini-portrait");
    await page.getByLabelText("Default provider").nth(1).selectOptions("mcp_openai");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const request = fetchMock.mock.calls.find((call) => call[1]?.method === "PUT")?.[1];
    const saved = JSON.parse(String(request?.body));
    expect(saved.routes[0]).toMatchObject({
      defaultBackendId: "mcp_gemini",
      backends: expect.arrayContaining([
        expect.objectContaining({ backendId: "mcp_pixai", defaultPresetKey: "custom-preset" }),
        expect.objectContaining({ backendId: "mcp_gemini", defaultPresetKey: "gemini-portrait" }),
      ]),
    });
    expect(saved.routes[1].defaultBackendId).toBe("mcp_openai");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width!);
  });
}
