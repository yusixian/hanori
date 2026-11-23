import "@/style.css";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { i18n } from "@/i18n";
import { ImageMcpPlatformSettings } from "./image-mcp-platform-settings";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await page.viewport(1440, 900);
});

test.each([1440, 390])(
  "saves a single domain and displays the normalized platform at %s px",
  async (width) => {
    await page.viewport(width, 900);
    const onSaved = vi.fn();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Response(
          JSON.stringify({
            ok: true,
            data:
              init?.method === "PUT"
                ? { baseUrl: "https://mcp.example.com", revision: 1 }
                : { baseUrl: "", revision: 0 },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <div className="p-4">
        <ImageMcpPlatformSettings onSaved={onSaved} />
      </div>,
    );
    const address = page.getByLabelText("Platform address");
    await expect.element(address).toBeEnabled();
    await address.fill("mcp.example.com");
    await page.getByRole("button", { name: "Save platform address" }).click();
    await expect.element(address).toHaveValue("https://mcp.example.com");
    await expect.element(page.getByRole("status")).toHaveTextContent("Platform address applied");
    expect(onSaved).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls.find((call) => call[1]?.method === "PUT")?.[1];
    expect(JSON.parse(String(request?.body))).toEqual({ baseUrl: "mcp.example.com", revision: 0 });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `../../../../../.acceptance/image-mcp-platform-${width}.png` });
  },
);

test("keeps the draft and avoids success feedback when another tab has changed the platform", async () => {
  const onSaved = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "PUT"
        ? new Response(JSON.stringify({ ok: false, error: "conflict" }), { status: 409 })
        : new Response(
            JSON.stringify({ ok: true, data: { baseUrl: "https://old.example.com", revision: 1 } }),
          ),
    ),
  );
  render(<ImageMcpPlatformSettings onSaved={onSaved} />);
  const address = page.getByLabelText("Platform address");
  await expect.element(address).toBeEnabled();
  await address.fill("new.example.com");
  await page.getByRole("button", { name: "Save platform address" }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("changed elsewhere");
  await expect.element(address).toHaveValue("new.example.com");
  expect(onSaved).not.toHaveBeenCalled();
});

test("prevents saving when the existing configuration could not be loaded", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 503 })),
  );
  render(<ImageMcpPlatformSettings onSaved={() => {}} />);
  await expect.element(page.getByRole("alert")).toHaveTextContent("Couldn't load");
  await expect.element(page.getByRole("button", { name: "Save platform address" })).toBeDisabled();
});
