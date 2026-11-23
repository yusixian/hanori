import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { Link, MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { i18n } from "@/i18n";
import "@/style.css";
import { BotGenerationDetailPage } from "./generation-detail";
import { BotGenerationsPage } from "./generations";
import type { GenerationDetail, GenerationListItem } from "./generation-types";

const headers = { "content-type": "application/json" };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers });
}

function generation(id: string, prompt = `Prompt ${id}`): GenerationListItem {
  return {
    source: "unified",
    legacy: false,
    id,
    provider: "openai",
    state: "succeeded",
    statusGroup: "succeeded",
    prompt,
    presetKey: null,
    requestSnapshot: null,
    localFiles: [],
    filesPurgedAt: null,
    errorMessage: null,
    createdAt: "2026-09-22T00:00:00.000Z",
    completedAt: "2026-09-22T00:01:00.000Z",
    nsfwScores: null,
  };
}

function detail(id: string, prompt = `Prompt ${id}`): GenerationDetail {
  return {
    ...generation(id, prompt),
    negativePrompt: null,
    seed: null,
    purpose: "chat",
    approvalState: null,
    providerOperationId: null,
    providerState: null,
    artifacts: [],
    errorCode: null,
    deliveredAt: null,
    updatedAt: "2026-09-22T00:01:00.000Z",
    technical: {},
    events: [
      {
        id: "event-1",
        kind: "created",
        state: "succeeded",
        providerState: null,
        metadata: {},
        createdAt: "2026-09-22T00:00:00.000Z",
      },
    ],
  };
}

