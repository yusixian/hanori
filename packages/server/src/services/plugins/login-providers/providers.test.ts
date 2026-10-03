import { EventEmitter } from "node:events";
import { createDecipheriv } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { request } from "node:https";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startBilibiliLogin, startNeteaseLogin } from "./index.js";
import { encryptWeapi } from "./netease.js";
import { LoginTransport } from "./transport.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("node:https", () => ({ request: vi.fn() }));
const cryptoState = vi.hoisted(() => ({ next: 0 }));
vi.mock("node:crypto", async (original) => ({
  ...(await original<typeof import("node:crypto")>()),
  randomInt: vi.fn(() => cryptoState.next++ % 16),
}));

const key = "a".repeat(32);
const neteaseKey = "00000000-0000-0000-0000-000000000001";
const signal = new AbortController().signal;
const queue: IncomingMessage[] = [];
const bodies: Array<string | undefined> = [];

function response(
  value: unknown,
  headers: IncomingHttpHeaders = {},
  status = 200,
): IncomingMessage {
  const stream = Readable.from([
    typeof value === "string" ? value : JSON.stringify(value),
  ]) as IncomingMessage;
  stream.statusCode = status;
  stream.headers = { "content-type": "application/json", ...headers };
  queue.push(stream);
  return stream;
}

function biliCreate(): void {
  response({
    code: 0,
    data: {
      qrcode_key: key,
      url: `https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=${key}`,
    },
  });
}

function options(index: number): RequestOptions {
  return vi.mocked(request).mock.calls[index]![0] as RequestOptions;
}

function decryptWeapi(body: string): Record<string, unknown> {
  const params = new URLSearchParams(body);
  const decrypt = (text: string, aesKey: string) => {
    const cipher = createDecipheriv(
      "aes-128-cbc",
      Buffer.from(aesKey),
      Buffer.from("0102030405060708"),
    );
    return Buffer.concat([cipher.update(Buffer.from(text, "base64")), cipher.final()]).toString(
      "utf8",
    );
  };
  return JSON.parse(
    decrypt(decrypt(params.get("params")!, "0123456789abcdef"), "0CoJUm6Qyw8W8jud"),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  cryptoState.next = 0;
  queue.length = 0;
  bodies.length = 0;
  vi.mocked(lookup).mockResolvedValue([{ address: "8.8.8.8", family: 4 }] as never);
  vi.mocked(request).mockImplementation(((
    opts: { signal: AbortSignal },
    callback: (res: IncomingMessage) => void,
  ) => {
    const req = new EventEmitter() as EventEmitter & { end(body?: string): void };
    req.end = (body) => {
      bodies.push(body);
      queueMicrotask(() => {
        const res = queue.shift();
        if (!res) {
          req.emit("error", new Error("Synthetic transport error"));
          return;
        }
        const abort = () => res.destroy(new Error("Synthetic abort"));
        opts.signal.addEventListener("abort", abort, { once: true });
        res.once("close", () => opts.signal.removeEventListener("abort", abort));
        callback(res);
      });
    };
    req.once("error", () => {});
    return req;
  }) as never);
});

afterEach(() => {
  for (const res of queue) res.destroy();
  vi.restoreAllMocks();
});

