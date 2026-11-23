import { i18n } from "@/i18n";
import "@/style.css";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SettingsPage } from "./settings";
import { defaultAsrAccounts } from "@cos-tool-bot/shared";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/client", () => ({ authFetch: mocks.fetch }));

let role: string;
const me = {
  user: { id: "owner-user", name: "Test Owner", email: "owner@example.test" },
  member: { id: "owner-member", role: "owner" },
  organization: { id: "workspace", name: "Hanori workspace" },
};
let members: { id: string; userId: string; name: string; email: string; role: string }[];
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

beforeEach(async () => {
  await i18n.changeLanguage("en");
  await page.viewport(1440, 900);
  role = "owner";
  members = [
    {
      id: "owner-member",
      userId: "owner-user",
      name: "Test Owner",
      email: "owner@example.test",
      role: "owner",
    },
    {
      id: "editor-member",
      userId: "editor-user",
      name: "Test Editor",
      email: "editor@example.test",
      role: "editor",
    },
  ];
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string) => {
    if (path === "/api/authz/me")
      return response({ data: { ...me, member: { ...me.member, role } } });
    if (path === "/api/authz/members") return response({ data: members });
    if (path === "/api/authz/invitations") return response({ data: [] });
    if (path === "/api/asr/settings")
      return response({
        ok: true,
        data: {
          revision: 0,
          accounts: defaultAsrAccounts().map((account) => ({ ...account, configuredSecrets: [] })),
        },
      });
    return response({ ok: true });
  });
});

afterEach(async () => {
  await page.viewport(1440, 900);
  vi.restoreAllMocks();
});

test("replaces the initial loading status with an accessible server error", async () => {
  let finish: ((value: Response) => void) | undefined;
  mocks.fetch.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  await render(<SettingsPage />);
  await expect.element(page.getByRole("status")).toHaveTextContent("Loading settings");
  finish!(response({ error: "Settings are temporarily unavailable" }, 500));
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Settings are temporarily unavailable");
  await expect.element(page.getByRole("status")).not.toBeInTheDocument();
});

test("limits settings content and list requests to the current membership role", async () => {
  role = "viewer";
  await render(<SettingsPage />);
  await expect.element(page.getByRole("heading", { name: "Sign-in & security" })).toBeVisible();
  await expect
    .element(page.getByRole("heading", { name: "A space to share" }))
    .not.toBeInTheDocument();
  await expect.element(page.getByRole("heading", { name: "Organization" })).not.toBeInTheDocument();
  expect(mocks.fetch.mock.calls.map(([path]) => path)).toEqual(["/api/authz/me"]);
});

