import { i18n } from "@/i18n";
import { act } from "react";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { Link, MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { BotConversationsPage } from ".";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const conversation = (chatId: number, name: string, overrides: Record<string, unknown> = {}) => ({
  chatId,
  messageCount: 1,
  lastActive: "2026-09-22T08:30:00.000Z",
  firstActive: "2026-09-22T08:00:00.000Z",
  chatType: "private" as const,
  roleCounts: { user: 1, assistant: 0, tool_call: 0, tool_result: 0, system: 0, context: 0 },
  distinctUserCount: 1,
  userNames: [name],
  lastMessage: { content: `${name} preview`, role: "user", userName: name },
  hasSummaries: true,
  summaryCount: 1,
  ...overrides,
});

const message = (id: number, content: string) => ({
  id,
  role: "user",
  content,
  userId: 42,
  userName: "Fixture user",
  meta: {},
  createdAt: "2026-09-22T08:30:00.000Z",
});

const summary = (id: number, content: string, isActive = false) => ({
  id,
  content,
  previousSummarizedUpToId: null,
  summarizedUpToId: 10,
  messageCount: 10,
  createdAt: "2026-09-22T08:31:00.000Z",
  isActive,
});

function requestParts(input: RequestInfo | URL, init?: RequestInit) {
  const request = input instanceof Request ? input : null;
  const url = new URL(request?.url ?? String(input), window.location.origin);
  return { url, method: (init?.method ?? request?.method ?? "GET").toUpperCase() };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function renderPage({
  initialEntry = "/bots/test-id/conversations",
  navigation = false,
}: { initialEntry?: string; navigation?: boolean } = {}) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      {navigation ? (
        <nav aria-label="Test bot navigation">
          <Link to="/bots/bot-a/conversations">Open bot A</Link>
          <Link to="/bots/bot-b/conversations">Open bot B</Link>
        </nav>
      ) : null}
      <Routes>
        <Route path="/bots/:botId/conversations" element={<BotConversationsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function countRequests(fetchMock: ReturnType<typeof vi.fn>, method: string, pathname: string) {
  return fetchMock.mock.calls.filter(([input, init]) => {
    const request = requestParts(input as RequestInfo | URL, init as RequestInit | undefined);
    return request.method === method && request.url.pathname === pathname;
  }).length;
}

async function selectConversation(name: string) {
  await expect.element(page.getByRole("button", { name: new RegExp(name) })).toBeVisible();
  await page.getByRole("button", { name: new RegExp(name) }).click();
}

async function confirmMessageDelete() {
  await page.getByRole("button", { name: "Delete this message" }).click();
  await page.getByRole("button", { name: "Confirm deleting this message" }).click();
}

async function openSummaries() {
  await page.getByRole("tab", { name: /Summaries/ }).click();
}

async function confirmSummaryDelete() {
  await page.getByRole("button", { name: "Delete this summary" }).click();
  await page.getByRole("button", { name: "Confirm deleting this summary" }).click();
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("conversation reads", () => {
  test("distinguishes list failures from a confirmed empty result and retries each failure shape", async () => {
    let attempt = 0;
    const fetchMock = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) return jsonResponse({ ok: false, error: "down" }, 500);
      if (attempt === 2) return new Response("{", { status: 200 });
      if (attempt === 3) return jsonResponse({ ok: false, error: "application failure" });
      return jsonResponse({ ok: true, data: [], total: 0 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    for (let expectedAttempt = 1; expectedAttempt <= 3; expectedAttempt += 1) {
      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("Could not load conversations.");
      expect(attempt).toBe(expectedAttempt);
      await page.getByRole("button", { name: "Retry" }).click();
    }

    await expect.element(page.getByText("No conversations yet", { exact: true })).toBeVisible();
    expect(attempt).toBe(4);
  });

  test("shows a message application error until retry confirms the true empty state", async () => {
    let messageAttempt = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { url } = requestParts(input, init);
      if (url.pathname.endsWith("/conversations")) {
        return jsonResponse({ ok: true, data: [conversation(101, "Chat one")], total: 1 });
      }
      messageAttempt += 1;
      if (messageAttempt === 1) return jsonResponse({ ok: false, error: "application failure" });
      return jsonResponse({ ok: true, data: [], total: 0 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await selectConversation("Chat one");
    await expect.element(page.getByRole("alert")).toHaveTextContent("Could not load messages.");
    await expect.element(page.getByText("No messages", { exact: true })).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Retry" }).click();

    await expect.element(page.getByText("No messages", { exact: true })).toBeVisible();
    expect(messageAttempt).toBe(2);
  });

  test.each(["list", "message", "summary"] as const)(
    "offers a return to page one when an uncached later %s page fails",
    async (resource) => {
      let firstPageReads = 0;
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const { url } = requestParts(input, init);
        const requestedPage = url.searchParams.get("page");
        if (url.pathname.endsWith("/conversations")) {
          if (resource === "list" && requestedPage === "2") {
            return jsonResponse({ ok: false, error: "page failed" }, 500);
          }
          if (resource === "list") firstPageReads += 1;
          return jsonResponse({
            ok: true,
            data: [conversation(101, "Page one chat")],
            total: resource === "list" ? 21 : 1,
          });
        }
        if (url.pathname.endsWith("/summaries")) {
          if (resource === "summary" && requestedPage === "2") {
            return jsonResponse({ ok: false, error: "page failed" }, 500);
          }
          if (resource === "summary") firstPageReads += 1;
          return jsonResponse({
            ok: true,
            data: [summary(1, "First-page summary")],
            total: resource === "summary" ? 21 : 1,
          });
        }
        if (resource === "message" && requestedPage === "2") {
          return jsonResponse({ ok: false, error: "page failed" }, 500);
        }
        if (resource === "message") firstPageReads += 1;
        return jsonResponse({
          ok: true,
          data: [message(1, "First-page message")],
          total: resource === "message" ? 51 : 1,
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      renderPage();
      if (resource === "list") {
        await expect.element(page.getByRole("button", { name: /Page one chat/ })).toBeVisible();
      } else {
        await selectConversation("Page one chat");
        if (resource === "summary") {
          await openSummaries();
          await expect.element(page.getByText("First-page summary", { exact: true })).toBeVisible();
        } else {
          await expect.element(page.getByText("First-page message", { exact: true })).toBeVisible();
        }
      }
      await page.getByRole("button", { name: "Next page" }).click();
      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent(
          resource === "list"
            ? "Could not load conversations."
            : resource === "message"
              ? "Could not load messages."
              : "Could not load summaries.",
        );

      await page.getByRole("button", { name: "Back to first page" }).click();
      if (resource === "list") {
        await expect.element(page.getByRole("button", { name: /Page one chat/ })).toBeVisible();
      } else {
        await expect
          .element(
            page.getByText(resource === "message" ? "First-page message" : "First-page summary", {
              exact: true,
            }),
          )
          .toBeVisible();
      }
      expect(firstPageReads).toBe(2);
    },
  );

  test("shows a summary network error until retry confirms the true empty state", async () => {
    let summaryAttempt = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { url } = requestParts(input, init);
      if (url.pathname.endsWith("/conversations")) {
        return jsonResponse({ ok: true, data: [conversation(101, "Chat one")], total: 1 });
      }
      if (url.pathname.endsWith("/conversations/101")) {
        return jsonResponse({ ok: true, data: [message(1, "Loaded message")], total: 1 });
      }
      summaryAttempt += 1;
      if (summaryAttempt === 1) throw new TypeError("fixture network failure");
      return jsonResponse({ ok: true, data: [], total: 0 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await selectConversation("Chat one");
    await expect.element(page.getByText("Loaded message", { exact: true })).toBeVisible();
    await openSummaries();
    await expect.element(page.getByRole("alert")).toHaveTextContent("Could not load summaries.");
    await expect
      .element(page.getByText("No compressed summaries", { exact: true }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "Retry" }).click();

    await expect.element(page.getByText("No compressed summaries", { exact: true })).toBeVisible();
    expect(summaryAttempt).toBe(2);
  });

  test("keeps the last successful rows visible when manual refreshes fail", async () => {
    const attempts = { list: 0, messages: 0, summaries: 0 };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { url } = requestParts(input, init);
      if (url.pathname.endsWith("/conversations")) {
        attempts.list += 1;
        if (attempts.list > 1) return jsonResponse({ ok: false }, 500);
        return jsonResponse({ ok: true, data: [conversation(101, "Chat one")], total: 21 });
      }
      if (url.pathname.endsWith("/summaries")) {
        attempts.summaries += 1;
        if (attempts.summaries > 1) return jsonResponse({ ok: false }, 500);
        return jsonResponse({ ok: true, data: [summary(9, "Loaded summary")], total: 1 });
      }
      attempts.messages += 1;
      if (attempts.messages > 1) return jsonResponse({ ok: false }, 500);
      return jsonResponse({ ok: true, data: [message(8, "Loaded message")], total: 1 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await expect.element(page.getByRole("button", { name: /Chat one/ })).toBeVisible();
    await page.getByRole("button", { name: "Refresh conversations" }).click();
    await expect.element(page.getByRole("button", { name: /Chat one/ })).toBeVisible();
    await expect
      .element(page.getByLabelText("Conversation list").getByRole("alert"))
      .toHaveTextContent("Could not load conversations.");
    await expect
      .element(page.getByLabelText("Conversation list").getByRole("alert"))
      .toHaveTextContent("Showing previously loaded data. It may be out of date.");
    await expect.element(page.getByRole("button", { name: "Next page" })).toBeVisible();

    await selectConversation("Chat one");
    await expect.element(page.getByText("Loaded message", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Refresh messages" }).click();
    await expect.element(page.getByText("Loaded message", { exact: true })).toBeVisible();
    await expect
      .element(page.getByLabelText("Conversation details").getByRole("alert"))
      .toHaveTextContent("Could not load messages.");
    await expect
      .element(page.getByLabelText("Conversation details").getByRole("alert"))
      .toHaveTextContent("Showing previously loaded data. It may be out of date.");

    await openSummaries();
    await expect.element(page.getByText("Loaded summary", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Refresh summaries" }).click();
    await expect.element(page.getByText("Loaded summary", { exact: true })).toBeVisible();
    await expect
      .element(page.getByLabelText("Conversation details").getByRole("alert"))
      .toHaveTextContent("Could not load summaries.");
    await expect
      .element(page.getByLabelText("Conversation details").getByRole("alert"))
      .toHaveTextContent("Showing previously loaded data. It may be out of date.");
  });

  test("ignores a late message success after selecting another chat", async () => {
    const oldRequest = deferred<Response>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { url } = requestParts(input, init);
      if (url.pathname.endsWith("/conversations")) {
        return jsonResponse({
          ok: true,
          data: [conversation(101, "Chat one"), conversation(202, "Chat two")],
          total: 2,
        });
      }
      if (url.pathname.endsWith("/conversations/101")) return oldRequest.promise;
      return jsonResponse({ ok: true, data: [message(2, "Current chat message")], total: 1 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await selectConversation("Chat one");
    await selectConversation("Chat two");
    await expect.element(page.getByText("Current chat message", { exact: true })).toBeVisible();
    await act(async () => {
      oldRequest.resolve(jsonResponse({ ok: true, data: [message(1, "Stale message")], total: 1 }));
      await oldRequest.promise;
    });

    await vi.waitFor(() =>
      expect(page.getByText("Stale message", { exact: true }).query()).toBeNull(),
    );
    await expect.element(page.getByText("Current chat message", { exact: true })).toBeVisible();
    expect(page.getByRole("alert").query()).toBeNull();
  });

  test("ignores a late page response after bot navigation and returning to page one", async () => {
    const oldPage = deferred<Response>();
    let botAPageOneAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { url } = requestParts(input, init);
      if (url.pathname.includes("/bot-b/")) {
        return jsonResponse({ ok: true, data: [conversation(301, "Bot B chat")], total: 1 });
      }
      const requestedPage = url.searchParams.get("page");
      if (requestedPage === "2") return oldPage.promise;
      botAPageOneAttempts += 1;
      return jsonResponse({ ok: true, data: [conversation(101, "Bot A page one")], total: 21 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage({ initialEntry: "/bots/bot-a/conversations", navigation: true });
    await expect.element(page.getByRole("button", { name: /Bot A page one/ })).toBeVisible();
    await page.getByRole("button", { name: "Next page" }).click();
    await page.getByRole("link", { name: "Open bot B" }).click();
    await expect.element(page.getByRole("button", { name: /Bot B chat/ })).toBeVisible();
    await page.getByRole("link", { name: "Open bot A" }).click();
    await expect.element(page.getByRole("button", { name: /Bot A page one/ })).toBeVisible();
    await act(async () => {
      oldPage.resolve(
        jsonResponse({ ok: true, data: [conversation(121, "Stale page two")], total: 21 }),
      );
      await oldPage.promise;
    });

    await vi.waitFor(() => expect(page.getByText("Stale page two").query()).toBeNull());
    await expect.element(page.getByRole("button", { name: /Bot A page one/ })).toBeVisible();
    expect(botAPageOneAttempts).toBe(2);
  });

  test("ignores a late list error from the previous bot", async () => {
    const oldList = deferred<Response>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { url } = requestParts(input, init);
      if (url.pathname.includes("/bot-a/")) return oldList.promise;
      return jsonResponse({ ok: true, data: [conversation(301, "Bot B chat")], total: 1 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage({ initialEntry: "/bots/bot-a/conversations", navigation: true });
    await page.getByRole("link", { name: "Open bot B" }).click();
    await expect.element(page.getByRole("button", { name: /Bot B chat/ })).toBeVisible();
    await act(async () => {
      oldList.reject(new TypeError("late bot A failure"));
      await oldList.promise.catch(() => undefined);
    });

    await vi.waitFor(() => expect(page.getByRole("alert").query()).toBeNull());
    await expect.element(page.getByRole("button", { name: /Bot B chat/ })).toBeVisible();
  });
});

describe("conversation deletion recovery", () => {
  test("keeps a message and locks repeated deletion after an HTTP failure until refresh", async () => {
    let messageReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { url, method } = requestParts(input, init);
      if (url.pathname.endsWith("/conversations")) {
        return jsonResponse({ ok: true, data: [conversation(101, "Chat one")], total: 1 });
      }
      if (method === "DELETE") return jsonResponse({ ok: false }, 500);
      messageReads += 1;
      return jsonResponse({ ok: true, data: [message(8, "Keep this message")], total: 1 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await selectConversation("Chat one");
    await confirmMessageDelete();
    await expect.element(page.getByText("Keep this message", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(
        "Could not confirm deletion. Refresh to check the result before deleting again.",
      );
    expect(
      countRequests(fetchMock, "DELETE", "/api/bots/test-id/conversations/101/messages/8"),
    ).toBe(1);
    await expect.element(page.getByRole("button", { name: "Delete this message" })).toBeDisabled();

    await page.getByRole("button", { name: "Refresh and check" }).click();
    await expect.element(page.getByRole("button", { name: "Delete this message" })).toBeEnabled();
    expect(messageReads).toBe(2);
    expect(
      countRequests(fetchMock, "DELETE", "/api/bots/test-id/conversations/101/messages/8"),
    ).toBe(1);
  });

  test.each([
    ["application failure", () => jsonResponse({ ok: false, error: "not confirmed" })],
    ["network failure", () => Promise.reject(new TypeError("fixture network failure"))],
  ])("keeps a summary after %s and requires refresh before retry", async (_label, failure) => {
    let summaryReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { url, method } = requestParts(input, init);
      if (url.pathname.endsWith("/conversations")) {
        return jsonResponse({ ok: true, data: [conversation(101, "Chat one")], total: 1 });
      }
      if (url.pathname.endsWith("/conversations/101")) {
        return jsonResponse({ ok: true, data: [message(1, "Loaded message")], total: 1 });
      }
      if (method === "DELETE") return failure();
      summaryReads += 1;
      return jsonResponse({ ok: true, data: [summary(9, "Keep this summary")], total: 1 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await selectConversation("Chat one");
    await openSummaries();
    await confirmSummaryDelete();
    await expect.element(page.getByText("Keep this summary", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(
        "Could not confirm deletion. Refresh to check the result before deleting again.",
      );
    expect(
      countRequests(fetchMock, "DELETE", "/api/bots/test-id/conversations/101/summaries/9"),
    ).toBe(1);
    await expect.element(page.getByRole("button", { name: "Delete this summary" })).toBeDisabled();

    await page.getByRole("button", { name: "Refresh and check" }).click();
    await expect.element(page.getByRole("button", { name: "Delete this summary" })).toBeEnabled();
    expect(summaryReads).toBe(2);
    expect(
      countRequests(fetchMock, "DELETE", "/api/bots/test-id/conversations/101/summaries/9"),
    ).toBe(1);
  });

  test("reports a successful message deletion separately when the confirming refresh fails", async () => {
    let messageReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { url, method } = requestParts(input, init);
      if (url.pathname.endsWith("/conversations")) {
        return jsonResponse({ ok: true, data: [conversation(101, "Chat one")], total: 1 });
      }
      if (method === "DELETE") return jsonResponse({ ok: true });
      messageReads += 1;
      if (messageReads === 1) {
        return jsonResponse({ ok: true, data: [message(8, "Delete this content")], total: 1 });
      }
      return jsonResponse({ ok: false }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await selectConversation("Chat one");
    await confirmMessageDelete();

    await expect
      .element(
        page.getByText("Deleted, but the displayed data could not be refreshed.", { exact: true }),
      )
      .toBeVisible();
    expect(
      countRequests(fetchMock, "DELETE", "/api/bots/test-id/conversations/101/messages/8"),
    ).toBe(1);
    await page.getByRole("button", { name: "Refresh and check" }).click();
    expect(
      countRequests(fetchMock, "DELETE", "/api/bots/test-id/conversations/101/messages/8"),
    ).toBe(1);
  });

  test("checks the original failed-delete chat before unlocking writes after navigation", async () => {
    let chatAReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { url, method } = requestParts(input, init);
      if (url.pathname.endsWith("/conversations")) {
        return jsonResponse({
          ok: true,
          data: [conversation(101, "Chat A"), conversation(202, "Chat B")],
          total: 2,
        });
      }
      if (method === "DELETE") return jsonResponse({ ok: false }, 500);
      if (url.pathname.endsWith("/conversations/101")) {
        chatAReads += 1;
        if (chatAReads > 1) return jsonResponse({ ok: false }, 500);
        return jsonResponse({ ok: true, data: [message(8, "Chat A message")], total: 1 });
      }
      return jsonResponse({ ok: true, data: [message(9, "Chat B message")], total: 1 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await selectConversation("Chat A");
    await confirmMessageDelete();
    await expect.element(page.getByRole("button", { name: /Chat B/ })).toBeEnabled();
    await selectConversation("Chat B");
    await expect.element(page.getByText("Chat B message", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Delete this message" })).toBeDisabled();

    await page.getByRole("button", { name: "Refresh and check" }).click();
    await vi.waitFor(() => expect(chatAReads).toBe(2));
    await expect.element(page.getByRole("button", { name: "Delete this message" })).toBeDisabled();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(
        "Could not confirm deletion. Refresh to check the result before deleting again.",
      );
    expect(
      countRequests(fetchMock, "DELETE", "/api/bots/test-id/conversations/101/messages/8"),
    ).toBe(1);
    expect(countRequests(fetchMock, "GET", "/api/bots/test-id/conversations/202")).toBe(2);
  });

  test("refreshes a 409 summary into its active state without another delete", async () => {
    let summaryReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { url, method } = requestParts(input, init);
      if (url.pathname.endsWith("/conversations")) {
        return jsonResponse({ ok: true, data: [conversation(101, "Chat one")], total: 1 });
      }
      if (url.pathname.endsWith("/conversations/101")) {
        return jsonResponse({ ok: true, data: [message(1, "Loaded message")], total: 1 });
      }
      if (method === "DELETE") return jsonResponse({ ok: false, error: "active" }, 409);
      summaryReads += 1;
      return jsonResponse({
        ok: true,
        data: [summary(9, "Summary became active", summaryReads > 1)],
        total: 1,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await selectConversation("Chat one");
    await openSummaries();
    await confirmSummaryDelete();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("The active summary cannot be deleted.");
    await page.getByRole("button", { name: "Refresh and check" }).click();

    await expect.element(page.getByText("Active", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: /active summary cannot be deleted/i }))
      .toBeDisabled();
    expect(
      countRequests(fetchMock, "DELETE", "/api/bots/test-id/conversations/101/summaries/9"),
    ).toBe(1);
  });

  test.each(["message", "summary"] as const)(
    "returns to the effective page after deleting the only %s on the last page",
    async (kind) => {
      let deleted = false;
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const { url, method } = requestParts(input, init);
        if (url.pathname.endsWith("/conversations")) {
          return jsonResponse({ ok: true, data: [conversation(101, "Chat one")], total: 1 });
        }
        if (method === "DELETE") {
          deleted = true;
          return jsonResponse({ ok: true });
        }
        const requestedPage = url.searchParams.get("page");
        if (url.pathname.endsWith("/summaries")) {
          if (requestedPage === "2") {
            return jsonResponse({
              ok: true,
              data: deleted ? [] : [summary(21, "Last-page summary")],
              total: deleted ? 20 : 21,
            });
          }
          return jsonResponse({
            ok: true,
            data: [summary(1, "Earlier summary")],
            total: deleted ? 20 : 21,
          });
        }
        if (kind === "summary") {
          return jsonResponse({ ok: true, data: [message(1, "Loaded message")], total: 1 });
        }
        if (requestedPage === "2") {
          return jsonResponse({
            ok: true,
            data: deleted ? [] : [message(51, "Last-page message")],
            total: deleted ? 50 : 51,
          });
        }
        return jsonResponse({
          ok: true,
          data: [message(1, "Earlier message")],
          total: deleted ? 50 : 51,
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      renderPage();
      await selectConversation("Chat one");
      if (kind === "summary") {
        await openSummaries();
        await expect.element(page.getByText("Earlier summary", { exact: true })).toBeVisible();
      } else {
        await expect.element(page.getByText("Earlier message", { exact: true })).toBeVisible();
      }
      await page.getByRole("button", { name: "Next page" }).click();

      if (kind === "summary") {
        await expect.element(page.getByText("Last-page summary", { exact: true })).toBeVisible();
        await confirmSummaryDelete();
        await expect.element(page.getByText("Earlier summary", { exact: true })).toBeVisible();
        expect(
          countRequests(fetchMock, "DELETE", "/api/bots/test-id/conversations/101/summaries/21"),
        ).toBe(1);
      } else {
        await expect.element(page.getByText("Last-page message", { exact: true })).toBeVisible();
        await confirmMessageDelete();
        await expect.element(page.getByText("Earlier message", { exact: true })).toBeVisible();
        expect(
          countRequests(fetchMock, "DELETE", "/api/bots/test-id/conversations/101/messages/51"),
        ).toBe(1);
      }
      await expect.element(page.getByRole("status")).toHaveTextContent("Deleted.");
    },
  );

  test("sends one delete and disables chat, tab, and page navigation while it is pending", async () => {
    const deleteResponse = deferred<Response>();
    let chatAReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { url, method } = requestParts(input, init);
      if (url.pathname.endsWith("/conversations")) {
        return jsonResponse({
          ok: true,
          data: [conversation(101, "Chat A"), conversation(202, "Chat B")],
          total: 2,
        });
      }
      if (method === "DELETE") return deleteResponse.promise;
      if (url.pathname.endsWith("/conversations/101")) {
        chatAReads += 1;
        return jsonResponse({
          ok: true,
          data:
            chatAReads === 1
              ? [message(8, "Pending delete message")]
              : [message(9, "Remaining message")],
          total: chatAReads === 1 ? 51 : 50,
        });
      }
      return jsonResponse({ ok: true, data: [message(10, "Chat B message")], total: 1 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await selectConversation("Chat A");
    await page.getByRole("button", { name: "Delete this message" }).click();
    await page.getByRole("button", { name: "Confirm deleting this message" }).dblClick();
    await vi.waitFor(() =>
      expect(
        countRequests(fetchMock, "DELETE", "/api/bots/test-id/conversations/101/messages/8"),
      ).toBe(1),
    );

    await expect.element(page.getByRole("button", { name: /Chat B/ })).toBeDisabled();
    await expect.element(page.getByRole("tab", { name: /Summaries/ })).toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Next page" })).toBeDisabled();
    await expect
      .element(page.getByRole("button", { name: "Deleting this message" }))
      .toBeDisabled();

    deleteResponse.resolve(jsonResponse({ ok: true }));
    await expect.element(page.getByText("Remaining message", { exact: true })).toBeVisible();
    expect(
      countRequests(fetchMock, "DELETE", "/api/bots/test-id/conversations/101/messages/8"),
    ).toBe(1);
  });

  test("keeps a conversation when the delete response body is not successful", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { method } = requestParts(input, init);
      if (method === "DELETE") return jsonResponse({ ok: false, error: "not confirmed" });
      return jsonResponse({ ok: true, data: [conversation(101, "Chat one")], total: 1 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await expect.element(page.getByRole("button", { name: /Chat one/ })).toBeVisible();
    await page.getByRole("button", { name: "Delete conversation 101" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();

    await expect.element(page.getByRole("button", { name: /Chat one/ })).toBeVisible();
    await expect
      .element(page.getByRole("alertdialog"))
      .toHaveTextContent(
        "Could not confirm deletion. Refresh to check the result before deleting again.",
      );
    expect(countRequests(fetchMock, "DELETE", "/api/bots/test-id/conversations/101")).toBe(1);
  });

  test("keeps all conversations when clear-all returns an unsuccessful body", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { method } = requestParts(input, init);
      if (method === "DELETE") return jsonResponse({ ok: false, error: "not confirmed" });
      return jsonResponse({ ok: true, data: [conversation(101, "Chat one")], total: 1 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await expect.element(page.getByRole("button", { name: /Chat one/ })).toBeVisible();
    await page.getByRole("button", { name: "Clear all" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();

    await expect.element(page.getByRole("button", { name: /Chat one/ })).toBeVisible();
    await expect
      .element(page.getByRole("alertdialog"))
      .toHaveTextContent(
        "Could not confirm deletion. Refresh to check the result before deleting again.",
      );
    expect(countRequests(fetchMock, "DELETE", "/api/bots/test-id/conversations")).toBe(1);
  });
});
