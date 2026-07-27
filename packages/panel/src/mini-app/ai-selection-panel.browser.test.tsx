import { i18n } from "@/i18n";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { GlobalAiSelectionSettings, GroupAiSelectionCard } from "./ai-selection-panel";
import {
  parseAdminChatAiSelection,
  parseGlobalAiSelection,
  parsePublicChatAiSelection,
} from "./ai-selection";
import type { MiniAppSessionView } from "./session";
import "./i18n";

const BOT_ID = "00000000-0000-4000-8000-000000000001";
const CHAT_ID = -1001;

const OPTIONS = [
  {
    id: "provider-a",
    label: "Provider Alpha",
    defaultModelId: "model-a",
    models: [
      { id: "model-a", label: "Model Alpha" },
      { id: "model-a-fast", label: "Model Alpha Fast" },
    ],
  },
  {
    id: "provider-b",
    label: "Provider Beta",
    defaultModelId: "model-b",
    models: [
      { id: "model-b", label: "Model Beta" },
      { id: "model-b-fast", label: "Model Beta Fast" },
    ],
  },
] as const;

const GLOBAL = {
  revision: "global-revision-1",
  applyState: "applied",
  displayDefault: "show",
  selection: {
    providerId: "provider-a",
    modelId: "model-a-fast",
    providerLabel: "Provider Alpha",
    modelLabel: "Model Alpha Fast",
  },
  options: OPTIONS,
} as const;

const ADMIN_CHAT = {
  revision: "global-revision-1:1",
  source: "chat",
  archived: false,
  applyState: "applied",
  display: { defaultPolicy: "show", overridePolicy: "inherit", visible: true },
  selection: {
    providerId: "provider-a",
    modelId: "model-a-fast",
    providerLabel: "Provider Alpha",
    modelLabel: "Model Alpha Fast",
  },
  options: OPTIONS,
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

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("saves the global Provider, model, and display policy as one revision-checked mutation", async () => {
  let mutation: { url: string; init?: RequestInit } | null = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      if (init?.method === "PATCH") {
        mutation = { url: String(input), init };
        return Response.json({
          ok: true,
          persisted: true,
          applied: true,
          global: {
            ...GLOBAL,
            revision: "global-revision-2",
            displayDefault: "hide",
            selection: {
              providerId: "provider-b",
              modelId: "model-b-fast",
              providerLabel: "Provider Beta",
              modelLabel: "Model Beta Fast",
            },
          },
        });
      }
      return Response.json({ ok: true, global: GLOBAL });
    }),
  );

  render(<GlobalAiSelectionSettings botId={BOT_ID} session={session("admin")} />);
  await expect.element(page.getByRole("heading", { name: "Provider & model" })).toBeVisible();
  await page.getByLabelText("Provider").selectOptions("provider-b");
  await page.getByLabelText("Model").selectOptions("model-b-fast");
  await page.getByLabelText("Default visibility").selectOptions("hide");
  await page.getByRole("button", { name: "Save selection" }).click();
  await expect.element(page.getByText("The selection was persisted and applied.")).toBeVisible();

  expect(mutation).not.toBeNull();
  expect(mutation!.url).toBe(`/api/mini-app/${BOT_ID}/ai-selection/global`);
  expect(mutation!.init).toMatchObject({
    method: "PATCH",
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-mini-app-csrf": "csrf-token" },
    body: JSON.stringify({
      expectedRevision: "global-revision-1",
      providerId: "provider-b",
      modelId: "model-b-fast",
      displayDefault: "hide",
    }),
  });
});

test("keeps the global draft after a revision conflict until the Admin adopts latest", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input, init) => {
      if (init?.method === "PATCH") {
        return Response.json(
          {
            ok: false,
            error: "Stale revision",
            code: "stale_revision",
            latest: { ...GLOBAL, revision: "global-revision-2" },
          },
          { status: 409 },
        );
      }
      return Response.json({ ok: true, global: GLOBAL });
    }),
  );

  render(<GlobalAiSelectionSettings botId={BOT_ID} session={session("admin")} />);
  await page.getByLabelText("Provider").selectOptions("provider-b");
  await page.getByRole("button", { name: "Save selection" }).click();
  await expect
    .element(
      page.getByText("Your draft is preserved. Adopt the latest revision before editing again."),
    )
    .toBeVisible();
  await expect.element(page.getByLabelText("Provider")).toHaveValue("provider-b");
  await page.getByRole("button", { name: "Use latest revision" }).click();
  await expect.element(page.getByLabelText("Provider")).toHaveValue("provider-a");
});

