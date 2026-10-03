import type { PluginLoginAttempt } from "@cos-tool-bot/shared";
import { LoginProviderError, LoginTransport, accountName, record } from "./transport.js";

const PASSPORT = "https://passport.bilibili.com/x/passport-login/web/qrcode";
const COOKIE_ORIGIN = "https://api.bilibili.com/";

async function verifiedAccount(
  transport: LoginTransport,
  signal: AbortSignal,
): Promise<{ name: string }> {
  const cookie = transport.cookieFor(COOKIE_ORIGIN);
  if (!/(?:^|;\s*)SESSDATA=[^;]+/.test(cookie)) throw new LoginProviderError("invalid_response");
  const response = await transport.json("https://api.bilibili.com/x/web-interface/nav", signal);
  const data = record(response.data);
  if (
    response.code !== 0 ||
    data.isLogin !== true ||
    !Number.isSafeInteger(data.mid) ||
    Number(data.mid) <= 0
  )
    throw new LoginProviderError("invalid_response");
  const userId = /(?:^|;\s*)DedeUserID=(\d+)(?:;|$)/.exec(cookie)?.[1];
  if (userId && Number(userId) !== data.mid) throw new LoginProviderError("invalid_response");
  return { name: accountName(data.uname) };
}

export async function startBilibiliLogin(signal: AbortSignal): Promise<PluginLoginAttempt> {
  const transport = new LoginTransport("bilibili", signal);
  try {
    const response = await transport.json(`${PASSPORT}/generate`, signal);
    const data = record(response.data);
    if (
      response.code !== 0 ||
      typeof data.qrcode_key !== "string" ||
      !/^[a-f0-9]{32}$/i.test(data.qrcode_key) ||
      typeof data.url !== "string" ||
      data.url.length > 4_096
    )
      throw new LoginProviderError("invalid_response");
    let qr: URL;
    try {
      qr = new URL(data.url);
    } catch {
      throw new LoginProviderError("invalid_response");
    }
    if (
      qr.origin !== "https://account.bilibili.com" ||
      qr.pathname !== "/h5/account-h5/auth/scan-web" ||
      qr.username ||
      qr.password ||
      qr.port ||
      qr.hash ||
      qr.searchParams.getAll("qrcode_key").length !== 1 ||
      qr.searchParams.get("qrcode_key") !== data.qrcode_key
    )
      throw new LoginProviderError("invalid_response");
    let key = data.qrcode_key;
    let polling = false;
    let terminal = false;
    return {
      qrUrl: qr.href,
      async poll(pollSignal) {
        if (terminal || polling) throw new LoginProviderError("unavailable");
        polling = true;
        try {
          const response = await transport.json(
            `${PASSPORT}/poll?qrcode_key=${encodeURIComponent(key)}`,
            pollSignal,
          );
          const data = record(response.data);
          if (response.code !== 0) throw new LoginProviderError("unavailable");
          if (data.code === 86101) return { status: "waiting" };
          if (data.code === 86090) return { status: "scanned" };
          if (data.code === 86038) {
            terminal = true;
            key = "";
            transport.dispose();
            return { status: "expired" };
          }
          if (data.code !== 0 || typeof data.url !== "string")
            throw new LoginProviderError("invalid_response");
          // The current browser follows this URL. Credentials come from response cookies,
          // never from legacy URL query parameters or a refresh_token presented as a Cookie.
          await transport.follow(data.url, pollSignal);
          const account = await verifiedAccount(transport, pollSignal);
          const cookie = transport.cookieFor(COOKIE_ORIGIN);
          terminal = true;
          key = "";
          transport.dispose();
          return { status: "authorized", secrets: { cookie }, account };
        } catch (error) {
          terminal = true;
          key = "";
          transport.dispose();
          throw error;
        } finally {
          polling = false;
        }
      },
      dispose() {
        terminal = true;
        key = "";
        transport.dispose();
      },
    };
  } catch (error) {
    transport.dispose();
    throw error;
  }
}
