import { i18n } from "@/i18n";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
import { GroupsPage } from "./groups-page";
import { parseMiniAppGroup } from "./groups";
import type { MiniAppSessionView } from "./session";
import "./i18n";
import "./mini-app.css";

const BOT_ID = "00000000-0000-4000-8000-000000000001";

const GROUP = {
  chatId: -1001,
  type: "supergroup",
  title: "Build Room",
  username: "build_room",
  botMembershipStatus: "administrator",
  membershipObservedAt: "2026-07-01T00:00:00.000Z",
  lastObservedAt: "2026-07-26T00:00:00.000Z",
  archived: false,
  config: {
    revision: "revision-1",
    aiConfigured: true,
    group: {
      enabled: true,
      whitelisted: false,
      trigger: {
        replyToBot: true,
        mentionBot: true,
        triggerWords: ["helper"],
        randomReplyPercent: 5,
        randomReplyCooldown: 60,
      },
      conversation: {
        enabled: true,
        maxContextMessages: 20,
        groupHistoryMaxTokens: 8_000,
      },
    },
    summary: {
      enabled: true,
      scheduleHour: 9,
      scheduleMinute: 30,
      timezone: "Asia/Shanghai",
      windowHours: 24,
      maxMessages: 500,
      cooldownSeconds: 3_600,
    },
  },
  applyState: "applied",
} as const;

const OTHER_GROUP = {
  ...GROUP,
  chatId: -1002,
  title: "Release Room",
  username: "release_room",
} as const;

function session(role: "admin" | "operator" | "viewer"): MiniAppSessionView {
  return {
    user: { id: 42 },
    role,
    capabilities: [],
    chatScope: { kind: "all" },
    expiresAt: 1_800_000_900,
    csrfToken: "csrf-token",
  };
}

function renderGroups(role: "admin" | "operator" | "viewer", detail = true) {
  const path = `/mini-app/${BOT_ID}/groups${detail ? "/-1001" : ""}`;
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/mini-app/:botId/groups"
          element={<GroupsPage botId={BOT_ID} session={session(role)} />}
        />
        <Route
          path="/mini-app/:botId/groups/:chatId"
          element={<GroupsPage botId={BOT_ID} session={session(role)} />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("renders a safe group directory linking to details", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ ok: true, editable: true, groups: [GROUP] })),
  );
  renderGroups("operator", false);

  await expect.element(page.getByRole("heading", { name: "Groups" })).toBeVisible();
  await expect
    .element(page.getByRole("link", { name: /Build Room/ }))
    .toHaveAttribute("href", `/mini-app/${BOT_ID}/groups/-1001`);
  const meta = document.querySelector<HTMLElement>(".mini-groups-card-meta");
  expect(meta).not.toBeNull();
  expect(getComputedStyle(meta!).flexWrap).toBe("wrap");
});

test("filters the compact group directory and surfaces refresh failures", async () => {
  let requests = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      requests += 1;
      if (requests > 1) throw new Error("offline");
      return Response.json({ ok: true, editable: true, groups: [GROUP, OTHER_GROUP] });
    }),
  );
  renderGroups("operator", false);

  await expect.element(page.getByText("2 groups")).toBeVisible();
  await page.getByRole("searchbox", { name: "Search groups" }).fill("release");
  await expect.element(page.getByRole("link", { name: /Release Room/ })).toBeVisible();
  expect(page.getByRole("link", { name: /Build Room/ }).query()).toBeNull();

  await page.getByRole("button", { name: "Refresh groups" }).click();
  await expect
    .element(page.getByText("Refresh failed. The list below may be out of date."))
    .toBeVisible();
  await expect.element(page.getByRole("link", { name: /Release Room/ })).toBeVisible();
});

test("renders Viewer details without any edit controls", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ ok: true, editable: false, group: GROUP })),
  );
  renderGroups("viewer");

  await expect.element(page.getByRole("heading", { name: "Build Room" })).toBeVisible();
  await expect
    .element(
      page.getByText("Your Viewer role can inspect this configuration but cannot change it."),
    )
    .toBeVisible();
  await expect.element(page.getByText("Asia/Shanghai")).toBeVisible();
  expect(page.getByRole("textbox").query()).toBeNull();
  expect(page.getByRole("spinbutton").query()).toBeNull();
  expect(page.getByRole("checkbox").query()).toBeNull();
  expect(page.getByRole("button", { name: "Save changes" }).query()).toBeNull();
});

