import { i18n } from "@/i18n";
import "@/style.css";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { createMemoryRouter, Link, RouterProvider, useLocation, useNavigate } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BotAiSettingsPage } from "./ai-settings-page";
import { DEFAULT_CONFIG, type GlobalAiSelection } from "./types";
import { BeforeLogoutProvider } from "@/components/layout/before-logout";

function Destination() {
  const location = useLocation();
  return <p>Decision destination {location.search}</p>;
}

function PageHarness() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output aria-label="Current query">{location.search}</output>
      <button type="button" onClick={() => navigate(-1)}>
        Test history back
      </button>
      <Link to="/outside">Test link outside</Link>
      <button type="button" onClick={() => navigate("/outside")}>
        Test programmatic outside
      </button>
      <BotAiSettingsPage />
    </>
  );
}

async function renderAiSettings(path: string) {
  const router = createMemoryRouter(
    [
      {
        path: "/bots/:botId/ai",
        element: (
          <BeforeLogoutProvider>
            <PageHarness />
          </BeforeLogoutProvider>
        ),
      },
      { path: "/bots/:botId/debugger", element: <Destination /> },
      { path: "/outside", element: <p>Outside destination</p> },
    ],
    { initialEntries: [path] },
  );
  const rendered = await render(<RouterProvider router={router} />);
  return { rendered, router };
}

const GLOBAL_SELECTION: GlobalAiSelection = {
  revision: "selection-revision-1",
  applyState: "applied",
  displayDefault: "show",
  selection: {
    providerId: "provider-a",
    modelId: "model-a",
    providerLabel: "Provider A",
    modelLabel: "Model A",
  },
  options: [
    {
      id: "provider-a",
      label: "Provider A",
      defaultModelId: "model-a",
      models: [{ id: "model-a", label: "Model A" }],
    },
    {
      id: "provider-b",
      label: "Provider B",
      defaultModelId: "model-b",
      models: [{ id: "model-b", label: "Model B" }],
    },
  ],
};

function requestMethod(input: RequestInfo | URL, init?: RequestInit) {
  return input instanceof Request ? input.method : (init?.method ?? "GET");
}

function stubAiSettingsFetch({
  saveResponse,
  selection,
}: {
  saveResponse?: () => Promise<Response> | Response;
  selection?: GlobalAiSelection;
} = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/bots/test-id/ai-config")) {
      if (requestMethod(input, init) === "PUT" && saveResponse) return saveResponse();
      return Response.json({ ok: true, data: DEFAULT_CONFIG, revision: "revision-1" });
    }
    if (url.endsWith("/api/bots/test-id/ai-selection") && selection) {
      return Response.json({ ok: true, data: selection, canManage: true });
    }
    if (url.endsWith("/api/authz/me")) {
      return Response.json({ data: { member: { role: "owner" } } });
    }
    if (url.endsWith("/api/bots/test-id")) {
      return Response.json({ ok: true, data: { id: "test-id", platform: "telegram" } });
    }
    return Response.json({ ok: false }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubAiSettingsFetchWithDeferredConfig() {
  let resolveConfig!: (response: Response) => void;
  const configResponse = new Promise<Response>((resolve) => {
    resolveConfig = resolve;
  });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/bots/test-id/ai-config")) return configResponse;
      if (url.endsWith("/api/authz/me")) {
        return Response.json({ data: { member: { role: "owner" } } });
      }
      if (url.endsWith("/api/bots/test-id")) {
        return Response.json({ ok: true, data: { id: "test-id", platform: "telegram" } });
      }
      return Response.json({ ok: false }, { status: 404 });
    }),
  );

  return () =>
    resolveConfig(Response.json({ ok: true, data: DEFAULT_CONFIG, revision: "revision-1" }));
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await page.viewport(1440, 900);
});

