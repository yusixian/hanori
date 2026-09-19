import { i18n } from "@/i18n";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BotPlatform } from "@cos-tool-bot/shared";
import { MemoryRouter } from "react-router";
import { BotForm, type BotFormData } from "./bot-form";

const groups = [
  { id: "-1001", name: "Build Room", username: "build_room" },
  { id: "-1002", name: "Release Room", username: "release_room" },
];

function initialData(
  targets: Array<{ alias: string; chatId: number }> = [{ alias: "ops", chatId: -1001 }],
): {
  name: string;
  platform: BotPlatform;
  tokenMasked: string;
  adminChatIds: number[];
  isActive: boolean;
  miniAppEnabled: boolean;
  cosInsideConfig: { targets: Array<{ alias: string; chatId: number }> };
} {
  return {
    name: "Relay Bot",
    platform: "telegram" as const,
    tokenMasked: "123***",
    adminChatIds: [42],
    isActive: true,
    miniAppEnabled: false,
    cosInsideConfig: { targets },
  };
}

async function renderForm({
  onSubmit = vi.fn(async (_data: BotFormData) => undefined),
  canManageCosInside = true,
  platform = "telegram" as const,
  targets,
}: {
  onSubmit?: (data: BotFormData) => Promise<void>;
  canManageCosInside?: boolean;
  platform?: "telegram" | "lark-webhook";
  targets?: Array<{ alias: string; chatId: number }>;
} = {}) {
  const data = initialData(targets);
  data.platform = platform;
  return {
    onSubmit,
    view: await render(
      <MemoryRouter>
        <BotForm
          isEdit
          botId="bot-1"
          canManageCosInside={canManageCosInside}
          initialData={data}
          submitLabel="Save Changes"
          onSubmit={onSubmit}
        />
      </MemoryRouter>,
    ),
  };
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      const query = url.searchParams.get("query") ?? "";
      const subjects = groups.filter(
        (group) =>
          !query ||
          group.id === query ||
          group.name.toLowerCase().includes(query.toLowerCase()) ||
          group.username.includes(query.toLowerCase()),
      );
      return Response.json({ ok: true, subjects });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("hydrates stored relay targets, preserves unresolved IDs, and omits untouched config", async () => {
  const onSubmit = vi.fn(async (_data: BotFormData) => undefined);
  await renderForm({
    onSubmit,
    targets: [
      { alias: "ops", chatId: -1001 },
      { alias: "legacy", chatId: -1999 },
    ],
  });

  await expect.element(page.getByLabelText("Alias").nth(0)).toHaveValue("ops");
  await expect
    .element(page.getByRole("combobox", { name: "Relay group 1" }))
    .toHaveTextContent("Build Room");
  await expect
    .element(page.getByRole("combobox", { name: "Relay group 2" }))
    .toHaveTextContent("Group -1999");

  await page.getByRole("button", { name: "Save Changes" }).click();
  expect(onSubmit).toHaveBeenCalledOnce();
  expect(onSubmit.mock.calls[0]![0]).not.toHaveProperty("cosInsideConfig");
});

test("saves target changes and an empty target list used to disable relaying", async () => {
  const onSubmit = vi.fn(async (_data: BotFormData) => undefined);
  const { view } = await renderForm({ onSubmit });

  await page.getByLabelText("Alias").fill("announcements");
  await page.getByRole("button", { name: "Save Changes" }).click();
  expect(onSubmit).toHaveBeenLastCalledWith(
    expect.objectContaining({
      cosInsideConfig: { targets: [{ alias: "announcements", chatId: -1001 }] },
    }),
  );

  await view.rerender(
    <MemoryRouter>
      <BotForm
        key="fresh-form"
        isEdit
        botId="bot-1"
        canManageCosInside
        initialData={initialData()}
        submitLabel="Save Changes"
        onSubmit={onSubmit}
      />
    </MemoryRouter>,
  );
  await page.getByRole("button", { name: "Remove relay target 1" }).click();
  await page.getByRole("button", { name: "Save Changes" }).click();
  expect(onSubmit).toHaveBeenLastCalledWith(
    expect.objectContaining({ cosInsideConfig: { targets: [] } }),
  );
});

test("rejects malformed and case-insensitive duplicate aliases", async () => {
  const onSubmit = vi.fn(async (_data: BotFormData) => undefined);
  await renderForm({
    onSubmit,
    targets: [
      { alias: "ops", chatId: -1001 },
      { alias: "release", chatId: -1002 },
    ],
  });

  await page.getByLabelText("Alias").nth(0).fill("bad alias");
  await page.getByLabelText("Alias").nth(1).fill("BAD ALIAS");
  await page.getByRole("button", { name: "Save Changes" }).click();
  await expect
    .element(page.getByText("Use 1–32 letters, numbers, hyphens, or underscores.").nth(0))
    .toBeVisible();
  expect(onSubmit).not.toHaveBeenCalled();

  await page.getByLabelText("Alias").nth(0).fill("Ops");
  await page.getByLabelText("Alias").nth(1).fill("ops");
  await page.getByRole("button", { name: "Save Changes" }).click();
  await expect
    .element(page.getByText("Aliases must be unique (ignoring letter case)."))
    .toBeVisible();
  expect(onSubmit).not.toHaveBeenCalled();
});

test("requires selecting an observed group for a new target", async () => {
  const onSubmit = vi.fn(async (_data: BotFormData) => undefined);
  await renderForm({ onSubmit, targets: [] });

  await page.getByRole("button", { name: "Add target" }).click();
  await page.getByLabelText("Alias").fill("ops");
  await page.getByRole("button", { name: "Save Changes" }).click();
  await expect.element(page.getByText("Select a valid Telegram group.")).toBeVisible();
  expect(onSubmit).not.toHaveBeenCalled();

  await page.getByRole("combobox", { name: "Relay group 1" }).click();
  await page.getByRole("option", { name: /Build Room/ }).click();
  expect(
    vi
      .mocked(fetch)
      .mock.calls.some(([input]) => String(input).includes("/cos-inside/groups?query=")),
  ).toBe(true);
  await page.getByRole("button", { name: "Save Changes" }).click();
  expect(onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({ cosInsideConfig: { targets: [{ alias: "ops", chatId: -1001 }] } }),
  );
});

test("fails closed for non-managers and never shows relay targets for Lark", async () => {
  const editorSubmit = vi.fn(async (_data: BotFormData) => undefined);
  const { view } = await renderForm({ onSubmit: editorSubmit, canManageCosInside: false });
  expect(document.body.textContent).not.toContain("Private relay targets");
  await page.getByRole("button", { name: "Save Changes" }).click();
  expect(editorSubmit.mock.calls[0]![0]).not.toHaveProperty("cosInsideConfig");

  await view.rerender(
    <MemoryRouter>
      <BotForm
        key="lark-form"
        isEdit
        botId="bot-2"
        canManageCosInside
        initialData={{
          ...initialData(),
          platform: "lark-webhook",
          webhookUrl: "https://open.feishu.cn/hook/test",
        }}
        submitLabel="Save Changes"
        onSubmit={vi.fn(async () => undefined)}
      />
    </MemoryRouter>,
  );
  expect(document.body.textContent).not.toContain("Private relay targets");
});

test("retains the relay draft and shows an error after a failed save", async () => {
  await renderForm({ onSubmit: vi.fn(async () => Promise.reject(new Error("offline"))) });
  await page.getByLabelText("Alias").fill("alerts");
  await page.getByRole("button", { name: "Save Changes" }).click();

  await expect.element(page.getByRole("alert")).toHaveTextContent("Could not save changes");
  await expect.element(page.getByLabelText("Alias")).toHaveValue("alerts");
});

test("shows create-first guidance instead of an unbound group picker", async () => {
  await render(
    <BotForm canManageCosInside submitLabel="Create Bot" onSubmit={vi.fn(async () => undefined)} />,
  );
  await expect
    .element(
      page.getByText("Create the Bot first, then edit it to select groups the Bot has joined."),
    )
    .toBeVisible();
  expect(page.getByRole("button", { name: "Add target" }).query()).toBeNull();
});
