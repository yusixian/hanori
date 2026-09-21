import { i18n } from "@/i18n";
import "@/style.css";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BotAiSettingsPage } from "./ai-settings-page";
import { DEFAULT_CONFIG } from "./types";

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
      <BotAiSettingsPage />
    </>
  );
}

function stubAiSettingsFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/bots/test-id/ai-config")) {
        return Response.json({ ok: true, data: DEFAULT_CONFIG, revision: "revision-1" });
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

test("links Reply Behavior to the debugger engagement tab", async () => {
  stubAiSettingsFetch();

  render(
    <MemoryRouter initialEntries={["/bots/test-id/ai?section=replies"]}>
      <Routes>
        <Route path="/bots/:botId/ai" element={<BotAiSettingsPage />} />
        <Route path="/bots/:botId/debugger" element={<Destination />} />
      </Routes>
    </MemoryRouter>,
  );

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

  render(
    <MemoryRouter initialEntries={["/bots/test-id/ai"]}>
      <Routes>
        <Route path="/bots/:botId/ai" element={<PageHarness />} />
      </Routes>
    </MemoryRouter>,
  );

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

  render(
    <MemoryRouter initialEntries={["/bots/test-id/ai"]}>
      <Routes>
        <Route path="/bots/:botId/ai" element={<PageHarness />} />
      </Routes>
    </MemoryRouter>,
  );

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

  render(
    <MemoryRouter initialEntries={["/bots/test-id/ai"]}>
      <Routes>
        <Route path="/bots/:botId/ai" element={<BotAiSettingsPage />} />
      </Routes>
    </MemoryRouter>,
  );

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

  render(
    <MemoryRouter initialEntries={["/bots/test-id/ai"]}>
      <Routes>
        <Route path="/bots/:botId/ai" element={<BotAiSettingsPage />} />
      </Routes>
    </MemoryRouter>,
  );

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

  render(
    <MemoryRouter initialEntries={["/bots/test-id/ai?setting=timeouts"]}>
      <Routes>
        <Route path="/bots/:botId/ai" element={<PageHarness />} />
      </Routes>
    </MemoryRouter>,
  );

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

  render(
    <MemoryRouter initialEntries={["/bots/test-id/ai?setting=image-ocr"]}>
      <Routes>
        <Route path="/bots/:botId/ai" element={<PageHarness />} />
      </Routes>
    </MemoryRouter>,
  );

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

  render(
    <MemoryRouter initialEntries={["/bots/test-id/ai?githubApp=connected"]}>
      <Routes>
        <Route path="/bots/:botId/ai" element={<PageHarness />} />
      </Routes>
    </MemoryRouter>,
  );

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

  render(
    <MemoryRouter initialEntries={["/bots/test-id/ai?section=memory"]}>
      <Routes>
        <Route path="/bots/:botId/ai" element={<BotAiSettingsPage />} />
      </Routes>
    </MemoryRouter>,
  );

  await expect.element(page.getByRole("button", { name: /Conversation memory/ })).toBeVisible();
  const row = document.getElementById("ai-setting-conversation-memory");
  expect(row).not.toBeNull();
  await expect.element(page.elementLocator(row!).getByText("Disabled").first()).toBeVisible();
});