test("shows clean, dirty, saving, and saved states without duplicate saves", async () => {
  let resolveSave!: (response: Response) => void;
  const saveResponse = new Promise<Response>((resolve) => {
    resolveSave = resolve;
  });
  const fetchMock = stubAiSettingsFetch({ saveResponse: () => saveResponse });

  await renderAiSettings("/bots/test-id/ai?section=replies");

  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect.element(page.getByText("All changes saved")).toBeVisible();
  await expect.element(page.getByText("Make a change to enable Save.")).toBeVisible();
  await expect.element(save).toBeDisabled();

  const systemPrompt = page.getByPlaceholder("You are a helpful assistant…");
  await systemPrompt.fill("Keep this draft");
  await expect.element(page.getByText("Unsaved changes", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Changes are ready to save.")).toBeVisible();
  await expect.element(save).toBeEnabled();

  const saveElement = save.element() as HTMLButtonElement;
  await save.click();
  await expect.element(page.getByText("Saving changes…")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Saving…" })).toBeDisabled();
  saveElement.click();
  const putCalls = fetchMock.mock.calls.filter(
    ([input, init]) => requestMethod(input, init) === "PUT",
  );
  expect(putCalls).toHaveLength(1);

  resolveSave(
    Response.json({
      ok: true,
      data: { ...DEFAULT_CONFIG, systemPrompt: "Keep this draft" },
      revision: "revision-2",
    }),
  );
  await expect.element(page.getByText("All changes saved")).toBeVisible();
  await expect.element(save).toBeDisabled();
});

test("keeps a failed save draft and shows a persistent error", async () => {
  await page.viewport(390, 844);
  const longError = `temporary-${"failure".repeat(350)}`;
  stubAiSettingsFetch({
    saveResponse: () => Response.json({ error: longError }, { status: 500 }),
  });
  await renderAiSettings("/bots/test-id/ai?section=replies");

  const systemPrompt = page.getByPlaceholder("You are a helpful assistant…");
  await systemPrompt.fill("Do not clear this draft");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect.element(page.getByText("Action failed")).toBeVisible();
  await expect.element(page.getByText(/Save failed/)).toBeVisible();
  await expect.element(systemPrompt).toHaveValue("Do not clear this draft");
  await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();

  const stickyHeader = page.getByTestId("ai-settings-sticky-header").element() as HTMLElement;
  const errorDetail = page.getByTestId("ai-settings-error-detail").element() as HTMLElement;
  expect(stickyHeader.offsetHeight).toBeLessThan(window.innerHeight / 2);
  expect(errorDetail.scrollWidth).toBeLessThanOrEqual(errorDetail.clientWidth);
});

test("retries runtime apply after reloading an already saved configuration", async () => {
  let putCount = 0;
  let savedOnServer = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/bots/test-id/ai-config")) {
        if (requestMethod(input, init) === "PUT") {
          putCount += 1;
          if (putCount === 1) {
            savedOnServer = true;
            return Response.json(
              { ok: false, code: "saved_apply_failed", error: "Runtime apply failed" },
              { status: 503 },
            );
          }
          return Response.json({
            ok: true,
            data: { ...DEFAULT_CONFIG, systemPrompt: "Saved but not applied" },
            revision: "revision-3",
          });
        }
        return Response.json({
          ok: true,
          data: {
            ...DEFAULT_CONFIG,
            systemPrompt: savedOnServer ? "Saved but not applied" : "",
          },
          revision: savedOnServer ? "revision-2" : "revision-1",
        });
      }
      if (url.endsWith("/api/authz/me")) {
        return Response.json({ data: { member: { role: "owner" } } });
      }
      if (url.endsWith("/api/bots/test-id")) {
        return Response.json({ ok: true, data: { id: "test-id", platform: "telegram" } });
      }
      return Response.json({ ok: false }, { status: 404 });
    }),
  );
  await renderAiSettings("/bots/test-id/ai?section=replies");

  const systemPrompt = page.getByPlaceholder("You are a helpful assistant…");
  await systemPrompt.fill("Saved but not applied");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect.element(page.getByText("Saved · runtime retry needed")).toBeVisible();
  await expect
    .element(page.getByText("Retry applying the saved configuration to the Bot runtime."))
    .toBeVisible();
  await expect.element(systemPrompt).toHaveValue("Saved but not applied");
  await expect.element(page.getByText("Unsaved changes", { exact: true })).not.toBeInTheDocument();
  const retry = page.getByRole("button", { name: "Retry runtime apply" });
  await expect.element(retry).toBeEnabled();

  await retry.click();
  await expect.element(page.getByText("All changes saved")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  expect(putCount).toBe(2);
});

