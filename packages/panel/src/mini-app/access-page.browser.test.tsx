import { i18n } from "@/i18n";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AccessPage } from "./access-page";
import type { MiniAppSessionView } from "./session";
import "./i18n";

const BOT_ID = "00000000-0000-4000-8000-000000000001";
const SESSION: MiniAppSessionView = {
  user: { id: 42, firstName: "Ada" },
  role: "admin",
  capabilities: [],
  chatScope: { kind: "all" },
  expiresAt: 1_800_000_900,
  csrfToken: "csrf-token",
};

const CHAT = {
  chatId: -1001,
  type: "supergroup",
  title: "Build Room",
  username: "build_room",
  botMembershipStatus: "administrator",
  membershipObservedAt: "2026-07-01T00:00:00.000Z",
  lastObservedAt: "2026-07-26T00:00:00.000Z",
  leftAt: null,
  granted: false,
  grant: null,
} as const;

const OPERATOR = {
  telegramUserId: 77,
  username: "grace",
  displayName: "Grace Hopper",
  verified: true,
  createdBy: 42,
  note: "Release operator",
  createdAt: "2026-07-20T00:00:00.000Z",
} as const;

function accessResponse(input?: {
  chats?: unknown[];
  operators?: unknown[];
  activity?: unknown[];
}) {
  return Response.json({
    ok: true,
    bot: { username: "fixture_bot", displayName: "Fixture Bot" },
    chats: input?.chats ?? [CHAT],
    operators: input?.operators ?? [OPERATOR],
    activity: input?.activity ?? [
      {
        id: 1,
        actorTelegramUserId: 42,
        actorRole: "admin",
        action: "operator.grant.created",
        resourceType: "operator_grant",
        resourceId: "77",
        outcome: "success",
        createdAt: "2026-07-20T00:00:00.000Z",
      },
    ],
  });
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("renders the three admin access sections and the minimal-permission group link", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => accessResponse()),
  );

  render(<AccessPage botId={BOT_ID} session={SESSION} />);

  await expect.element(page.getByRole("heading", { name: "Access" })).toBeVisible();
  await expect.element(page.getByLabelText("Access summary")).toHaveTextContent("0/1");
  await expect.element(page.getByLabelText("Access summary")).toHaveTextContent("Operators1");
  await expect.element(page.getByRole("heading", { name: "Group grants" })).toBeVisible();
  await expect.element(page.getByRole("heading", { name: "Operators" })).toBeVisible();
  await expect.element(page.getByRole("heading", { name: "90-day activity" })).toBeVisible();
  await expect
    .element(page.getByRole("link", { name: /Add a group/ }))
    .toHaveAttribute("href", "https://t.me/fixture_bot?startgroup&admin=manage_chat+pin_messages");
});

test("filters activity across actor, action, and resource fields", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => accessResponse()),
  );
  render(<AccessPage botId={BOT_ID} session={SESSION} />);

  await expect.element(page.getByText("operator.grant.created")).toBeVisible();
  await page.getByLabelText("Actor").fill("42");
  await page.getByLabelText("Action").fill("grant");
  await page.getByLabelText("Resource").fill("operator 77");
  await expect.element(page.getByText("operator.grant.created")).toBeVisible();

  await page.getByLabelText("Resource").fill("chat");
  await expect.element(page.getByText("No activity matches this filter.")).toBeVisible();
});

test("allows a cached non-admin chat to trigger live verification", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => accessResponse({ chats: [{ ...CHAT, botMembershipStatus: "member" }] })),
  );
  render(<AccessPage botId={BOT_ID} session={SESSION} />);

  await expect
    .element(page.getByRole("button", { name: "Verify membership and grant" }))
    .toBeVisible();
});

test("projects people search results without rendering private profile fields", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input) => {
      if (String(input).includes("/people?")) {
        return Response.json({
          ok: true,
          people: [
            {
              telegramUserId: 88,
              username: "ada",
              displayName: "Ada Lovelace",
              lastSeen: "2026-07-26T00:00:00.000Z",
              note: "PRIVATE_NOTE",
              traits: ["PRIVATE_TRAIT"],
              interests: ["PRIVATE_INTEREST"],
            },
          ],
        });
      }
      return accessResponse({ operators: [] });
    }),
  );
  render(<AccessPage botId={BOT_ID} session={SESSION} />);

  await expect.element(page.getByRole("heading", { name: "Access" })).toBeVisible();
  await page.getByLabelText("Find a person").fill("ada");
  await expect.element(page.getByRole("option", { name: /Ada Lovelace/ })).toBeVisible();

  expect(document.body.textContent).not.toContain("PRIVATE_NOTE");
  expect(document.body.textContent).not.toContain("PRIVATE_TRAIT");
  expect(document.body.textContent).not.toContain("PRIVATE_INTEREST");
});

test("sends the Bot-scoped CSRF token and refetches after granting a chat", async () => {
  let listRequests = 0;
  let mutationInit: RequestInit | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      if (String(input).endsWith("/chat-grants")) {
        mutationInit = init;
        return Response.json({ ok: true });
      }
      listRequests += 1;
      return accessResponse({
        chats:
          listRequests === 1
            ? [CHAT]
            : [
                {
                  ...CHAT,
                  granted: true,
                  grant: {
                    createdBy: 42,
                    note: "Pilot group",
                    createdAt: "2026-07-27T00:00:00.000Z",
                  },
                },
              ],
      });
    }),
  );
  render(<AccessPage botId={BOT_ID} session={SESSION} />);

  await expect.element(page.getByRole("heading", { name: "Build Room" })).toBeVisible();
  await expect.element(page.getByLabelText("Note").first()).toHaveAttribute("maxlength", "200");
  await page.getByLabelText("Note").first().fill(" Pilot group ");
  await page.getByRole("button", { name: "Grant group access" }).click();
  await expect.element(page.getByRole("button", { name: "Revoke group grant" })).toBeVisible();

  expect(listRequests).toBe(2);
  expect(mutationInit).toMatchObject({
    method: "POST",
    credentials: "same-origin",
    headers: {
      "x-mini-app-csrf": "csrf-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ chatId: -1001, note: "Pilot group" }),
  });
});

test("requires explicit operator revocation confirmation and refetches after deletion", async () => {
  let listRequests = 0;
  let deleteInit: RequestInit | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      if (String(input).endsWith("/operator-grants/77")) {
        deleteInit = init;
        return Response.json({ ok: true });
      }
      listRequests += 1;
      return accessResponse({ operators: listRequests === 1 ? [OPERATOR] : [] });
    }),
  );
  render(<AccessPage botId={BOT_ID} session={SESSION} />);

  await expect.element(page.getByRole("heading", { name: "Grace Hopper" })).toBeVisible();
  await page.getByRole("button", { name: "Revoke operator" }).click();
  await expect
    .element(page.getByText("This person loses Operator access immediately."))
    .toBeVisible();
  await page.getByRole("button", { name: "Confirm revoke" }).click();
  await expect.element(page.getByText("No operators have been granted access.")).toBeVisible();

  expect(listRequests).toBe(2);
  expect(deleteInit).toMatchObject({
    method: "DELETE",
    credentials: "same-origin",
    headers: { "x-mini-app-csrf": "csrf-token" },
  });
});