test("keeps admin membership options and owner-only reset controls distinct", async () => {
  role = "admin";
  await render(<SettingsPage />);
  await expect.element(page.getByText("Test Editor", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Reset password" }))
    .not.toBeInTheDocument();
  await page.getByRole("combobox", { name: "Role for Test Editor" }).click();
  await expect.element(page.getByRole("option", { name: "Editor", exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("option", { name: "Admin", exact: true }))
    .not.toBeInTheDocument();
});

test("focuses the mismatched password and makes the error available to the field", async () => {
  await render(<SettingsPage />);
  await page.getByLabelText("Current password", { exact: true }).fill("old-password");
  await page.getByLabelText("New password", { exact: true }).fill("new-password");
  const confirmation = page.getByLabelText("Confirm new password", { exact: true });
  await confirmation.fill("other-password");
  await page.getByRole("button", { name: "Change password", exact: true }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Passwords do not match");
  await expect.element(confirmation).toHaveFocus();
  await expect.element(confirmation).toHaveAttribute("aria-invalid", "true");
  expect(confirmation.element().getAttribute("aria-describedby")).toBe("settings-error");
  expect(mocks.fetch.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
});

test("shows a pending password request, prevents repeat submits and clears inputs only on success", async () => {
  let finish: ((value: Response) => void) | undefined;
  const existing = mocks.fetch.getMockImplementation()!;
  mocks.fetch.mockImplementation((path: string, options?: RequestInit) =>
    path === "/api/auth/change-password"
      ? new Promise<Response>((resolve) => {
          finish = resolve;
        })
      : existing(path, options),
  );
  await render(<SettingsPage />);
  await page.getByLabelText("Current password", { exact: true }).fill("old-password");
  await page.getByLabelText("New password", { exact: true }).fill("new-password");
  await page.getByLabelText("Confirm new password", { exact: true }).fill("new-password");
  const save = page.getByRole("button", { name: "Change password", exact: true });
  await save.click();
  await expect.element(save).toBeDisabled();
  await expect.element(save).toHaveAttribute("aria-busy", "true");
  expect(
    mocks.fetch.mock.calls.filter(([path]) => path === "/api/auth/change-password"),
  ).toHaveLength(1);
  const request = mocks.fetch.mock.calls.find(([path]) => path === "/api/auth/change-password")![1];
  expect(JSON.parse(request.body)).toMatchObject({
    currentPassword: "old-password",
    newPassword: "new-password",
    revokeOtherSessions: true,
  });
  finish!(response({ ok: true }));
  await expect.element(page.getByRole("status")).toHaveTextContent("Password updated");
  await expect.element(save).not.toBeDisabled();
  await expect.element(page.getByLabelText("New password", { exact: true })).toHaveValue("");
});

test("preserves password inputs when a request fails and announces the error", async () => {
  const existing = mocks.fetch.getMockImplementation()!;
  mocks.fetch.mockImplementation((path: string, options?: RequestInit) =>
    path === "/api/auth/change-password"
      ? Promise.reject(new Error("synthetic network failure"))
      : existing(path, options),
  );
  await render(<SettingsPage />);
  await page.getByLabelText("Current password", { exact: true }).fill("old-password");
  await page.getByLabelText("New password", { exact: true }).fill("new-password");
  await page.getByLabelText("Confirm new password", { exact: true }).fill("new-password");
  await page.getByRole("button", { name: "Change password", exact: true }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Operation failed");
  await expect
    .element(page.getByLabelText("New password", { exact: true }))
    .toHaveValue("new-password");
  await expect
    .element(page.getByRole("button", { name: "Change password", exact: true }))
    .not.toBeDisabled();
});

test("creates an invitation with the chosen role and shows the generated link if copying fails", async () => {
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("clipboard unavailable"));
  const existing = mocks.fetch.getMockImplementation()!;
  mocks.fetch.mockImplementation((path: string, options?: RequestInit) =>
    path === "/api/authz/invitations" && options?.method === "POST"
      ? Promise.resolve(
          response({ data: { link: "https://example.test/accept-invitation?token=preview" } }),
        )
      : existing(path, options),
  );
  await render(<SettingsPage />);
  await page.getByLabelText("Email", { exact: true }).fill("new-member@example.test");
  await page.getByRole("combobox", { name: "Role", exact: true }).click();
  await page.getByRole("option", { name: "Editor", exact: true }).click();
  await page.getByRole("button", { name: "Generate and copy link", exact: true }).click();
  await expect.element(page.getByRole("status")).toHaveTextContent("Copy it below");
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("https://example.test/accept-invitation?token=preview");
  const request = mocks.fetch.mock.calls.find(
    ([path, options]) => path === "/api/authz/invitations" && options?.method === "POST",
  )![1];
  expect(JSON.parse(request.body)).toEqual({ email: "new-member@example.test", role: "editor" });
});

test("keeps mobile inputs through language changes and supports long member identities", async () => {
  await page.viewport(320, 844);
  members[1]!.name = "A member with a particularly long display name";
  members[1]!.email = "averylongaddressfortheworkspace@example.test";
  await render(<SettingsPage />);
  await page.getByLabelText("Current password", { exact: true }).fill("old-password");
  await i18n.changeLanguage("zh-CN");
  await expect
    .element(page.getByLabelText("当前密码", { exact: true }))
    .toHaveValue("old-password");
  await expect
    .element(page.getByRole("heading", { name: "一起使用花织", exact: true }))
    .toBeVisible();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
});
