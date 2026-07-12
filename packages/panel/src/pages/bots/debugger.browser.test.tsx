import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { MemoryRouter, Route, Routes } from "react-router";
import { expect, test, vi } from "vitest";
import { BotDebuggerPage } from "./debugger";

test("offers message and raw Channel event dry-runs", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ ok: true, data: [] }), { status: 200 })),
  );
  render(
    <MemoryRouter initialEntries={["/bots/test-id/debugger"]}>
      <Routes>
        <Route path="/bots/:botId/debugger" element={<BotDebuggerPage />} />
      </Routes>
    </MemoryRouter>,
  );
  await expect.element(page.getByRole("heading", { name: "AI Debugger" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Raw Channel Event" })).toBeVisible();
  await page.getByRole("button", { name: "Raw Channel Event" }).click();
  await expect.element(page.getByLabelText("Raw channel event")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Run dry-run" })).toBeVisible();
});
