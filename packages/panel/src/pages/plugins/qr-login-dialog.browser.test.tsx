import "@/style.css";
import { i18n } from "@/i18n";
import type { PluginBotState, PluginLoginState } from "@cos-tool-bot/shared";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { beforeEach, expect, test, vi } from "vitest";
import { PluginRequestError, type PluginsApi } from "./api";
import { PluginQrLoginDialog } from "./qr-login-dialog";

type LoginApi = Pick<PluginsApi, "startLogin" | "pollLogin" | "cancelLogin">;
const botState: PluginBotState = {
  configuration: { values: { region: "saved-region" }, configuredSecrets: ["cookie"] },
  revision: 4,
  manifestHash: "synthetic-manifest",
  configuredVersion: "1.0.0",
  enabled: false,
  needsReview: false,
  updatedAt: null,
  runtime: { status: "disabled", error: null },
};
function session(overrides: Partial<PluginLoginState> = {}): PluginLoginState {
  return {
    id: "synthetic-session",
    status: "waiting",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    qrUrl: "https://example.test/sign-in/synthetic",
    ...overrides,
  };
}
function api(overrides: Partial<LoginApi> = {}): LoginApi {
  return {
    startLogin: vi.fn(async () => session()),
    pollLogin: vi.fn(async () => session()),
    cancelLogin: vi.fn(async () => session({ status: "cancelled", qrUrl: undefined })),
    ...overrides,
  };
}
function props(input: LoginApi) {
  return {
    pluginId: "synthetic.plugin",
    botId: "bot-1",
    request: { expectedRevision: 3, manifestHash: "synthetic-manifest" },
    api: input,
    onConnected: vi.fn(),
    onClose: vi.fn(),
  };
}
beforeEach(async () => {
  await i18n.changeLanguage("en");
  await page.viewport(1024, 900);
});

test("renders QR locally, moves from scanned to saved connection, and stops polling", async () => {
  const input = api({
    pollLogin: vi
      .fn<LoginApi["pollLogin"]>()
      .mockResolvedValueOnce(session({ status: "scanned", qrUrl: undefined }))
      .mockResolvedValueOnce(
        session({
          status: "connected",
          qrUrl: undefined,
          botState,
          account: { name: "Synthetic account" },
        }),
      ),
  });
  const config = props(input);
  const view = await render(<PluginQrLoginDialog {...config} />);
  await expect.element(page.getByRole("img", { name: "Platform sign-in QR code" })).toBeVisible();
  const image = page.getByRole("img").element() as HTMLImageElement;
  expect(image.src).toMatch(/^data:image\/png;base64,/);
  expect(image.naturalWidth).toBe(280);
  expect(input.startLogin).toHaveBeenCalledWith("synthetic.plugin", "bot-1", config.request);
  expect(config.onConnected).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(document.body.textContent).toContain("Scanned. Confirm"), {
    timeout: 4_000,
  });
  expect(config.onConnected).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(config.onConnected).toHaveBeenCalledWith(botState), {
    timeout: 4_000,
  });
  await expect.element(page.getByText("Connected account: Synthetic account")).toBeVisible();
  expect(input.startLogin).toHaveBeenCalledTimes(1);
  expect(input.pollLogin).toHaveBeenCalledTimes(2);
  await view.unmount();
  expect(input.cancelLogin).not.toHaveBeenCalled();
}, 12_000);

test("serializes polling even when a response takes longer than the interval", async () => {
  let finish!: (value: PluginLoginState) => void;
  const input = api({
    pollLogin: vi.fn(
      () =>
        new Promise<PluginLoginState>((resolve) => {
          finish = resolve;
        }),
    ),
  });
  const view = await render(<PluginQrLoginDialog {...props(input)} />);
  await vi.waitFor(() => expect(input.pollLogin).toHaveBeenCalledTimes(1), { timeout: 4_000 });
  await new Promise((resolve) => setTimeout(resolve, 2_200));
  expect(input.pollLogin).toHaveBeenCalledTimes(1);
  finish(session({ status: "expired" }));
  await expect.element(page.getByText(/QR code has expired/)).toBeVisible();
  await view.unmount();
}, 10_000);

