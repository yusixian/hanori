import { i18n } from "@/i18n";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BotAiSettingsPage } from "./ai-settings-page";
import { DEFAULT_CONFIG } from "./types";

function Destination() {
  const location = useLocation();
  return <p>Decision destination {location.search}</p>;
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("links Reply Behavior to the debugger engagement tab", async () => {
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