describe("Bilibili QR provider", () => {
  it("maps official waiting/scanned/expired states without exposing a key separately", async () => {
    biliCreate();
    response({ code: 0, data: { code: 86101 } });
    response({ code: 0, data: { code: 86090 } });
    response({ code: 0, data: { code: 86038 } });
    const attempt = await startBilibiliLogin(signal);
    expect(Object.keys(attempt).sort()).toEqual(["dispose", "poll", "qrUrl"]);
    expect(await attempt.poll(signal)).toEqual({ status: "waiting" });
    expect(await attempt.poll(signal)).toEqual({ status: "scanned" });
    expect(await attempt.poll(signal)).toEqual({ status: "expired" });
    await expect(attempt.poll(signal)).rejects.toMatchObject({ code: "unavailable" });
    expect(options(0).headers).not.toHaveProperty("Cookie");
  });

  it("follows the crossDomain chain with domain-aware cookies and verifies nav before authorization", async () => {
    biliCreate();
    response({
      code: 0,
      data: {
        code: 0,
        url: "https://passport.biligame.com/x/passport-login/web/crossDomain?ticket=synthetic",
        refresh_token: "synthetic-unused",
      },
    });
    response(
      "",
      {
        location: "https://passport.bilibili.com/x/passport-login/web/crossDomain?ticket=next",
        "set-cookie": [
          "game=only-game; Domain=.biligame.com; Path=/; Secure",
          "SESSDATA=forged; Domain=.bilibili.com; Path=/; Secure",
        ],
      },
      302,
    );
    response(
      "",
      {
        location: "https://www.bilibili.com/",
        "set-cookie": [
          "SESSDATA=synthetic; Domain=.bilibili.com; Path=/; Secure; HttpOnly",
          "bili_jct=synthetic; Domain=.bilibili.com; Path=/; Secure",
          "DedeUserID=123; Domain=.bilibili.com; Path=/; Secure",
        ],
      },
      302,
    );
    response({ code: 0, data: { isLogin: true, mid: 123, uname: "Fixture user" } });
    const attempt = await startBilibiliLogin(signal);
    const result = await attempt.poll(signal);
    expect(result).toEqual({
      status: "authorized",
      secrets: { cookie: "SESSDATA=synthetic; bili_jct=synthetic; DedeUserID=123" },
      account: { name: "Fixture user" },
    });
    expect(options(2).headers).not.toHaveProperty("Cookie");
    expect(options(3).headers).not.toHaveProperty("Cookie");
    expect(options(4).hostname).toBe("api.bilibili.com");
    expect(options(4).headers).toHaveProperty(
      "Cookie",
      "SESSDATA=synthetic; bili_jct=synthetic; DedeUserID=123",
    );
    expect(
      vi
        .mocked(request)
        .mock.calls.some((call) => (call[0] as RequestOptions).hostname === "www.bilibili.com"),
    ).toBe(false);
    await expect(attempt.poll(signal)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("ignores a large compressed crossDomain terminal body after receiving cookies", async () => {
    biliCreate();
    response({
      code: 0,
      data: {
        code: 0,
        url: "https://passport.bilibili.com/x/passport-login/web/crossDomain?ticket=synthetic",
      },
    });
    response("x".repeat(200_000), {
      "content-encoding": "gzip",
      "content-length": "200000",
      "set-cookie": ["SESSDATA=synthetic; Domain=.bilibili.com; Path=/; Secure"],
    });
    response({ code: 0, data: { isLogin: true, mid: 123, uname: "Fixture" } });
    const attempt = await startBilibiliLogin(signal);
    await expect(attempt.poll(signal)).resolves.toMatchObject({ status: "authorized" });
  });

  it.each([
    { code: 0, data: { isLogin: false, mid: 123, uname: "Fixture" } },
    { code: -101, data: { isLogin: true, mid: 123, uname: "Fixture" } },
    { code: 0, data: { isLogin: true, mid: 456, uname: "Fixture" } },
    { code: 0, data: { isLogin: true, mid: 123, uname: "x".repeat(129) } },
  ])("never authorizes unverified/mismatched accounts", async (account) => {
    biliCreate();
    response(
      { code: 0, data: { code: 0, url: "https://www.bilibili.com/" } },
      {
        "set-cookie": [
          "SESSDATA=synthetic; Domain=.bilibili.com; Path=/; Secure",
          "DedeUserID=123; Domain=.bilibili.com; Path=/; Secure",
        ],
      },
    );
    response(account);
    const attempt = await startBilibiliLogin(signal);
    await expect(attempt.poll(signal)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([99999, undefined, "0"])("rejects unknown success-like states %s", async (code) => {
    biliCreate();
    response({ code: 0, data: { code, url: "https://www.bilibili.com/" } });
    const attempt = await startBilibiliLogin(signal);
    await expect(attempt.poll(signal)).rejects.toMatchObject({ code: "invalid_response" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects legacy query credentials and foreign QR URLs", async () => {
    biliCreate();
    response({ code: 0, data: { code: 0, url: "https://www.bilibili.com/?SESSDATA=synthetic" } });
    const attempt = await startBilibiliLogin(signal);
    await expect(attempt.poll(signal)).rejects.toMatchObject({ code: "invalid_response" });
    response({
      code: 0,
      data: { qrcode_key: key, url: `https://evil.invalid/?qrcode_key=${key}` },
    });
    await expect(startBilibiliLogin(signal)).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("NetEase QR provider", () => {
  it("uses official type=1 encrypted requests and maps all nonauthorized states", async () => {
    response({ code: 200, unikey: neteaseKey });
    response({ code: 801 });
    response({ code: 802 });
    response({ code: 800 });
    const attempt = await startNeteaseLogin(signal);
    expect(attempt.qrUrl).toBe(`http://music.163.com/login?codekey=${neteaseKey}`);
    expect(await attempt.poll(signal)).toEqual({ status: "waiting" });
    expect(await attempt.poll(signal)).toEqual({ status: "scanned" });
    expect(await attempt.poll(signal)).toEqual({ status: "expired" });
    expect(decryptWeapi(bodies[0]!)).toEqual({ type: 1, csrf_token: "" });
    expect(decryptWeapi(bodies[1]!)).toEqual({ key: neteaseKey, type: 1, csrf_token: "" });
    expect(options(0).method).toBe("POST");
    expect(new URLSearchParams(bodies[0]).get("encSecKey")).toMatch(/^[a-f0-9]{256}$/);
    await expect(attempt.poll(signal)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("captures account cookies and verifies matching account/profile after 803", async () => {
    response(
      { code: 200, unikey: neteaseKey },
      { "set-cookie": ["__csrf=synthetic; Path=/; Secure"] },
    );
    response(
      { code: 803 },
      { "set-cookie": ["MUSIC_U=synthetic; Domain=.music.163.com; Path=/; HttpOnly; Secure"] },
    );
    response({
      code: 200,
      account: { id: 123 },
      profile: { userId: 123, nickname: "Fixture music" },
    });
    const attempt = await startNeteaseLogin(signal);
    await expect(attempt.poll(signal)).resolves.toEqual({
      status: "authorized",
      secrets: { cookie: "__csrf=synthetic; MUSIC_U=synthetic" },
      account: { name: "Fixture music" },
    });
    expect(options(2).path).toBe("/weapi/w/nuser/account/get");
    expect(decryptWeapi(bodies[2]!)).toEqual({ csrf_token: "synthetic" });
    expect(options(2).headers).toHaveProperty("Cookie", "__csrf=synthetic; MUSIC_U=synthetic");
  });

  it.each([
    { code: 200, account: { id: 456 }, profile: { userId: 123, nickname: "Fixture" } },
    { code: 200, account: { id: 123 }, profile: null },
    { code: 301, account: { id: 123 }, profile: { userId: 123, nickname: "Fixture" } },
  ])("rejects invalid/unactivated account responses", async (account) => {
    response({ code: 200, unikey: neteaseKey });
    response({ code: 803 }, { "set-cookie": ["MUSIC_U=synthetic; Path=/; Secure"] });
    response(account);
    const attempt = await startNeteaseLogin(signal);
    await expect(attempt.poll(signal)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("never trusts a body cookie, account-less 803, or captcha/unknown code", async () => {
    response({ code: 200, unikey: neteaseKey });
    response({ code: 803, cookie: "MUSIC_U=synthetic" });
    const attempt = await startNeteaseLogin(signal);
    await expect(attempt.poll(signal)).rejects.toMatchObject({ code: "invalid_response" });
    expect(request).toHaveBeenCalledTimes(2);
    response({ code: 200, unikey: neteaseKey });
    response({ code: 8821, message: "Synthetic secret upstream diagnostic" });
    const second = await startNeteaseLogin(signal);
    await expect(second.poll(signal)).rejects.toThrow("Plugin login failed: invalid_response");
  });

  it("keeps concurrent attempts independent and clears disposed attempts", async () => {
    response({ code: 200, unikey: neteaseKey }, { "set-cookie": ["__csrf=first; Path=/; Secure"] });
    const first = await startNeteaseLogin(signal);
    response({ code: 200, unikey: neteaseKey });
    const second = await startNeteaseLogin(signal);
    response({ code: 801 });
    await second.poll(signal);
    expect(decryptWeapi(bodies[2]!)).toHaveProperty("csrf_token", "");
    expect(options(2).headers).not.toHaveProperty("Cookie");
    await first.dispose!();
    await expect(first.poll(signal)).rejects.toMatchObject({ code: "unavailable" });
    await second.dispose!();
  });

  it("rejects a concurrent poll without cancelling the original and cancels in-flight polling on dispose", async () => {
    response({ code: 200, unikey: neteaseKey });
    const attempt = await startNeteaseLogin(signal);
    let release!: (value: { address: string; family: number }[]) => void;
    vi.mocked(lookup).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }) as never,
    );
    response({ code: 801 });
    const first = attempt.poll(signal);
    await expect(attempt.poll(signal)).rejects.toMatchObject({ code: "unavailable" });
    release([{ address: "8.8.8.8", family: 4 }]);
    await expect(first).resolves.toEqual({ status: "waiting" });
    vi.mocked(lookup).mockImplementationOnce(() => new Promise(() => {}) as never);
    const pending = attempt.poll(signal);
    await attempt.dispose!();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });

  it("matches a deterministic, independently computed RSA envelope fixture", () => {
    const params = new URLSearchParams(encryptWeapi({ type: 1, csrf_token: "" }));
    const modulus = BigInt(
      "0xe0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7",
    );
    // Independent modular exponentiation verifies the raw, reversed-secret RSA envelope.
    let value = BigInt("0x" + Buffer.from("fedcba9876543210").toString("hex"));
    let exponent = 65537n;
    let encrypted = 1n;
    while (exponent > 0n) {
      if (exponent & 1n) encrypted = (encrypted * value) % modulus;
      value = (value * value) % modulus;
      exponent >>= 1n;
    }
    expect(params.get("encSecKey")).toBe(encrypted.toString(16).padStart(256, "0"));
    expect(params.get("encSecKey")).toHaveLength(256);
    expect(decryptWeapi(params.toString())).toEqual({ type: 1, csrf_token: "" });
  });
});

describe("bounded pinned login transport", () => {
  const url = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate";
  it.each([
    "http://passport.bilibili.com/x/passport-login/web/qrcode/generate",
    "https://passport.bilibili.com:444/x/passport-login/web/qrcode/generate",
    "https://evil.invalid/",
    "https://passport.bilibili.com/x/passport-login/web/logout",
    `${url}?secret=synthetic`,
    `${url}#fragment`,
  ])("rejects out-of-policy URL %s before DNS", async (input) => {
    const transport = new LoginTransport("bilibili", signal);
    await expect(transport.json(input, signal)).rejects.toMatchObject({ code: "invalid_response" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects any nonpublic address and pins TLS/Host to the allowed hostname", async () => {
    vi.mocked(lookup).mockResolvedValueOnce([
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ] as never);
    const transport = new LoginTransport("bilibili", signal);
    await expect(transport.json(url, signal)).rejects.toMatchObject({ code: "unavailable" });
    expect(request).not.toHaveBeenCalled();
    response({ code: 0 });
    await transport.json(url, signal);
    const opts = options(0);
    expect(opts).toMatchObject({
      hostname: "passport.bilibili.com",
      servername: "passport.bilibili.com",
      agent: false,
      maxHeaderSize: 16384,
    });
    const callback = vi.fn();
    opts.lookup!("ignored.invalid", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "8.8.8.8", 4);
  });

  it("rejects JSON redirects and unsafe crossDomain redirects without forwarding cookies", async () => {
    const transport = new LoginTransport("bilibili", signal);
    response("", { location: "https://www.bilibili.com/" }, 302);
    await expect(transport.json(url, signal)).rejects.toMatchObject({ code: "invalid_response" });
    response(
      "",
      {
        location: "https://evil.invalid/?ticket=synthetic",
        "set-cookie": ["SESSDATA=synthetic; Domain=.bilibili.com; Path=/; Secure"],
      },
      302,
    );
    await expect(
      transport.follow(
        "https://passport.bilibili.com/x/passport-login/web/crossDomain?ticket=synthetic",
        signal,
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("bounds redirects and permits only platform-specific request methods", async () => {
    const transport = new LoginTransport("bilibili", signal);
    const crossDomain =
      "https://passport.bilibili.com/x/passport-login/web/crossDomain?ticket=synthetic";
    for (let hop = 0; hop < 4; hop++) response("", { location: crossDomain }, 302);
    await expect(transport.follow(crossDomain, signal)).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(request).toHaveBeenCalledTimes(4);
    await expect(transport.json(url, signal, "params=synthetic")).rejects.toMatchObject({
      code: "invalid_response",
    });
    const netease = new LoginTransport("netease", signal);
    await expect(
      netease.json("https://music.163.com/weapi/login/qrcode/unikey", signal),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await expect(
      netease.json("https://music.163.com/weapi/login/qrcode/unikey", signal, "x".repeat(16385)),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(request).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["x".repeat(128 * 1024 + 1), {}],
    ["{}", { "content-length": "131073" }],
    ["{}", { "content-length": "3" }],
    ["{}", { "content-encoding": "gzip" }],
    ["{}", { "content-type": "text/html" }],
    ["[]", {}],
    ["not JSON", {}],
  ] as const)("bounds and validates response content", async (body, headers) => {
    response(body, headers);
    const transport = new LoginTransport("bilibili", signal);
    await expect(transport.json(url, signal)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("bounds stored cookies, honors expired/host-only/path cookies, and clears on dispose", async () => {
    const transport = new LoginTransport("bilibili", signal);
    response(
      {},
      {
        "set-cookie": [
          "SESSDATA=host-only; Path=/; Secure",
          "other=path-only; Domain=.bilibili.com; Path=/x; Secure",
          "expired=gone; Domain=.bilibili.com; Path=/; Max-Age=0; Secure",
          "valid=synthetic; Domain=.bilibili.com; Path=/; Secure",
        ],
      },
    );
    await transport.json(url, signal);
    expect(transport.cookieFor("https://api.bilibili.com/")).toBe("valid=synthetic");
    response(
      {},
      {
        "set-cookie": Array.from({ length: 65 }, (_, index) => `cookie${index}=synthetic; Path=/`),
      },
    );
    await expect(transport.json(url, signal)).rejects.toMatchObject({ code: "invalid_response" });
    transport.dispose();
    expect(() => transport.cookieFor("https://api.bilibili.com/")).toThrow();
  });

  it("cancels pending DNS, respects lifetime cancellation and never returns raw errors", async () => {
    vi.mocked(lookup).mockImplementationOnce(() => new Promise(() => {}));
    const controller = new AbortController();
    const transport = new LoginTransport("bilibili", signal);
    const pending = transport.json(url, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(request).not.toHaveBeenCalled();
    vi.mocked(lookup).mockRejectedValueOnce(new Error("Synthetic credential diagnostic"));
    await expect(transport.json(url, signal)).rejects.toThrow("Plugin login failed: unavailable");
    const lifetime = new AbortController();
    const disposed = new LoginTransport("bilibili", lifetime.signal);
    lifetime.abort();
    await expect(disposed.json(url, signal)).rejects.toMatchObject({ code: "cancelled" });
  });

  it("bounds the whole request deadline and cancels a streaming response", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const stream = new Readable({ read() {} }) as IncomingMessage;
    stream.statusCode = 200;
    stream.headers = { "content-type": "application/json" };
    queue.push(stream);
    const transport = new LoginTransport("bilibili", signal);
    const pending = transport.json(url, signal);
    const checked = expect(pending).rejects.toMatchObject({ code: "unavailable" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    deadline.abort();
    await checked;
    expect(stream.destroyed).toBe(true);
  });
});