test("keeps polling a save beyond QR expiry and does not cancel an in-progress save on close", async () => {
  const input = api({
    startLogin: vi.fn(async () =>
      session({
        status: "saving",
        qrUrl: undefined,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ),
    pollLogin: vi.fn(async () => session({ status: "saving", qrUrl: undefined })),
  });
  const config = props(input);
  const view = await render(<PluginQrLoginDialog {...config} />);
  await expect.element(page.getByText(/Saving sign-in details/)).toBeVisible();
  await expect.element(page.getByRole("img")).not.toBeInTheDocument();
  await vi.waitFor(() => expect(input.pollLogin).toHaveBeenCalledTimes(1), { timeout: 4000 });
  await view.unmount();
  expect(input.cancelLogin).not.toHaveBeenCalled();
  expect(config.onConnected).not.toHaveBeenCalled();
});

test("an uncertain save requires refreshing configuration instead of another login attempt", async () => {
  const input = api({
    startLogin: vi.fn(async () => session({ status: "save_unknown", qrUrl: undefined })),
  });
  const config = props(input);
  const onConflict = vi.fn();
  const view = await render(<PluginQrLoginDialog {...config} onConflict={onConflict} />);
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("save result could not be confirmed");
  expect(onConflict).toHaveBeenCalledOnce();
  expect(config.onConnected).not.toHaveBeenCalled();
  await expect
    .element(page.getByRole("button", { name: "Get a new QR code" }))
    .not.toBeInTheDocument();
  await view.unmount();
});

test("closing while start is pending cancels the returned session exactly once", async () => {
  let finish!: (value: PluginLoginState) => void;
  const input = api({
    startLogin: vi.fn(
      () =>
        new Promise<PluginLoginState>((resolve) => {
          finish = resolve;
        }),
    ),
  });
  const config = props(input);
  const view = await render(<PluginQrLoginDialog {...config} onClose={() => view.unmount()} />);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  finish(session());
  await vi.waitFor(() =>
    expect(input.cancelLogin).toHaveBeenCalledWith(
      "synthetic.plugin",
      "bot-1",
      "synthetic-session",
    ),
  );
  expect(input.cancelLogin).toHaveBeenCalledTimes(1);
  expect(input.pollLogin).not.toHaveBeenCalled();
  expect(config.onConnected).not.toHaveBeenCalled();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});

test("scope change cancels the old session and ignores its late connected response", async () => {
  let finish!: (value: PluginLoginState) => void;
  const input = api({
    pollLogin: vi.fn(
      () =>
        new Promise<PluginLoginState>((resolve) => {
          finish = resolve;
        }),
    ),
  });
  const config = props(input);
  const view = await render(<PluginQrLoginDialog {...config} />);
  await vi.waitFor(() => expect(input.pollLogin).toHaveBeenCalledTimes(1), { timeout: 4_000 });
  await view.rerender(<PluginQrLoginDialog {...config} botId="bot-2" />);
  await vi.waitFor(() => expect(input.startLogin).toHaveBeenCalledTimes(2));
  expect(input.cancelLogin).toHaveBeenCalledWith("synthetic.plugin", "bot-1", "synthetic-session");
  finish(session({ status: "connected", botState }));
  await expect.element(page.getByText("Waiting for you to scan and confirm…")).toBeVisible();
  expect(config.onConnected).not.toHaveBeenCalled();
  await view.unmount();
}, 8_000);

test("server expiry stops waiting and retry creates a fresh QR session", async () => {
  const input = api({
    startLogin: vi
      .fn<LoginApi["startLogin"]>()
      .mockResolvedValueOnce(session({ status: "expired", qrUrl: undefined }))
      .mockResolvedValueOnce(session({ id: "fresh-session" })),
  });
  const view = await render(<PluginQrLoginDialog {...props(input)} />);
  await expect.element(page.getByText(/QR code has expired/)).toBeVisible();
  expect(input.cancelLogin).not.toHaveBeenCalled();
  expect(input.pollLogin).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Get a new QR code" }).click();
  await expect.element(page.getByRole("img")).toBeVisible();
  expect(input.startLogin).toHaveBeenCalledTimes(2);
  await expect.element(page.getByText("Waiting for you to scan and confirm…")).toBeVisible();
  await view.unmount();
  expect(input.cancelLogin).toHaveBeenLastCalledWith("synthetic.plugin", "bot-1", "fresh-session");
});

test("failed start keeps error text generic and retry succeeds without exposing credentials", async () => {
  const input = api({
    startLogin: vi
      .fn<LoginApi["startLogin"]>()
      .mockRejectedValueOnce(new Error("synthetic-private-cookie"))
      .mockResolvedValueOnce(session()),
  });
  const view = await render(<PluginQrLoginDialog {...props(input)} />);
  await expect.element(page.getByRole("alert")).toHaveTextContent("Sign-in could not be completed");
  expect(document.body.textContent).not.toContain("synthetic-private-cookie");
  await page.getByRole("button", { name: "Get a new QR code" }).click();
  await expect.element(page.getByRole("img")).toBeVisible();
  await view.unmount();
});

test("conflict asks for explicit reload and a connected response without saved state never confirms success", async () => {
  const input = api({
    startLogin: vi.fn(async () => {
      throw new PluginRequestError(true);
    }),
  });
  const onConflict = vi.fn();
  const config = props(input);
  const view = await render(<PluginQrLoginDialog {...config} onConflict={onConflict} />);
  await expect.element(page.getByRole("alert")).toHaveTextContent("reload the saved configuration");
  expect(onConflict).toHaveBeenCalledTimes(1);
  expect(config.onConnected).not.toHaveBeenCalled();
  await view.unmount();
  const malformed = props(api({ startLogin: vi.fn(async () => session({ status: "connected" })) }));
  render(<PluginQrLoginDialog {...malformed} />);
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("save result could not be confirmed");
  expect(malformed.onConnected).not.toHaveBeenCalled();
});

test("Chinese QR dialog fits mobile and Escape cancels the pending session", async () => {
  await i18n.changeLanguage("zh-CN");
  await page.viewport(390, 844);
  const input = api();
  const view = await render(
    <PluginQrLoginDialog {...props(input)} onClose={() => view.unmount()} />,
  );
  await expect.element(page.getByRole("img", { name: "平台登录二维码" })).toBeVisible();
  const dialog = page.getByRole("dialog").element();
  expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(input.cancelLogin).toHaveBeenCalledTimes(1);
});