test("clears a runtime apply retry when loading another Bot", async () => {
  let savedOnServer = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/bots/test-id/ai-config")) {
        if (requestMethod(input, init) === "PUT") {
          savedOnServer = true;
          return Response.json(
            { ok: false, code: "saved_apply_failed", error: "Runtime apply failed" },
            { status: 503 },
          );
        }
        return Response.json({
          ok: true,
          data: {
            ...DEFAULT_CONFIG,
            systemPrompt: savedOnServer ? "Saved for the first Bot" : "",
          },
          revision: savedOnServer ? "revision-2" : "revision-1",
        });
      }
      if (url.endsWith("/api/bots/other-id/ai-config")) {
        return Response.json({
          ok: true,
          data: { ...DEFAULT_CONFIG, systemPrompt: "Other Bot configuration" },
          revision: "other-revision-1",
        });
      }
      if (url.endsWith("/api/authz/me")) {
        return Response.json({ data: { member: { role: "owner" } } });
      }
      if (/\/api\/bots\/(?:test-id|other-id)$/.test(url)) {
        return Response.json({
          ok: true,
          data: { id: url.endsWith("other-id") ? "other-id" : "test-id", platform: "telegram" },
        });
      }
      return Response.json({ ok: false }, { status: 404 });
    }),
  );
  const { router } = await renderAiSettings("/bots/test-id/ai?section=replies");

  await page.getByPlaceholder("You are a helpful assistant…").fill("Saved for the first Bot");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.element(page.getByText("Saved · runtime retry needed")).toBeVisible();

  await router.navigate("/bots/other-id/ai?section=replies");
  await expect
    .element(page.getByPlaceholder("You are a helpful assistant…"))
    .toHaveValue("Other Bot configuration");
  await expect.element(page.getByText("All changes saved")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
});

test("discards the live selection draft and unlocks the catalog save state", async () => {
  stubAiSettingsFetch({ selection: GLOBAL_SELECTION });
  await renderAiSettings("/bots/test-id/ai?section=providers");

  await page.getByRole("combobox", { name: "Live reply Provider" }).click();
  await page.getByRole("option", { name: "Provider B" }).click();
  await expect.element(page.getByText("Live selection needs attention")).toBeVisible();
  await expect
    .element(page.getByText("Apply or discard the live selection draft before saving the catalog"))
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();

  await page.getByRole("button", { name: "Discard selection draft" }).click();
  await expect.element(page.getByText("All changes saved")).toBeVisible();
  await expect.element(page.getByText("Make a change to enable Save.")).toBeVisible();
  await expect
    .element(page.getByRole("combobox", { name: "Live reply Provider" }))
    .toHaveTextContent("Provider A");
});

