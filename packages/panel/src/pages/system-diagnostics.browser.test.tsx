import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { i18n } from "@/i18n";
import "@/style.css";
import SystemDiagnosticsPage from "./system-diagnostics";

const healthy = {
  version: "a".repeat(40),
  mode: "production",
  status: "ready",
  databaseReady: true,
  migrationsReady: true,
  authOrigin: "https://panel.test",
  requestProtocol: "http",
  forwardedProtocol: "https",
  protocolMatches: true,
  panelPasswordPresent: false,
  independentMiniAppSecret: true,
  httpsOrigin: true,
  integrations: {
    "quote-worker": "reachable",
    "media-worker": "reachable",
    "coding-worker": "reachable",
    "nsfw-api": "reachable",
  },
};
const respond = (data: unknown) => Response.json({ ok: true, data });

afterEach(async () => {
  vi.unstubAllGlobals();
  await page.viewport(1440, 900);
});
test("refreshes healthy diagnostics and explains warnings and failed services", async () => {
  await i18n.changeLanguage("en");
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(respond(healthy))
    .mockResolvedValueOnce(
      respond({
        ...healthy,
        panelPasswordPresent: true,
        protocolMatches: false,
        forwardedProtocol: "http",
        integrations: {
          ...healthy.integrations,
          "nsfw-api": "disabled",
          "coding-worker": "unavailable",
        },
      }),
    );
  vi.stubGlobal("fetch", fetch);
  await render(<SystemDiagnosticsPage />);
  await expect.element(page.getByText(healthy.version)).toBeVisible();
  expect(page.getByText("Healthy", { exact: true }).elements()).toHaveLength(12);
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect.element(page.getByText(/After the first owner login/)).toBeVisible();
  await expect.element(page.getByText(/configure the reverse proxy/)).toBeVisible();
  await expect.element(page.getByText(/verify the shared CODING_WORKER_SECRET/)).toBeVisible();
  await expect.element(page.getByText("Disabled", { exact: true })).toBeVisible();
  expect(fetch).toHaveBeenCalledTimes(2);
});
test("fits a full commit and long origin on a Chinese mobile viewport", async () => {
  await page.viewport(320, 844);
  await i18n.changeLanguage("zh-CN");
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        respond({ ...healthy, authOrigin: "https://" + "panel".repeat(12) + ".test" }),
      ),
  );
  await render(<SystemDiagnosticsPage />);
  await expect.element(page.getByRole("heading", { name: "系统诊断与健康中心" })).toBeVisible();
  await expect.element(page.getByText(healthy.version)).toBeVisible();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
});
test("shows an access denial without diagnostics", async () => {
  await i18n.changeLanguage("en");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 403 })));
  await render(<SystemDiagnosticsPage />);
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Only workspace owners and administrators");
  await expect.element(page.getByText("Deployment commit")).not.toBeInTheDocument();
});
