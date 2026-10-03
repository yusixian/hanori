import { constants, createCipheriv, publicEncrypt, randomInt } from "node:crypto";
import type { PluginLoginAttempt } from "@cos-tool-bot/shared";
import { LoginProviderError, LoginTransport, accountName, record } from "./transport.js";

const ORIGIN = "https://music.163.com/";
const IV = Buffer.from("0102030405060708");
const PRESET_KEY = Buffer.from("0CoJUm6Qyw8W8jud");
// Public key from the official web client, not an account credential.
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;

function aes(value: string, key: Buffer): string {
  const cipher = createCipheriv("aes-128-cbc", key, IV);
  return Buffer.concat([cipher.update(value, "utf8"), cipher.final()]).toString("base64");
}

/** Independently implements the official web client's two AES layers and raw RSA envelope. */
export function encryptWeapi(data: Record<string, unknown>): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const secret = Array.from({ length: 16 }, () => alphabet[randomInt(alphabet.length)]).join("");
  const block = Buffer.alloc(128);
  Buffer.from([...secret].reverse().join("")).copy(block, 112);
  const encSecKey = publicEncrypt(
    { key: PUBLIC_KEY, padding: constants.RSA_NO_PADDING },
    block,
  ).toString("hex");
  return new URLSearchParams({
    params: aes(aes(JSON.stringify(data), PRESET_KEY), Buffer.from(secret)),
    encSecKey,
  }).toString();
}

async function post(
  transport: LoginTransport,
  path: string,
  data: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const cookie = transport.cookieFor(ORIGIN);
  const csrf = /(?:^|;\s*)__csrf=([^;]*)/.exec(cookie)?.[1] ?? "";
  return transport.json(
    `${ORIGIN}weapi/${path}`,
    signal,
    encryptWeapi({ ...data, csrf_token: csrf }),
  );
}

async function verifiedAccount(
  transport: LoginTransport,
  signal: AbortSignal,
): Promise<{ name: string }> {
  if (!/(?:^|;\s*)MUSIC_U=[^;]+/.test(transport.cookieFor(ORIGIN)))
    throw new LoginProviderError("invalid_response");
  const response = await post(transport, "w/nuser/account/get", {}, signal);
  const profile = record(response.profile);
  const account = record(response.account);
  if (
    response.code !== 200 ||
    !Number.isSafeInteger(profile.userId) ||
    Number(profile.userId) <= 0 ||
    account.id !== profile.userId
  )
    throw new LoginProviderError("invalid_response");
  return { name: accountName(profile.nickname) };
}

export async function startNeteaseLogin(signal: AbortSignal): Promise<PluginLoginAttempt> {
  const transport = new LoginTransport("netease", signal);
  try {
    const response = await post(transport, "login/qrcode/unikey", { type: 1 }, signal);
    if (
      response.code !== 200 ||
      typeof response.unikey !== "string" ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(response.unikey)
    )
      throw new LoginProviderError("invalid_response");
    let key = response.unikey;
    let terminal = false;
    let polling = false;
    return {
      // This is the official scanner payload; server requests still use HTTPS exclusively.
      qrUrl: `http://music.163.com/login?codekey=${encodeURIComponent(key)}`,
      async poll(pollSignal) {
        if (terminal || polling) throw new LoginProviderError("unavailable");
        polling = true;
        try {
          const response = await post(
            transport,
            "login/qrcode/client/login",
            { key, type: 1 },
            pollSignal,
          );
          if (response.code === 801) return { status: "waiting" };
          if (response.code === 802) return { status: "scanned" };
          if (response.code === 800) {
            terminal = true;
            key = "";
            transport.dispose();
            return { status: "expired" };
          }
          if (response.code !== 803) throw new LoginProviderError("invalid_response");
          const account = await verifiedAccount(transport, pollSignal);
          const cookie = transport.cookieFor(ORIGIN);
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