test("allows query navigation but confirms Link and programmatic pathname changes", async () => {
  stubAiSettingsFetch();
  await renderAiSettings("/bots/test-id/ai?section=replies");

  const systemPrompt = page.getByPlaceholder("You are a helpful assistant…");
  await systemPrompt.fill("Protected draft");

  await page.getByRole("button", { name: /Memory/ }).click();
  await expect.element(page.getByLabelText("Current query")).toHaveTextContent("section=memory");
  await expect
    .element(page.getByRole("alertdialog", { name: "Leave with unsaved changes?" }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: /Reply Behavior/ }).click();
  await expect
    .element(page.getByPlaceholder("You are a helpful assistant…"))
    .toHaveValue("Protected draft");

  await page.getByRole("link", { name: "Test link outside" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Leave with unsaved changes?" });
  await expect.element(dialog).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Stay and keep editing" })).toHaveFocus();
  await page.getByRole("button", { name: "Stay and keep editing" }).click();
  await expect
    .element(page.getByPlaceholder("You are a helpful assistant…"))
    .toHaveValue("Protected draft");

  await page.getByRole("button", { name: "Test programmatic outside" }).click();
  await expect.element(dialog).toBeVisible();
  await page.getByRole("button", { name: "Leave without saving" }).click();
  await expect.element(page.getByText("Outside destination")).toBeVisible();
});

test("links Reply Behavior to the debugger engagement tab", async () => {
  stubAiSettingsFetch();

  await renderAiSettings("/bots/test-id/ai?section=replies");

  await page.getByRole("button", { name: /Smart group engagement/ }).click();
  const link = page.getByRole("link", { name: "View decision records" });
  await expect.element(link).toHaveAttribute("href", "/bots/test-id/debugger?tab=engagement");
  await link.click();
  await expect
    .element(page.getByText("Decision destination ?tab=engagement", { exact: true }))
    .toBeVisible();
});

test("finds settings with the keyboard and restores deep links through history", async () => {
  stubAiSettingsFetch();

  await renderAiSettings("/bots/test-id/ai");

  const search = page.getByRole("combobox", { name: "Search settings…" });
  await search.fill("timeouts");
  await expect.element(page.getByRole("option", { name: /Timeouts/ })).toBeVisible();
  await userEvent.keyboard("{Enter}");

  await expect
    .element(page.getByRole("button", { name: /Timeouts/ }))
    .toHaveAttribute("aria-expanded", "true");
  await vi.waitFor(() => {
    expect(document.activeElement?.id).toBe("ai-setting-timeouts-trigger");
  });
  await expect
    .element(page.getByLabelText("Current query"))
    .toHaveTextContent("?section=replies&setting=timeouts");
  await expect.element(page.getByText("Unsaved Changes")).not.toBeInTheDocument();

  await search.fill("embeddings");
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByRole("button", { name: /Embeddings/ }))
    .toHaveAttribute("aria-expanded", "true");
  await expect
    .element(page.getByLabelText("Current query"))
    .toHaveTextContent("?section=memory&setting=embeddings");

  const historyBack = page.getByRole("button", { name: "Test history back" });
  await historyBack.click();
  await expect
    .element(page.getByLabelText("Current query"))
    .toHaveTextContent("?section=replies&setting=timeouts");
  await expect
    .element(page.getByRole("button", { name: /Timeouts/ }))
    .toHaveAttribute("aria-expanded", "true");
  expect(document.activeElement?.textContent).toContain("Test history back");
});

test("does not select a search result while confirming IME input", async () => {
  stubAiSettingsFetch();

  await renderAiSettings("/bots/test-id/ai");

  const search = page.getByRole("combobox", { name: "Search settings…" });
  await search.fill("timeouts");
  const input = document.querySelector<HTMLInputElement>('[name="ai-settings-search"]')!;
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }),
  );
  await expect.element(search).toHaveValue("timeouts");
  await expect.element(page.getByLabelText("Current query")).not.toHaveTextContent("setting=");
  await expect.element(search).toHaveFocus();

  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByLabelText("Current query")).toHaveTextContent("setting=timeouts");
});

test("shows an empty search state that can be cleared", async () => {
  stubAiSettingsFetch();

  await renderAiSettings("/bots/test-id/ai");

  const search = page.getByRole("combobox", { name: "Search settings…" });
  await search.fill("timeouts");
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect.element(search).toHaveValue("");
  expect(document.activeElement?.getAttribute("name")).toBe("ai-settings-search");

  await search.fill("does-not-exist");
  await expect.element(page.getByText("No matching settings")).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).last().click();
  await expect.element(search).toHaveValue("");
  await expect.element(page.getByText("No matching settings")).not.toBeInTheDocument();
  expect(document.activeElement?.getAttribute("name")).toBe("ai-settings-search");
});

test("keeps the active keyboard result visible inside the result panel", async () => {
  stubAiSettingsFetch();

  await renderAiSettings("/bots/test-id/ai");

  const search = page.getByRole("combobox", { name: "Search settings…" });
  await search.fill("o");
  const input = document.querySelector<HTMLInputElement>('[name="ai-settings-search"]');
  expect(input).not.toBeNull();
  const listboxId = input!.getAttribute("aria-controls");
  expect(listboxId).toBeTruthy();
  const listbox = document.getElementById(listboxId!);
  expect(listbox).not.toBeNull();
  const options = Array.from(listbox!.querySelectorAll<HTMLElement>('[role="option"]'));
  expect(options.length).toBeGreaterThan(12);
  expect(options.every((option) => option.tabIndex === -1)).toBe(true);

  await userEvent.tab();
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Clear search");
  await search.click();
  const pageScrollBefore = window.scrollY;

  await userEvent.keyboard("{ArrowDown}".repeat(12));

  await vi.waitFor(() => {
    const activeOptionId = input!.getAttribute("aria-activedescendant");
    const activeOption = activeOptionId ? document.getElementById(activeOptionId) : null;
    expect(activeOption).not.toBeNull();
    const optionBounds = activeOption!.getBoundingClientRect();
    const listboxBounds = listbox!.getBoundingClientRect();
    expect(optionBounds.top).toBeGreaterThanOrEqual(listboxBounds.top - 1);
    expect(optionBounds.bottom).toBeLessThanOrEqual(listboxBounds.bottom + 1);
  });
  expect(listbox!.scrollTop).toBeGreaterThan(0);
  expect(window.scrollY).toBe(pageScrollBefore);
});

