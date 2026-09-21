import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { i18n } from "@/i18n";
import "@/style.css";
import { BotMemoriesPage } from "./memories";

interface PendingRequest {
  url: URL;
  method: string;
  signal: AbortSignal | null;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}

let listRequests: PendingRequest[];
let mutationRequests: PendingRequest[];

const memory = (id: number, content: string, botId = "bot-a") => ({
  id,
  botId,
  telegramId: null,
  content,
  category: "fact",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
});

const listResponse = (
  data: ReturnType<typeof memory>[],
  { ok = true, status = 200, total = data.length } = {},
) =>
  new Response(JSON.stringify({ ok, data, total }), {
    status,
    headers: { "content-type": "application/json" },
  });

const mutationResponse = (ok = true, status = 200) =>
  new Response(JSON.stringify({ ok }), {
    status,
    headers: { "content-type": "application/json" },
  });

function requestDetails(input: RequestInfo | URL, init?: RequestInit) {
  const request = input instanceof Request ? input : null;
  return {
    url: new URL(request?.url ?? String(input), location.origin),
    method: request?.method ?? init?.method ?? "GET",
    signal: request?.signal ?? init?.signal ?? null,
  };
}

function TestRoutes() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate("/bots/bot-b/memories")}>
        Switch Bot
      </button>
      <Routes>
        <Route path="/bots/:botId/memories" element={<BotMemoriesPage />} />
      </Routes>
    </>
  );
}

function start(path = "/bots/bot-a/memories") {
  render(
    <MemoryRouter initialEntries={[path]}>
      <TestRoutes />
    </MemoryRouter>,
  );
}

async function resolveInitial(
  items: ReturnType<typeof memory>[] = [],
  total: number = items.length,
) {
  start();
  await vi.waitFor(() => expect(listRequests).toHaveLength(1));
  listRequests[0]!.resolve(listResponse(items, { total }));
  if (items.length > 0) {
    await expect.element(page.getByText(items[0]!.content, { exact: true })).toBeVisible();
  } else {
    await expect.element(page.getByText("No memories found.", { exact: true })).toBeVisible();
  }
}

