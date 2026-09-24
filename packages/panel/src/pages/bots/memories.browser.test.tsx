import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  createMemoryRouter,
  RouterProvider,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { i18n } from "@/i18n";
import "@/style.css";
import { BotMemoriesPage } from "./memories";

interface PendingRequest {
  url: URL;
  method: string;
  signal: AbortSignal | null;
  request: Request | null;
  body: BodyInit | null;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}

let listRequests: PendingRequest[];
let mutationRequests: PendingRequest[];
let duplicatePreviewRequests: PendingRequest[];

const memory = (id: number, content: string, botId = "bot-a") => ({
  id,
  botId,
  telegramId: null,
  content,
  category: "fact",
  kind: null as null | "fact" | "preference" | "event" | "commitment" | "relationship",
  scopeChatId: null as number | null,
  origin: null as string | null,
  sourceChatId: null as number | null,
  sourceMessageId: null as number | null,
  sourceUserId: null as number | null,
  expiresAt: null as string | null,
  isActive: true as boolean,
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

const duplicateCandidate = (candidateId: number, survivorId: number, content = "Prefers tea") => ({
  candidateId,
  survivorId,
  expectedCandidateUpdatedAt: "2026-09-02T00:00:00.000Z",
  expectedSurvivorUpdatedAt: "2026-09-01T00:00:00.000Z",
  content,
  telegramId: 42,
  scopeChatId: -100,
  kind: "preference",
  category: "fact",
});

const duplicatePreviewResponse = (
  data: ReturnType<typeof duplicateCandidate>[],
  { hasMore = false, batchMax = 50, status = 200, ok = true } = {},
) =>
  new Response(JSON.stringify({ ok, data, hasMore, batchMax }), {
    status,
    headers: { "content-type": "application/json" },
  });

function requestDetails(input: RequestInfo | URL, init?: RequestInit) {
  const request = input instanceof Request ? input : null;
  return {
    url: new URL(request?.url ?? String(input), location.origin),
    method: request?.method ?? init?.method ?? "GET",
    signal: request?.signal ?? init?.signal ?? null,
    request,
    body: init?.body ?? null,
  };
}

async function requestJson(pending: PendingRequest): Promise<Record<string, unknown>> {
  return (
    pending.request ? await pending.request.clone().json() : JSON.parse(String(pending.body))
  ) as Record<string, unknown>;
}

function TestRoutes() {
  const navigate = useNavigate();
  const current = useLocation();
  return (
    <>
      <button type="button" onClick={() => navigate("/bots/bot-b/memories")}>
        Switch Bot
      </button>
      <button onClick={() => navigate(-1)}>Back</button>
      <button
        onClick={() => {
          document
            .querySelector<HTMLFormElement>('form[aria-label="Memory filters"]')!
            .requestSubmit();
          navigate(-1);
          window.dispatchEvent(new PopStateEvent("popstate"));
        }}
      >
        Submit then back
      </button>
      <button onClick={() => navigate(1)}>Forward</button>
      <button onClick={() => navigate("?telegramId=bad")}>Invalid address</button>
      <output aria-label="Current address">
        {current.pathname}
        {current.search}
      </output>
      <Routes>
        <Route path="/bots/:botId/memories" element={<BotMemoriesPage />} />
      </Routes>
    </>
  );
}

function start(path = "/bots/bot-a/memories") {
  render(
    <RouterProvider
      router={createMemoryRouter([{ path: "*", element: <TestRoutes /> }], {
        initialEntries: [path],
      })}
    />,
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
  duplicatePreviewRequests = [];
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
      if (details.url.pathname.endsWith("/memories/duplicate-preview")) {
        return new Promise<Response>((resolve, reject) => {
          duplicatePreviewRequests.push({ ...details, resolve, reject });
        });
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

test("aligns memory filters and search action on desktop", async () => {
  await page.viewport(1440, 900);
  await resolveInitial();

  const search = document.getElementById("memory-filter-search")!;
  const category = document.getElementById("memory-filter-category")!;
  const scope = document.getElementById("memory-filter-scope")!;
  const submit = document.querySelector<HTMLButtonElement>(
    'form[aria-label="Memory filters"] button[type="submit"]',
  )!;
  const controls = [search, category, scope, submit].map((element) =>
    element.getBoundingClientRect(),
  );

  for (const control of controls.slice(1)) {
    expect(Math.abs(control.top - controls[0]!.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(control.bottom - controls[0]!.bottom)).toBeLessThanOrEqual(1);
  }

  await page.viewport(390, 844);
  expect(
    Math.abs(category.getBoundingClientRect().top - scope.getBoundingClientRect().top),
  ).toBeLessThanOrEqual(1);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
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
  await page.getByRole("combobox", { name: "Type" }).click();
  await page.getByRole("option", { name: "Commitment" }).click();
  await page.getByLabelText("Chat ID (optional)").fill("-42");
  await page.getByLabelText("Expires (optional)").fill("2026-12-20T09:15");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await vi.waitFor(() => expect(mutationRequests).toHaveLength(1));
  expect(await requestJson(mutationRequests[0]!)).toMatchObject({
    content: "Edited memory",
    expectedUpdatedAt: "2026-09-02T00:00:00.000Z",
    kind: "commitment",
    scopeChatId: -42,
    expiresAt: new Date("2026-12-20T09:15").toISOString(),
  });
  await expect.element(content).toBeDisabled();
  mutationRequests[0]!.resolve(mutationResponse(false));

  await expect.element(page.getByRole("alert")).toHaveTextContent("Your changes are kept");
  await expect.element(content).toHaveValue("Edited memory");
  await expect.element(page.getByLabelText("Chat ID (optional)")).toHaveValue("-42");
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

test("shows lifecycle details and submits typed, scoped memory fields", async () => {
  await resolveInitial([
    {
      ...memory(1, "We finished the trip plan"),
      kind: "event" as const,
      scopeChatId: -100,
      origin: "agent",
      sourceChatId: -100,
      sourceMessageId: 42,
      sourceUserId: 7,
      expiresAt: "2026-12-01T10:30:00.000Z",
    },
  ]);
  await expect.element(page.getByText("Shared event", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Chat -100", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Source chat -100", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Message 42", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Source user 7", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Origin: Saved by the Bot", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Add memory", exact: true }).click();
  await page.getByPlaceholder("Memory content…").fill("Prefers tea");
  await page.getByRole("combobox", { name: "Type" }).click();
  await page.getByRole("option", { name: "Preference" }).click();
  await page.getByLabelText("Chat ID (optional)").fill("-100");
  await page.getByLabelText("Expires (optional)").fill("2026-12-01T10:30");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await vi.waitFor(() => expect(mutationRequests).toHaveLength(1));
  const createBody = await requestJson(mutationRequests[0]!);
  expect(createBody).toMatchObject({
    content: "Prefers tea",
    kind: "preference",
    scopeChatId: -100,
  });
  expect(createBody["expiresAt"]).toBe(new Date("2026-12-01T10:30").toISOString());
  mutationRequests[0]!.resolve(mutationResponse());
  await vi.waitFor(() => expect(listRequests).toHaveLength(2));
  listRequests[1]!.resolve(listResponse([memory(2, "Prefers tea")]));
  await expect.element(page.getByText("Created.", { exact: true })).toBeVisible();
});

test("keeps expiry seconds on unrelated edits and marks expired memories accurately", async () => {
  await resolveInitial([
    { ...memory(1, "Past appointment"), expiresAt: "2026-01-01T10:30:45.000Z" },
  ]);
  await expect.element(page.getByText("Expired", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit memory", exact: true }).click();
  await page.getByRole("textbox", { name: "Category", exact: true }).fill("history");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await vi.waitFor(() => expect(mutationRequests).toHaveLength(1));
  expect(await requestJson(mutationRequests[0]!)).toMatchObject({
    expiresAt: "2026-01-01T10:30:45.000Z",
    expectedUpdatedAt: "2026-09-02T00:00:00.000Z",
  });
});

test("retires an active memory with refresh recovery and leaves retired records read only", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await resolveInitial([memory(1, "Outdated preference")]);
  await page.getByRole("button", { name: "Retire", exact: true }).click();
  await vi.waitFor(() => expect(mutationRequests).toHaveLength(1));
  expect(mutationRequests[0]!.method).toBe("POST");
  expect(mutationRequests[0]!.url.pathname).toContain("/memories/1/retire");
  expect(await requestJson(mutationRequests[0]!)).toEqual({});
  mutationRequests[0]!.reject(new Error("offline"));
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Refresh the list before retrying");
  await expect.element(page.getByText("Outdated preference", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refresh list", exact: true }).click();
  await vi.waitFor(() => expect(listRequests).toHaveLength(2));
  listRequests[1]!.resolve(listResponse([memory(1, "Outdated preference")]));
  await page.getByRole("button", { name: "Retire", exact: true }).click();
  await vi.waitFor(() => expect(mutationRequests).toHaveLength(2));
  mutationRequests[1]!.resolve(mutationResponse());
  await vi.waitFor(() => expect(listRequests).toHaveLength(3));
  listRequests[2]!.resolve(
    listResponse([{ ...memory(1, "Outdated preference"), isActive: false }]),
  );
  await expect.element(page.getByText("Memory retired.", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Retired", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Retire", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Edit memory", exact: true }))
    .toBeDisabled();
});

test("keeps exact duplicate cleanup opt-in, preserves edit drafts, and confirms each batch", async () => {
  await resolveInitial([memory(1, "Original memory")]);
  await page.getByRole("button", { name: "Edit memory", exact: true }).click();
  const editContent = page.getByLabelText("Content", { exact: true });
  await editContent.fill("Unsaved edit draft");

  expect(duplicatePreviewRequests).toHaveLength(0);
  expect(mutationRequests).toHaveLength(0);
  await page.getByRole("button", { name: "Review exact duplicates", exact: true }).click();
  await vi.waitFor(() => expect(duplicatePreviewRequests).toHaveLength(1));
  duplicatePreviewRequests[0]!.resolve(
    duplicatePreviewResponse([duplicateCandidate(3, 2)], { hasMore: true }),
  );
  await expect.element(page.getByText("Similar wording is excluded.")).toBeVisible();
  await expect.element(page.getByText("Retire #3 · keep #2", { exact: true })).toBeVisible();
  await expect.element(editContent).toHaveValue("Unsaved edit draft");
  await expect
    .element(page.getByRole("button", { name: "Retire this batch (1)", exact: true }))
    .toBeDisabled();
  expect(mutationRequests).toHaveLength(0);

  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  const confirmation = vi.spyOn(window, "confirm").mockReturnValue(false);
  const retireBatch = page.getByRole("button", { name: "Retire this batch (1)", exact: true });
  await retireBatch.click();
  expect(confirmation).toHaveBeenCalledOnce();
  expect(mutationRequests).toHaveLength(0);

  confirmation.mockReturnValue(true);
  await retireBatch.click();
  await vi.waitFor(() => expect(mutationRequests).toHaveLength(1));
  expect(mutationRequests[0]!.url.pathname).toContain("/memories/retire-duplicates");
  expect(await requestJson(mutationRequests[0]!)).toEqual({
    candidates: [
      {
        candidateId: 3,
        survivorId: 2,
        expectedCandidateUpdatedAt: "2026-09-02T00:00:00.000Z",
        expectedSurvivorUpdatedAt: "2026-09-01T00:00:00.000Z",
      },
    ],
  });
  mutationRequests[0]!.resolve(mutationResponse());
  await vi.waitFor(() => expect(duplicatePreviewRequests).toHaveLength(2));
  await vi.waitFor(() => expect(listRequests).toHaveLength(2));
  duplicatePreviewRequests[1]!.resolve(duplicatePreviewResponse([duplicateCandidate(5, 4)]));
  listRequests[1]!.resolve(listResponse([memory(1, "Original memory")]));
  await expect
    .element(
      page.getByText("Retired 1 exact duplicate memories.", {
        exact: true,
      }),
    )
    .toBeVisible();
  await expect.element(page.getByText("Retire #5 · keep #4", { exact: true })).toBeVisible();
  expect(confirmation).toHaveBeenCalledTimes(2);
  confirmation.mockReturnValue(false);
  await page.getByRole("button", { name: "Retire this batch (1)", exact: true }).click();
  expect(confirmation).toHaveBeenCalledTimes(3);
  expect(mutationRequests).toHaveLength(1);
  await expect
    .element(page.getByLabelText("Current address"))
    .toHaveTextContent("/bots/bot-a/memories");
});

test("limits duplicate cleanup to 50 and refreshes the batch after a stale 409", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  start("/bots/bot-a/memories?telegramId=42&search=tea");
  await vi.waitFor(() => expect(listRequests).toHaveLength(1));
  listRequests[0]!.resolve(listResponse([memory(1, "Tea preference")]));
  await expect.element(page.getByText("Tea preference", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Review exact duplicates", exact: true }).click();
  await vi.waitFor(() => expect(duplicatePreviewRequests).toHaveLength(1));
  const firstBatch = Array.from({ length: 50 }, (_, index) =>
    duplicateCandidate(index + 100, index + 1, `Memory ${index + 1}`),
  );
  duplicatePreviewRequests[0]!.resolve(
    duplicatePreviewResponse(firstBatch, { hasMore: true, batchMax: 50 }),
  );
  await page.getByRole("button", { name: "Retire this batch (50)", exact: true }).click();
  await vi.waitFor(() => expect(mutationRequests).toHaveLength(1));
  const body = await requestJson(mutationRequests[0]!);
  expect(body.candidates).toHaveLength(50);
  expect((body.candidates as Array<Record<string, unknown>>).length).toBeLessThanOrEqual(50);
  expect(window.confirm).toHaveBeenCalledWith(
    "Retire 50 exact duplicate memories? Each copy will be marked inactive and linked to its survivor.",
  );
  mutationRequests[0]!.resolve(mutationResponse(false, 409));

  await vi.waitFor(() => expect(duplicatePreviewRequests).toHaveLength(2));
  await vi.waitFor(() => expect(listRequests).toHaveLength(2));
  duplicatePreviewRequests[1]!.resolve(
    duplicatePreviewResponse([duplicateCandidate(250, 249, "Changed after preview")]),
  );
  listRequests[1]!.resolve(listResponse([memory(1, "Tea preference")]));
  await expect
    .element(
      page.getByText("Memories changed after this preview. We refreshed it; review the new batch."),
    )
    .toBeVisible();
  await expect.element(page.getByText("Changed after preview", { exact: true })).toBeVisible();
  await expect
    .element(page.getByLabelText("Current address"))
    .toHaveTextContent("/bots/bot-a/memories?telegramId=42&search=tea");
  expect(mutationRequests).toHaveLength(1);
});

test("reads back an uncertain duplicate cleanup result and fits the Chinese preview on mobile", async () => {
  await page.viewport(390, 844);
  await i18n.changeLanguage("zh-CN");
  await resolveInitial([memory(1, "保留当前筛选和列表状态")]);
  await page.getByRole("button", { name: "检查完全重复项", exact: true }).click();
  await vi.waitFor(() => expect(duplicatePreviewRequests).toHaveLength(1));
  duplicatePreviewRequests[0]!.resolve(
    duplicatePreviewResponse([
      duplicateCandidate(2, 1, "这是一段较长的重复记忆文本，用于检查窄屏上的换行和水平溢出。"),
      duplicateCandidate(3, 1, "另一段较长的重复记忆文本，用于检查预览列表在手机视口中的布局。"),
    ]),
  );
  await expect.element(page.getByText("停用本批（2）", { exact: true })).toBeVisible();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await page.getByRole("button", { name: "停用本批（2）", exact: true }).click();
  await vi.waitFor(() => expect(mutationRequests).toHaveLength(1));
  mutationRequests[0]!.reject(new Error("offline"));
  await vi.waitFor(() => expect(duplicatePreviewRequests).toHaveLength(2));
  await vi.waitFor(() => expect(listRequests).toHaveLength(2));
  duplicatePreviewRequests[1]!.resolve(duplicatePreviewResponse([duplicateCandidate(3, 1)]));
  listRequests[1]!.resolve(listResponse([memory(1, "保留当前筛选和列表状态")]));
  await expect
    .element(page.getByText("无法确认操作结果。已加载最新预览，请检查当前批次后再操作。"))
    .toBeVisible();
  await expect.element(page.getByText("停用 #3 · 保留 #1", { exact: true })).toBeVisible();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
});

test("keeps memory details and edit controls within a mobile viewport", async () => {
  await page.viewport(390, 844);
  await i18n.changeLanguage("zh-CN");
  await resolveInitial([
    {
      ...memory(1, "曾经一起讨论过一次很长的旅行安排"),
      kind: "event" as const,
      scopeChatId: -1000000000042,
      sourceChatId: -1000000000042,
      sourceMessageId: 42001,
      origin: "agent",
    },
  ]);
  await expect.element(page.getByText("共同经历", { exact: true })).toBeVisible();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  await page.getByRole("button", { name: "编辑记忆" }).click();
  await expect.element(page.getByLabelText("聊天 ID（可选）")).toHaveValue("-1000000000042");
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
});

test("restores submitted user filters through history and keeps pagination scoped", async () => {
  await resolveInitial([memory(1, "All records")]);
  await page.getByRole("combobox", { name: "Scope", exact: true }).click();
  await page.getByRole("option", { name: "Specific user", exact: true }).click();
  await page.getByLabelText("Telegram ID", { exact: true }).fill("00042");
  await page.getByPlaceholder("Search memories…").fill("  tea  ");
  expect(listRequests).toHaveLength(1);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await vi.waitFor(() => expect(listRequests).toHaveLength(2));
  expect(listRequests[1]!.url.searchParams.get("telegramId")).toBe("42");
  expect(listRequests[1]!.url.searchParams.get("search")).toBe("tea");
  listRequests[1]!.resolve(listResponse([memory(2, "User tea")], { total: 25 }));
  await page.getByRole("button", { name: "Next page" }).click();
  await vi.waitFor(() => expect(listRequests).toHaveLength(3));
  expect(listRequests[2]!.url.searchParams.get("telegramId")).toBe("42");
  expect(listRequests[2]!.url.searchParams.get("page")).toBe("2");
  listRequests[2]!.resolve(listResponse([memory(3, "Second page")], { total: 25 }));
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await vi.waitFor(() => expect(listRequests).toHaveLength(4));
  expect(listRequests[3]!.url.searchParams.get("page")).toBe("1");
  listRequests[3]!.resolve(listResponse([memory(2, "User tea")], { total: 25 }));
  await expect.element(page.getByLabelText("Telegram ID", { exact: true })).toHaveValue("42");
  await page.getByRole("button", { name: "Forward", exact: true }).click();
  await vi.waitFor(() => expect(listRequests).toHaveLength(5));
  expect(listRequests[4]!.url.searchParams.get("page")).toBe("2");
  listRequests[4]!.resolve(listResponse([memory(3, "Second page")], { total: 25 }));
  await page.getByRole("button", { name: "Clear filters" }).click();
  await vi.waitFor(() => expect(listRequests).toHaveLength(6));
  expect(listRequests[5]!.url.searchParams.get("page")).toBe("1");
  expect(listRequests[5]!.url.searchParams.has("telegramId")).toBe(false);
});

for (const id of ["bad", "1e3", "0x2a", "9007199254740992"]) {
  test(`rejects invalid direct user filter ${id} without fetching all records`, async () => {
    start(`/bots/bot-a/memories?telegramId=${id}`);
    await expect.element(page.getByRole("alert")).toHaveTextContent("valid Telegram user ID");
    expect(listRequests).toHaveLength(0);
    await expect.element(page.getByLabelText("Telegram ID", { exact: true })).toHaveValue(id);
    await expect
      .element(page.getByText("No memories found.", { exact: true }))
      .not.toBeInTheDocument();
    await page.getByLabelText("Telegram ID", { exact: true }).fill("-42");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await vi.waitFor(() => expect(listRequests).toHaveLength(1));
    expect(listRequests[0]!.url.searchParams.get("telegramId")).toBe("-42");
  });
}

test("hydrates a category deep link before metadata and pre-fills new user memories", async () => {
  start("/bots/bot-a/memories?telegramId=42&category=custom&page=2");
  await vi.waitFor(() => expect(listRequests).toHaveLength(1));
  expect(listRequests[0]!.url.searchParams.get("category")).toBe("custom");
  await expect
    .element(page.getByRole("combobox", { name: "Category", exact: true }))
    .toHaveTextContent("custom");
  listRequests[0]!.resolve(listResponse([memory(1, "Scoped memory")], { total: 25 }));
  await page.getByRole("button", { name: "Add memory", exact: true }).click();
  await expect.element(page.getByLabelText("Telegram ID (optional)")).toHaveValue("42");
  await page.getByLabelText("Telegram ID (optional)").fill("99");
  await page.getByRole("button", { name: "Add memory", exact: true }).click();
  await page.getByRole("button", { name: "Add memory", exact: true }).click();
  await expect.element(page.getByLabelText("Telegram ID (optional)")).toHaveValue("99");
});

test("does not apply pending browser history until a failed write is confirmed on its original scope", async () => {
  await resolveInitial([memory(1, "Original")]);
  await page.getByPlaceholder("Search memories…").fill("scope");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await vi.waitFor(() => expect(listRequests).toHaveLength(2));
  listRequests[1]!.resolve(listResponse([memory(1, "Original")]));
  await page.getByRole("button", { name: "Add memory", exact: true }).click();
  const draft = page.getByPlaceholder("Memory content…");
  await draft.fill("Kept draft");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await vi.waitFor(() => expect(mutationRequests).toHaveLength(1));
  await page.getByRole("button", { name: "Back", exact: true }).click();
  mutationRequests[0]!.reject(new Error("offline"));
  await expect.element(page.getByText(/The address change will apply afterwards/)).toBeVisible();
  await expect.element(draft).toHaveValue("Kept draft");
  expect(listRequests).toHaveLength(2);
  await page.getByRole("button", { name: "Refresh list", exact: true }).click();
  await vi.waitFor(() => expect(listRequests).toHaveLength(3));
  expect(listRequests[2]!.url.searchParams.get("search")).toBe("scope");
  await page.getByRole("button", { name: "Forward", exact: true }).click();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  expect(listRequests[2]!.signal?.aborted).toBe(false);
  listRequests[2]!.resolve(listResponse([], { ok: false, status: 503 }));
  await expect
    .element(page.getByText("Refresh failed. Showing the last loaded records.", { exact: true }))
    .toBeVisible();
  expect(listRequests).toHaveLength(3);
  await expect.element(draft).toHaveValue("Kept draft");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await vi.waitFor(() => expect(listRequests).toHaveLength(4));
  expect(listRequests[3]!.url.searchParams.get("search")).toBe("scope");
  listRequests[3]!.resolve(listResponse([memory(1, "Original")]));
  await vi.waitFor(() => expect(listRequests).toHaveLength(5));
  expect(listRequests[4]!.url.searchParams.has("search")).toBe(false);
  listRequests[4]!.resolve(listResponse([memory(2, "All scope")]));
  await expect.element(page.getByText("All scope", { exact: true })).toBeVisible();
  await expect.element(draft).toHaveValue("Kept draft");
});

test("keeps an edit accessible across browser history and a recovery that no longer contains it", async () => {
  await resolveInitial([memory(1, "Original")]);
  await page.getByPlaceholder("Search memories…").fill("scope");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await vi.waitFor(() => expect(listRequests).toHaveLength(2));
  listRequests[1]!.resolve(listResponse([memory(1, "Original")]));
  await page.getByRole("button", { name: "Edit memory", exact: true }).click();
  const draft = page.getByLabelText("Content", { exact: true });
  await draft.fill("Kept edit");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect.element(draft).toBeEnabled();
  expect(listRequests).toHaveLength(2);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await vi.waitFor(() => expect(mutationRequests).toHaveLength(1));
  mutationRequests[0]!.resolve(mutationResponse(false));
  await page.getByRole("button", { name: "Refresh list", exact: true }).click();
  await vi.waitFor(() => expect(listRequests).toHaveLength(3));
  listRequests[2]!.resolve(listResponse([]));
  await expect.element(draft).toHaveValue("Kept edit");
  await expect.element(page.getByText(/Your edit is kept here/)).toBeVisible();
  expect(listRequests).toHaveLength(3);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await vi.waitFor(() => expect(listRequests).toHaveLength(4));
  expect(listRequests[3]!.url.searchParams.has("search")).toBe(false);
});

test("ignores Enter during IME composition", async () => {
  await resolveInitial();
  const input = page.getByPlaceholder("Search memories…").element();
  input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      isComposing: true,
    }),
  );
  input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  expect(listRequests).toHaveLength(1);
  input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
});

test("allows another query after a normal list retry also fails", async () => {
  start();
  await vi.waitFor(() => expect(listRequests).toHaveLength(1));
  listRequests[0]!.reject(new Error("offline"));
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await vi.waitFor(() => expect(listRequests).toHaveLength(2));
  listRequests[1]!.reject(new Error("still offline"));
  const search = page.getByPlaceholder("Search memories…");
  await expect.element(search).toBeEnabled();
  await search.fill("another scope");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await vi.waitFor(() => expect(listRequests).toHaveLength(3));
  expect(listRequests[2]!.url.searchParams.get("search")).toBe("another scope");
});

test("disables retained create submission when queued history has an invalid user ID", async () => {
  await resolveInitial([memory(1, "Original")]);
  await page.getByRole("button", { name: "Add memory", exact: true }).click();
  const draft = page.getByPlaceholder("Memory content…");
  await draft.fill("Kept draft");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await vi.waitFor(() => expect(mutationRequests).toHaveLength(1));
  await page.getByRole("button", { name: "Invalid address", exact: true }).click();
  mutationRequests[0]!.reject(new Error("offline"));
  await page.getByRole("button", { name: "Refresh list", exact: true }).click();
  await vi.waitFor(() => expect(listRequests).toHaveLength(2));
  listRequests[1]!.resolve(listResponse([memory(1, "Original")]));
  await expect.element(page.getByRole("alert")).toHaveTextContent("valid Telegram user ID");
  await expect.element(draft).toHaveValue("Kept draft");
  await expect.element(page.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
  expect(listRequests).toHaveLength(2);
});

test("keeps unapplied filter text when navigating only between result pages", async () => {
  await resolveInitial([memory(1, "Original")], 25);
  const search = page.getByPlaceholder("Search memories…");
  await search.fill("Unapplied text");
  await page.getByRole("button", { name: "Next page" }).click();
  await vi.waitFor(() => expect(listRequests).toHaveLength(2));
  expect(listRequests[1]!.url.searchParams.has("search")).toBe(false);
  listRequests[1]!.resolve(listResponse([memory(2, "Next page")], { total: 25 }));
  await expect.element(search).toHaveValue("Unapplied text");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await vi.waitFor(() => expect(listRequests).toHaveLength(3));
  await expect.element(search).toHaveValue("Unapplied text");
});

test("restores filters when submitting and going back before the intermediate render", async () => {
  await resolveInitial([memory(1, "Original")]);
  const search = page.getByPlaceholder("Search memories…");
  await search.fill("Briefly submitted");
  await page.getByRole("button", { name: "Submit then back", exact: true }).click();
  await expect.element(search).toHaveValue("");
  await expect
    .element(page.getByLabelText("Current address"))
    .toHaveTextContent("/bots/bot-a/memories");
  expect(listRequests.every((request) => !request.url.searchParams.has("search"))).toBe(true);
});