test("normalizes a direct setting link and searches localized labels", async () => {
  await i18n.changeLanguage("zh-CN");
  stubAiSettingsFetch();

  await renderAiSettings("/bots/test-id/ai?setting=timeouts");

  await expect.element(page.getByLabelText("Current query")).toHaveTextContent("setting=timeouts");
  await expect.element(page.getByLabelText("Current query")).toHaveTextContent("section=replies");
  await expect
    .element(page.getByRole("button", { name: /超时设置/ }))
    .toHaveAttribute("aria-expanded", "true");
  expect(document.activeElement?.id).not.toBe("ai-setting-timeouts-trigger");

  const search = page.getByRole("combobox", { name: "搜索设置…" });
  await search.fill("图片 OCR");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByLabelText("Current query")).toHaveTextContent("section=tools");
  await expect.element(page.getByLabelText("Current query")).toHaveTextContent("setting=image-ocr");
  await expect
    .element(page.getByRole("button", { name: /图片 OCR/ }))
    .toHaveAttribute("aria-expanded", "true");
});

test("scrolls a direct setting link after delayed config loading mounts the target", async () => {
  const resolveConfig = stubAiSettingsFetchWithDeferredConfig();
  const scrolledElements: Element[] = [];
  vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
    scrolledElements.push(this);
  });

  await renderAiSettings("/bots/test-id/ai?setting=image-ocr");

  expect(document.getElementById("ai-setting-image-ocr")).toBeNull();
  resolveConfig();

  await expect
    .element(page.getByRole("button", { name: /Image OCR/ }))
    .toHaveAttribute("aria-expanded", "true");
  const target = document.getElementById("ai-setting-image-ocr");
  expect(target).not.toBeNull();
  await vi.waitFor(() => {
    expect(scrolledElements).toContain(target);
  });
  expect(document.activeElement?.id).not.toBe("ai-setting-image-ocr-trigger");
});

test("opens GitHub tools after an OAuth callback", async () => {
  stubAiSettingsFetch();

  await renderAiSettings("/bots/test-id/ai?githubApp=connected");

  await expect
    .element(page.getByLabelText("Current query"))
    .toHaveTextContent("?section=tools&setting=github-tools");
  await expect
    .element(page.getByRole("button", { name: /GitHub identity and code access/ }))
    .toHaveAttribute("aria-expanded", "true");
});

test("keeps setting summaries visible on a mobile viewport", async () => {
  stubAiSettingsFetch();
  await page.viewport(390, 844);

  await renderAiSettings("/bots/test-id/ai?section=memory");

  await expect.element(page.getByRole("button", { name: /Conversation memory/ })).toBeVisible();
  const row = document.getElementById("ai-setting-conversation-memory");
  expect(row).not.toBeNull();
  await expect.element(page.elementLocator(row!).getByText("Disabled").first()).toBeVisible();
});

test("keeps save and category navigation reachable in a narrow desktop workspace", async () => {
  await page.viewport(768, 900);
  stubAiSettingsFetch();
  await renderAiSettings("/bots/test-id/ai?section=replies");
  await expect.element(page.getByTestId("ai-settings-sticky-header")).toBeVisible();
  const header = page.getByTestId("ai-settings-sticky-header").element() as HTMLElement;
  const workspace = header.parentElement!;
  // A desktop sidebar leaves only this much room even though the viewport is wider.
  workspace.style.width = "460px";
  const prompt = page.getByPlaceholder("You are a helpful assistant…");
  await prompt.fill("Keep this draft while switching categories");
  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect.element(save).toBeEnabled();
  await expect
    .poll(() => {
      const button = save.element().getBoundingClientRect();
      const bounds = header.getBoundingClientRect();
      return button.left >= bounds.left && button.right <= bounds.right;
    })
    .toBe(true);
  const sections = page.getByRole("combobox", { name: "Settings section", exact: true });
  await expect.element(sections).toBeVisible();
  await sections.click();
  await page.getByRole("option", { name: "Memory", exact: true }).click();
  await sections.click();
  await page.getByRole("option", { name: "Reply Behavior", exact: true }).click();
  await expect.element(prompt).toHaveValue("Keep this draft while switching categories");
  await save.click();
  await expect.element(page.getByText("All changes saved", { exact: true })).toBeVisible();
});