beforeEach(async () => {
  listRequests = [];
  mutationRequests = [];
  await i18n.changeLanguage("en");
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const details = requestDetails(input, init);
      if (details.url.pathname.endsWith("/memories/meta")) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, data: { categories: ["fact"] } }), {
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return new Promise<Response>((resolve, reject) => {
        const pending = { ...details, resolve, reject };
        if (details.method === "GET") listRequests.push(pending);
        else mutationRequests.push(pending);
      });
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

for (const failure of ["http", "application", "network"] as const) {
  test(`shows and retries an initial ${failure} list error without an empty state`, async () => {
    start();
    await vi.waitFor(() => expect(listRequests).toHaveLength(1));
    if (failure === "network") listRequests[0]!.reject(new Error("offline"));
    else {
      listRequests[0]!.resolve(
        listResponse([], {
          ok: failure !== "application",
          status: failure === "http" ? 503 : 200,
        }),
      );
    }

    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Could not load records. Try again.");
    await expect
      .element(page.getByText("No memories found.", { exact: true }))
      .not.toBeInTheDocument();
    await expect.element(page.getByText("0 total", { exact: true })).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await vi.waitFor(() => expect(listRequests).toHaveLength(2));
    listRequests[1]!.resolve(listResponse([memory(1, "Recovered memory")]));
    await expect.element(page.getByText("Recovered memory", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  });
}

test("keeps current records and the creation success when its refresh fails", async () => {
  await resolveInitial([memory(1, "Existing memory")]);
  await page.getByRole("button", { name: "Add memory", exact: true }).click();
  await page.getByPlaceholder("Memory content…").fill("New memory");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await vi.waitFor(() => expect(mutationRequests).toHaveLength(1));
  mutationRequests[0]!.resolve(mutationResponse());
  await vi.waitFor(() => expect(listRequests).toHaveLength(2));
  listRequests[1]!.resolve(listResponse([], { ok: false, status: 503 }));

  await expect.element(page.getByText("Created.", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Existing memory", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Refresh failed. Showing the last loaded records.");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await vi.waitFor(() => expect(listRequests).toHaveLength(3));
  listRequests[2]!.resolve(listResponse([memory(2, "New memory"), memory(1, "Existing memory")]));
  await expect.element(page.getByText("New memory", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Created.", { exact: true })).toBeVisible();
});

test("does not present an empty list as confirmed while a creation refresh fails", async () => {
  await resolveInitial();
  await page.getByRole("button", { name: "Add memory", exact: true }).click();
  await page.getByPlaceholder("Memory content…").fill("New memory");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await vi.waitFor(() => expect(mutationRequests).toHaveLength(1));
  mutationRequests[0]!.resolve(mutationResponse());
  await vi.waitFor(() => expect(listRequests).toHaveLength(2));

  await expect
    .element(page.getByText("No memories found.", { exact: true }))
    .not.toBeInTheDocument();
  await expect.element(page.getByText("0 total", { exact: true })).not.toBeInTheDocument();
  listRequests[1]!.resolve(listResponse([], { ok: false, status: 503 }));

  await expect.element(page.getByText("Created.", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Refresh failed. Showing the last loaded records.");
  await expect
    .element(page.getByText("No memories found.", { exact: true }))
    .not.toBeInTheDocument();
  await expect.element(page.getByText("0 total", { exact: true })).not.toBeInTheDocument();
});

test("ignores late search results from an older query", async () => {
  await resolveInitial([memory(1, "Initial memory")]);
  const search = page.getByPlaceholder("Search memories…");
  await search.fill("old");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await vi.waitFor(() => expect(listRequests).toHaveLength(2));
  await search.fill("new");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await vi.waitFor(() => expect(listRequests).toHaveLength(3));

  listRequests[2]!.resolve(listResponse([memory(3, "New query result")]));
  await expect.element(page.getByText("New query result", { exact: true })).toBeVisible();
  listRequests[1]!.resolve(listResponse([memory(2, "Old query result")]));
  await vi.waitFor(() =>
    expect(page.getByText("Old query result", { exact: true }).query()).toBeNull(),
  );
  await expect.element(page.getByText("New query result", { exact: true })).toBeVisible();
});

test("does not publish a late response from the previous Bot", async () => {
  start();
  await vi.waitFor(() => expect(listRequests).toHaveLength(1));
  await page.getByRole("button", { name: "Switch Bot", exact: true }).click();
  await vi.waitFor(() => expect(listRequests).toHaveLength(2));
  expect(listRequests[0]!.signal?.aborted).toBe(true);

  listRequests[1]!.resolve(listResponse([memory(2, "Bot B memory", "bot-b")]));
  await expect.element(page.getByText("Bot B memory", { exact: true })).toBeVisible();
  listRequests[0]!.resolve(listResponse([memory(1, "Bot A memory", "bot-a")]));
  await vi.waitFor(() =>
    expect(page.getByText("Bot A memory", { exact: true }).query()).toBeNull(),
  );
  await expect.element(page.getByText("Bot B memory", { exact: true })).toBeVisible();
});

test("does not apply a completed mutation after switching Bots", async () => {
  await resolveInitial([memory(1, "Bot A memory")]);
  await page.getByRole("button", { name: "Add memory", exact: true }).click();
  await page.getByPlaceholder("Memory content…").fill("Pending Bot A draft");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await vi.waitFor(() => expect(mutationRequests).toHaveLength(1));

  await page.getByRole("button", { name: "Switch Bot", exact: true }).click();
  await vi.waitFor(() => expect(listRequests).toHaveLength(2));
  listRequests[1]!.resolve(listResponse([memory(2, "Bot B memory", "bot-b")]));
  await expect.element(page.getByText("Bot B memory", { exact: true })).toBeVisible();

  mutationRequests[0]!.resolve(mutationResponse());
  await vi.waitFor(() => expect(listRequests).toHaveLength(2));
  await expect.element(page.getByText("Created.", { exact: true })).not.toBeInTheDocument();
  await expect.element(page.getByText("Bot B memory", { exact: true })).toBeVisible();
});

test("keeps and freezes a create draft until failure, then succeeds on retry", async () => {
  await resolveInitial([memory(1, "Existing memory")], 40);
  const search = page.getByPlaceholder("Search memories…");
  await search.fill("scope");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await vi.waitFor(() => expect(listRequests).toHaveLength(2));
  listRequests[1]!.resolve(listResponse([memory(1, "Existing memory")], { total: 40 }));
  await expect.element(page.getByRole("button", { name: "Clear filters" })).toBeVisible();

  await page.getByRole("button", { name: "Add memory", exact: true }).click();
  const content = page.getByPlaceholder("Memory content…");
  await content.fill("Draft memory");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await vi.waitFor(() => expect(mutationRequests).toHaveLength(1));
  await expect.element(content).toBeDisabled();
  await expect
    .element(page.getByRole("button", { name: "Submitting…", exact: true }))
    .toBeDisabled();
  mutationRequests[0]!.resolve(mutationResponse(false, 503));

  await expect.element(page.getByRole("alert")).toHaveTextContent("Your draft is kept");
  await expect.element(content).toHaveValue("Draft memory");
  await page.getByRole("button", { name: "Refresh list", exact: true }).click();
  await vi.waitFor(() => expect(listRequests).toHaveLength(3));
  await expect.element(content).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
  await expect.element(search).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Search", exact: true })).toBeDisabled();
  await expect.element(page.getByRole("combobox").nth(0)).toBeDisabled();
  await expect.element(page.getByRole("combobox").nth(1)).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Clear filters" })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Next page" })).toBeDisabled();
  (page.getByRole("button", { name: "Clear filters" }).element() as HTMLButtonElement).click();
  (page.getByRole("button", { name: "Next page" }).element() as HTMLButtonElement).click();
  await vi.waitFor(() => expect(listRequests).toHaveLength(3));

  listRequests[2]!.resolve(listResponse([memory(1, "Existing memory")], { total: 40 }));
  await expect.element(content).toHaveValue("Draft memory");
  await expect.element(content).toBeEnabled();
  await expect.element(search).toBeEnabled();
  await expect.element(page.getByRole("button", { name: "Clear filters" })).toBeEnabled();
  await expect.element(page.getByRole("button", { name: "Next page" })).toBeEnabled();

  await page.getByRole("button", { name: "Create", exact: true }).click();
  await vi.waitFor(() => expect(mutationRequests).toHaveLength(2));
  mutationRequests[1]!.resolve(mutationResponse());
  await vi.waitFor(() => expect(listRequests).toHaveLength(4));
  listRequests[3]!.resolve(listResponse([memory(2, "Draft memory")], { total: 41 }));
  await expect.element(page.getByText("Created.", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("heading", { name: "New memory" })).not.toBeInTheDocument();
});

test("keeps an edit draft on an application failure and only closes after success", async () => {
  await resolveInitial([memory(1, "Original memory")]);
  await page.getByRole("button", { name: "Edit memory", exact: true }).click();
  const content = page.getByLabelText("Content", { exact: true });
  await content.fill("Edited memory");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await vi.waitFor(() => expect(mutationRequests).toHaveLength(1));
  await expect.element(content).toBeDisabled();
  mutationRequests[0]!.resolve(mutationResponse(false));

  await expect.element(page.getByRole("alert")).toHaveTextContent("Your changes are kept");
  await expect.element(content).toHaveValue("Edited memory");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await vi.waitFor(() => expect(mutationRequests).toHaveLength(2));
  mutationRequests[1]!.resolve(mutationResponse());
  await vi.waitFor(() => expect(listRequests).toHaveLength(2));
  listRequests[1]!.resolve(listResponse([memory(1, "Edited memory")]));
  await expect.element(page.getByText("Saved.", { exact: true })).toBeVisible();
  await expect.element(content).not.toBeInTheDocument();
});

test("keeps a record after a delete network failure and removes it after success", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await resolveInitial([memory(1, "Memory to delete")]);
  await page.getByRole("button", { name: "Delete memory", exact: true }).click();
  await vi.waitFor(() => expect(mutationRequests).toHaveLength(1));
  await expect
    .element(page.getByRole("button", { name: "Delete memory", exact: true }))
    .toBeDisabled();
  mutationRequests[0]!.reject(new Error("offline"));

  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Refresh the list before retrying");
  await expect.element(page.getByText("Memory to delete", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refresh list", exact: true }).click();
  await vi.waitFor(() => expect(listRequests).toHaveLength(2));
  listRequests[1]!.resolve(listResponse([memory(1, "Memory to delete")]));
  await page.getByRole("button", { name: "Delete memory", exact: true }).click();
  await vi.waitFor(() => expect(mutationRequests).toHaveLength(2));
  mutationRequests[1]!.resolve(mutationResponse());
  await vi.waitFor(() => expect(listRequests).toHaveLength(3));
  listRequests[2]!.resolve(listResponse([]));
  await expect.element(page.getByText("Deleted.", { exact: true })).toBeVisible();
  await expect.element(page.getByText("No memories found.", { exact: true })).toBeVisible();
});