function listResponse(data: GenerationListItem[], total = data.length, pageNumber = 1) {
  return json({ ok: true, data, total, page: pageNumber, pageSize: 20 });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function renderList(path = "/bots/test-id/generations") {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/bots/:botId/generations" element={<BotGenerationsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderDetail(path = "/bots/test-id/generations/unified/task-1") {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/bots/:botId/generations/:source/:generationId"
          element={<BotGenerationDetailPage />}
        />
        <Route path="/bots/:botId/generations" element={<p>Archive destination</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("shows an initial list failure and only shows empty after a successful retry", async () => {
  let attempt = 0;
  const fetchMock = vi.fn(async () => {
    attempt += 1;
    return attempt === 1 ? json({ ok: false, error: "failed" }, 500) : listResponse([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  renderList();

  await expect.element(page.getByRole("alert")).toHaveTextContent("Couldn't load records");
  await expect.element(page.getByText("No generations found.")).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect.element(page.getByText("No generations found.")).toBeVisible();
  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("Generations"));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("rejects a malformed successful list payload instead of rendering it", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({ ok: true, data: [{ id: "broken" }], total: 1, page: 1, pageSize: 20 }),
    ),
  );
  renderList();

  await expect.element(page.getByRole("alert")).toHaveTextContent("Couldn't load records");
  await expect.element(page.getByText("No generations found.")).not.toBeInTheDocument();
});

test("does not let a delayed old search response replace the current scope", async () => {
  const oldResponse = deferred<Response>();
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const query = url.searchParams.get("q");
    if (query === "old") return oldResponse.promise;
    if (query === "new") return listResponse([generation("new", "New scoped result")]);
    return listResponse([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  renderList();

  await expect.element(page.getByText("No generations found.")).toBeVisible();
  const search = page.getByLabelText("Search prompt, task ID, preset, or provider…");
  await search.fill("old");
  await vi.waitFor(() =>
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("q=old"))).toBe(true),
  );
  await search.fill("new");
  await expect.element(page.getByText("New scoped result")).toBeVisible();
  oldResponse.resolve(listResponse([generation("old", "Old delayed result")]));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await expect.element(page.getByText("New scoped result")).toBeVisible();
  await expect.element(page.getByText("Old delayed result")).not.toBeInTheDocument();
});

test("locks a pending list deletion and verifies an uncertain result before unlocking", async () => {
  const deletion = deferred<Response>();
  let listReads = 0;
  let deleteWrites = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (init?.method === "DELETE") {
      deleteWrites += 1;
      return deletion.promise;
    }
    if (url.pathname === "/api/bots/test-id") {
      return json({ ok: true, data: { id: "test-id" } });
    }
    if (url.pathname.endsWith("/generations/unified/task-1")) {
      return json({ ok: true, data: detail("task-1") });
    }
    listReads += 1;
    return listResponse([generation("task-1")]);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  renderList();

  await expect.element(page.getByText("Prompt task-1", { exact: true })).toBeVisible();
  const remove = page.getByRole("button", { name: "Delete generation" });
  try {
    await remove.click();
    await expect.element(remove).toBeDisabled();
    ((await remove.element()) as HTMLButtonElement).click();
    expect(deleteWrites).toBe(1);
  } finally {
    deletion.resolve(json({ ok: false, error: "upstream failed" }, 500));
  }
  await expect.element(page.getByRole("alert")).toHaveTextContent("Couldn't confirm deletion");
  expect(document.activeElement?.textContent).toContain("Couldn't confirm deletion");
  ((await remove.element()) as HTMLButtonElement).click();
  expect(deleteWrites).toBe(1);

  await page.getByRole("button", { name: "Refresh and check" }).click();
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  await expect.element(remove).not.toBeDisabled();
  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("Generations"));
  expect(deleteWrites).toBe(1);
  expect(listReads).toBe(2);
});

test("keeps a successful delete distinct when the following list refresh fails", async () => {
  let listReads = 0;
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") return json({ ok: true });
    listReads += 1;
    if (listReads === 1) return listResponse([generation("task-1")]);
    if (listReads === 2) return json({ ok: false, error: "refresh failed" }, 500);
    return listResponse([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  renderList();

  await expect.element(page.getByText("Prompt task-1")).toBeVisible();
  await page.getByRole("button", { name: "Delete generation" }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Deleted, but the displayed data could not be refreshed.");
  await expect.element(page.getByText("Prompt task-1")).not.toBeInTheDocument();
  await expect.element(page.getByText("No generations found.")).not.toBeInTheDocument();

  await page.getByRole("button", { name: "Refresh and check" }).click();
  await expect.element(page.getByText("Deleted.")).toBeVisible();
  await expect.element(page.getByText("No generations found.")).toBeVisible();
  expect(
    fetchMock.mock.calls.some(
      ([input, init]) =>
        init?.method !== "DELETE" && String(input).endsWith("/generations/unified/task-1"),
    ),
  ).toBe(false);
});

test("does not treat an arbitrary target 404 as proof that deletion succeeded", async () => {
  let deleteWrites = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (init?.method === "DELETE") {
      deleteWrites += 1;
      return new Response("proxy error", { status: 404, headers: { "content-type": "text/html" } });
    }
    if (url.pathname === "/api/bots/test-id") {
      return json({ ok: true, data: { id: "test-id" } });
    }
    if (url.pathname.endsWith("/generations/unified/task-1")) {
      return new Response("proxy error", { status: 404, headers: { "content-type": "text/html" } });
    }
    return listResponse([generation("task-1")]);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  renderList();

  await expect.element(page.getByText("Prompt task-1", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Delete generation" }).click();
  await page.getByRole("button", { name: "Refresh and check" }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Couldn't confirm deletion");
  await expect.element(page.getByRole("button", { name: "Delete generation" })).toBeDisabled();
  expect(document.activeElement?.textContent).toContain("Couldn't confirm deletion");
  expect(deleteWrites).toBe(1);
});

test("corrects an empty last page after deletion and focuses the archive heading", async () => {
  let deleted = false;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (init?.method === "DELETE") {
      deleted = true;
      return json({ ok: true });
    }
    const requestedPage = Number(url.searchParams.get("page"));
    if (requestedPage === 2 && !deleted) return listResponse([generation("task-21")], 21, 2);
    if (requestedPage === 2) return listResponse([], 20, 2);
    return listResponse(
      Array.from({ length: 20 }, (_, index) => generation(`task-${index + 1}`)),
      deleted ? 20 : 21,
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  renderList("/bots/test-id/generations");

  await expect.element(page.getByText("Prompt task-1", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next page" }).click();
  await expect.element(page.getByText("Prompt task-21")).toBeVisible();
  const remove = page.getByRole("button", { name: "Delete generation" });
  await expect.element(remove).toBeEnabled();
  ((await remove.element()) as HTMLButtonElement).click();
  await expect.element(page.getByText("Prompt task-1", { exact: true })).toBeVisible();
  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("Generations"));
});

test("shows a detail load error with retry and rejects a malformed 200", async () => {
  let reads = 0;
  const fetchMock = vi.fn(async () => {
    reads += 1;
    if (reads === 1) return json({ ok: true });
    return json({ ok: true, data: detail("task-1") });
  });
  vi.stubGlobal("fetch", fetchMock);
  renderDetail();

  await expect.element(page.getByRole("alert")).toHaveTextContent("Couldn't load this generation");
  await expect.element(page.getByText("Generation not found.")).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect.element(page.getByRole("heading", { name: "Task details" })).toBeVisible();
  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("Task details"));
});

test("focuses the stable detail heading after retrying a failed background read", async () => {
  let reads = 0;
  let scheduledPoll = false;
  vi.spyOn(window, "setInterval").mockImplementation((handler) => {
    if (!scheduledPoll && typeof handler === "function") {
      scheduledPoll = true;
      queueMicrotask(() => handler());
    }
    return 1 as unknown as ReturnType<typeof window.setInterval>;
  });
  vi.spyOn(window, "clearInterval").mockImplementation(() => {});
  const activeDetail = {
    ...detail("task-1"),
    state: "running",
    statusGroup: "active" as const,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      reads += 1;
      return reads === 2
        ? json({ ok: false, error: "background read failed" }, 500)
        : json({ ok: true, data: activeDetail });
    }),
  );
  renderDetail();

  await expect.element(page.getByRole("alert")).toHaveTextContent("Refresh failed");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("Task details"));
  expect(reads).toBe(3);
});

test("uses the full deletion check when a detail retry follows a failed recovery read", async () => {
  let detailReads = 0;
  let botReads = 0;
  let deleteWrites = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (init?.method === "DELETE") {
      deleteWrites += 1;
      return json({ ok: false, error: "upstream failed" }, 500);
    }
    if (url.pathname === "/api/bots/test-id") {
      botReads += 1;
      return json({ ok: true, data: { id: "test-id" } });
    }
    detailReads += 1;
    if (detailReads === 3) {
      return json({ ok: false, error: "detail refresh failed" }, 500);
    }
    return json({ ok: true, data: detail("task-1") });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  renderDetail();

  const remove = page.getByRole("button", { name: "Delete generation" });
  await expect.element(remove).toBeVisible();
  await remove.click();
  await expect
    .element(page.getByText("Couldn't confirm deletion.", { exact: false }))
    .toBeVisible();
  await page.getByRole("button", { name: "Refresh and check" }).click();
  await expect.element(page.getByText("Refresh failed.", { exact: false })).toBeVisible();
  await expect.element(remove).toBeDisabled();

  await page.getByRole("button", { name: "Retry" }).click();
  await expect
    .element(page.getByText("Couldn't confirm deletion.", { exact: false }))
    .not.toBeInTheDocument();
  await expect.element(page.getByText("Refresh failed.", { exact: false })).not.toBeInTheDocument();
  await expect.element(remove).toBeEnabled();
  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("Task details"));
  expect({ botReads, deleteWrites, detailReads }).toEqual({
    botReads: 2,
    deleteWrites: 1,
    detailReads: 5,
  });
});

test("locks duplicate detail deletion and exposes active conflicts next to the action", async () => {
  const deletion = deferred<Response>();
  let deleteWrites = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (init?.method === "DELETE") {
      deleteWrites += 1;
      return deletion.promise;
    }
    if (url.pathname === "/api/bots/test-id") {
      return json({ ok: true, data: { id: "test-id" } });
    }
    return json({ ok: true, data: detail("task-1") });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  renderDetail();

  const remove = page.getByRole("button", { name: "Delete generation" });
  await expect.element(remove).toBeVisible();
  try {
    await remove.click();
    await expect.element(remove).toBeDisabled();
    ((await remove.element()) as HTMLButtonElement).click();
    expect(deleteWrites).toBe(1);
  } finally {
    deletion.resolve(
      json({ ok: false, error: "Cancel an active generation before deleting it" }, 409),
    );
  }

  await expect.element(page.getByRole("alert")).toHaveTextContent("still running");
  expect(document.activeElement?.textContent).toContain("still running");
  await expect.element(remove).toBeDisabled();
  expect(deleteWrites).toBe(1);
  await page.getByRole("button", { name: "Refresh and check" }).click();
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("Task details"));
});

test("deduplicates the same in-flight deletion after returning through browser history", async () => {
  const deletion = deferred<Response>();
  let deleteWrites = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (init?.method === "DELETE") {
      deleteWrites += 1;
      return deletion.promise;
    }
    if (url.pathname.endsWith("/generations/unified/task-1")) {
      return json({ ok: true, data: detail("task-1") });
    }
    return listResponse([generation("task-1")]);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "confirm").mockReturnValue(true);

  render(
    <MemoryRouter
      initialEntries={["/bots/test-id/generations", "/bots/test-id/generations/unified/task-1"]}
      initialIndex={1}
    >
      <HistoryBack />
      <Routes>
        <Route path="/bots/:botId/generations" element={<BotGenerationsPage />} />
        <Route
          path="/bots/:botId/generations/:source/:generationId"
          element={<BotGenerationDetailPage />}
        />
      </Routes>
    </MemoryRouter>,
  );

  try {
    await page.getByRole("button", { name: "Delete generation" }).click();
    await page.getByRole("button", { name: "Browser back" }).click();
    await expect.element(page.getByText("Prompt task-1")).toBeVisible();
    await page.getByRole("button", { name: "Delete generation" }).click();
    expect(deleteWrites).toBe(1);
  } finally {
    deletion.resolve(json({ ok: false, error: "upstream failed" }, 500));
  }
  await expect.element(page.getByRole("alert")).toHaveTextContent("Couldn't confirm deletion");
  expect(deleteWrites).toBe(1);
});

test("ignores a late detail response after navigating to a different route scope", async () => {
  const firstResponse = deferred<Response>();
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/task-1")) return firstResponse.promise;
    return json({ ok: true, data: detail("task-2", "Current route detail") });
  });
  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/bots/test-id/generations/unified/task-1"]}>
      <Routes>
        <Route
          path="/bots/:botId/generations/:source/:generationId"
          element={
            <>
              <BotGenerationDetailPage />
              <RouteSwitcher />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  await page.getByRole("link", { name: "Open task 2" }).click();
  await expect.element(page.getByText("Current route detail")).toBeVisible();
  firstResponse.resolve(json({ ok: true, data: detail("task-1", "Old route detail") }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await expect.element(page.getByText("Current route detail")).toBeVisible();
  await expect.element(page.getByText("Old route detail")).not.toBeInTheDocument();
});

function RouteSwitcher() {
  return <Link to="/bots/test-id/generations/unified/task-2">Open task 2</Link>;
}

function HistoryBack() {
  const navigate = useNavigate();
  return <button onClick={() => navigate(-1)}>Browser back</button>;
}