test("sends only changed fields with revision and CSRF when an Operator saves", async () => {
  let mutationInit: RequestInit | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input, init) => {
      if (init?.method === "PATCH") {
        mutationInit = init;
        return Response.json({
          ok: true,
          persisted: true,
          applied: true,
          group: {
            ...GROUP,
            config: {
              ...GROUP.config,
              revision: "revision-2",
              group: { ...GROUP.config.group, whitelisted: true },
            },
          },
        });
      }
      return Response.json({ ok: true, editable: true, group: GROUP });
    }),
  );
  renderGroups("operator");

  await expect.element(page.getByRole("heading", { name: "Build Room" })).toBeVisible();
  await page.getByRole("checkbox", { name: "AI allowlist" }).click();
  await expect.element(page.getByText("AI allowlist", { exact: true }).last()).toBeVisible();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.element(page.getByText("Changes were persisted and applied.")).toBeVisible();

  expect(mutationInit).toMatchObject({
    method: "PATCH",
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-mini-app-csrf": "csrf-token" },
    body: JSON.stringify({
      expectedRevision: "revision-1",
      patch: { group: { whitelisted: true } },
    }),
  });
});

test("preserves the local draft on a stale revision until latest is explicitly adopted", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input, init) => {
      if (init?.method === "PATCH") {
        return Response.json(
          {
            ok: false,
            error: "stale",
            code: "stale_revision",
            latest: { ...GROUP, config: { ...GROUP.config, revision: "revision-2" } },
          },
          { status: 409 },
        );
      }
      return Response.json({ ok: true, editable: true, group: GROUP });
    }),
  );
  renderGroups("operator");

  await expect.element(page.getByRole("heading", { name: "Build Room" })).toBeVisible();
  const allowlist = page.getByRole("checkbox", { name: "AI allowlist" });
  await allowlist.click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect
    .element(page.getByRole("heading", { name: "A newer revision exists" }))
    .toBeVisible();
  await expect.element(allowlist).toBeChecked();

  await page.getByRole("button", { name: "Use latest revision" }).click();
  await expect.element(allowlist).not.toBeChecked();
  await expect.element(page.getByText("No unsaved changes.")).toBeVisible();
});

test("shows pending state to Operators without an apply action", async () => {
  const pending = { ...GROUP, applyState: "pending" as const };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ ok: true, editable: true, group: pending })),
  );

  renderGroups("operator");
  await expect.element(page.getByRole("heading", { name: "Build Room" })).toBeVisible();
  await expect.element(page.getByText("Runtime apply pending", { exact: true })).toBeVisible();
  expect(page.getByRole("button", { name: "Retry apply" }).query()).toBeNull();
});

test("allows an Admin to retry pending runtime apply", async () => {
  const pending = { ...GROUP, applyState: "pending" as const };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input, init) => {
      if (init?.method === "POST") return Response.json({ ok: true, group: GROUP });
      return Response.json({ ok: true, editable: true, group: pending });
    }),
  );

  renderGroups("admin");
  await expect.element(page.getByRole("button", { name: "Retry apply" })).toBeVisible();
  await page.getByRole("button", { name: "Retry apply" }).click();
  await expect
    .element(page.getByText("The latest persisted configuration is now applied."))
    .toBeVisible();
});

test("rejects malformed and sensitive group projections before rendering", () => {
  expect(
    parseMiniAppGroup({
      ...GROUP,
      config: {
        ...GROUP.config,
        group: {
          ...GROUP.config.group,
          conversation: { ...GROUP.config.group.conversation, maxContextMessages: 101 },
        },
      },
    }),
  ).toBeNull();
  expect(parseMiniAppGroup({ ...GROUP, systemPrompt: "PRIVATE_SYSTEM_PROMPT" })).toBeNull();
  expect(parseMiniAppGroup({ ...GROUP, provider: { model: "PRIVATE_MODEL" } })).toBeNull();
});