test("retries one pending Bot snapshot through the Bot-level endpoint", async () => {
  const calls: Array<{ url: string; method?: string }> = [];
  let pending = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      calls.push({ url: String(input), method: init?.method });
      if (init?.method === "POST") {
        pending = false;
        return Response.json({ ok: true, persisted: true, applied: true, applyState: "applied" });
      }
      return Response.json({
        ok: true,
        global: { ...GLOBAL, applyState: pending ? "pending" : "applied" },
      });
    }),
  );

  render(<GlobalAiSelectionSettings botId={BOT_ID} session={session("admin")} />);
  await page.getByRole("button", { name: "Retry runtime update" }).click();
  await expect.element(page.getByText("The persisted selection is now active.")).toBeVisible();
  expect(calls).toContainEqual({
    url: `/api/mini-app/${BOT_ID}/ai-selection/retry`,
    method: "POST",
  });
});

test("renders only safe labels for Viewer and renders nothing when display is hidden", async () => {
  const publicChat = {
    revision: "global-revision-1:0",
    source: "global",
    archived: false,
    applyState: "applied",
    selection: { providerLabel: "Provider Alpha", modelLabel: "Model Alpha Fast" },
  } as const;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ ok: true, editable: false, chat: publicChat })),
  );

  const rendered = await render(
    <GroupAiSelectionCard botId={BOT_ID} chatId={CHAT_ID} session={session("viewer")} />,
  );
  await expect.element(page.getByText("Provider Alpha")).toBeVisible();
  await expect.element(page.getByText("Model Alpha Fast")).toBeVisible();
  expect(document.body.textContent).not.toContain("provider-a");
  expect(document.body.textContent).not.toContain("model-a-fast");
  expect(page.getByRole("combobox").query()).toBeNull();

  rendered.unmount();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ ok: true, editable: false, chat: { ...publicChat, selection: undefined } }),
    ),
  );
  render(<GroupAiSelectionCard botId={BOT_ID} chatId={CHAT_ID} session={session("viewer")} />);
  await vi.waitFor(() => expect(document.body.textContent).not.toContain("AI selection"));
});

test("saves a group override and display policy in revision order, then can reset to global", async () => {
  const mutations: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      const url = String(input);
      if (init?.method === "PATCH") {
        mutations.push({ url, init });
        const display = url.endsWith("/display");
        return Response.json({
          ok: true,
          persisted: true,
          applied: true,
          chat: {
            ...ADMIN_CHAT,
            revision: display ? "global-revision-2:2" : "global-revision-1:2",
            selection: {
              providerId: "provider-b",
              modelId: "model-b-fast",
              providerLabel: "Provider Beta",
              modelLabel: "Model Beta Fast",
            },
            display: {
              ...ADMIN_CHAT.display,
              overridePolicy: display ? "hide" : "inherit",
              visible: !display,
            },
          },
        });
      }
      if (init?.method === "DELETE") {
        mutations.push({ url, init });
        return Response.json({
          ok: true,
          persisted: true,
          applied: true,
          chat: {
            ...ADMIN_CHAT,
            revision: "global-revision-2:0",
            source: "global",
          },
        });
      }
      return Response.json({ ok: true, editable: true, chat: ADMIN_CHAT });
    }),
  );

  render(<GroupAiSelectionCard botId={BOT_ID} chatId={CHAT_ID} session={session("admin")} />);
  await page.getByLabelText("Provider").selectOptions("provider-b");
  await page.getByLabelText("Model").selectOptions("model-b-fast");
  await page.getByLabelText("Visibility in this group").selectOptions("hide");
  await page.getByRole("button", { name: "Save selection" }).click();
  await expect.element(page.getByText("The selection was persisted and applied.")).toBeVisible();

  expect(JSON.parse(String(mutations[0]!.init?.body))).toEqual({
    expectedRevision: "global-revision-1:1",
    providerId: "provider-b",
    modelId: "model-b-fast",
  });
  expect(JSON.parse(String(mutations[1]!.init?.body))).toEqual({
    expectedRevision: "global-revision-1:2",
    policy: "hide",
  });

  await page.getByRole("button", { name: "Follow Bot default" }).click();
  expect(mutations.at(-1)?.init?.method).toBe("DELETE");
  expect(JSON.parse(String(mutations.at(-1)?.init?.body))).toEqual({
    expectedRevision: "global-revision-2:2",
  });
});

test("rejects sensitive or over-privileged selection projections", () => {
  expect(parseGlobalAiSelection({ ...GLOBAL, baseURL: "https://secret.invalid" })).toBeNull();
  expect(parseAdminChatAiSelection({ ...ADMIN_CHAT, encryptedApiKey: "secret" })).toBeNull();
  expect(
    parsePublicChatAiSelection({
      revision: "1:0",
      source: "global",
      archived: false,
      applyState: "applied",
      selection: {
        providerLabel: "Provider Alpha",
        modelLabel: "Model Alpha",
        providerId: "provider-a",
      },
    }),
  ).toBeNull();
});
