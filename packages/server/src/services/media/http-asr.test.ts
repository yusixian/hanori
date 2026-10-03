import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendMediaJsonDocument } from "./http.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("node:https", () => ({ request: vi.fn() }));
const policy = {
  allowedHosts: ["asr.tencentcloudapi.com"],
  mimeTypes: ["application/json"],
  credential: { origin: "https://asr.tencentcloudapi.com", authorization: "TC3 synthetic" },
};
const input = "https://asr.tencentcloudapi.com/";
let status: number;
let responseHeaders: Record<string, string>;
let body: Buffer;
let uploaded: Buffer | undefined;
beforeEach(() => {
  vi.resetAllMocks();
  status = 200;
  responseHeaders = { "content-type": "application/json" };
  body = Buffer.from('{"ok":true}');
  uploaded = undefined;
  vi.mocked(lookup).mockResolvedValue([{ address: "8.8.8.8", family: 4 }] as never);
  vi.mocked(request).mockImplementation(((
    options: { signal: AbortSignal },
    callback: (result: IncomingMessage) => void,
  ) => {
    const operation = new EventEmitter() as EventEmitter & { end(bytes?: Buffer): void };
    operation.end = (bytes) => {
      uploaded = bytes;
      queueMicrotask(() => {
        const response = Readable.from([body]) as IncomingMessage;
        response.statusCode = status;
        response.headers = responseHeaders;
        callback(response);
      });
    };
    options.signal.addEventListener("abort", () => operation.emit("error", options.signal.reason), {
      once: true,
    });
    return operation;
  }) as never);
});

describe("cloud ASR transport security", () => {
  it("pins the resolved public address and keeps exact signed headers/body", async () => {
    const bytes = Buffer.from('{"TaskId":42}');
    await sendMediaJsonDocument(input, policy, bytes, {
      "X-TC-Action": "DescribeTaskStatus",
      "X-TC-Timestamp": "1791007200",
    });
    expect(uploaded).toEqual(bytes);
    const options = vi.mocked(request).mock.calls[0]![0] as unknown as {
      hostname: string;
      servername: string;
      headers: Record<string, string>;
      lookup: (name: string, options: unknown, callback: (...args: unknown[]) => void) => void;
    };
    expect(options.hostname).toBe("asr.tencentcloudapi.com");
    expect(options.servername).toBe(options.hostname);
    expect(options.headers).toMatchObject({
      Authorization: "TC3 synthetic",
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": "13",
    });
    const callback = vi.fn();
    options.lookup("ignored", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "8.8.8.8", 4);
  });

  it("blocks private DNS answers and performs no HTTP request", async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: "169.254.169.254", family: 4 }] as never);
    await expect(sendMediaJsonDocument(input, policy, Buffer.from("{}"))).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("never follows redirects carrying cloud credentials", async () => {
    status = 307;
    responseHeaders.location = "https://evil.example.com/";
    await expect(sendMediaJsonDocument(input, policy, Buffer.from("{}"))).rejects.toMatchObject({
      code: "upstream_error",
    });
    expect(request).toHaveBeenCalledOnce();
  });

  const forbiddenHeaders: Array<Record<string, string>> = [
    { Authorization: "override" },
    { Host: "evil.example.com" },
    { Cookie: "private" },
    { "X-TC-Action": "DeleteInstance" },
    { "X-TC-Region": "ap-shanghai\r\nOther: private" },
  ];
  it.each(forbiddenHeaders)(
    "rejects header overrides and injection %# before DNS",
    async (headers) => {
      await expect(
        sendMediaJsonDocument(input, policy, Buffer.from("{}"), headers),
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(lookup).not.toHaveBeenCalled();
    },
  );

  it("bounds response length and rejects unsupported content encoding", async () => {
    responseHeaders["content-length"] = String(2 * 1024 * 1024 + 1);
    await expect(sendMediaJsonDocument(input, policy, Buffer.from("{}"))).rejects.toMatchObject({
      code: "too_large",
    });
    delete responseHeaders["content-length"];
    responseHeaders["content-encoding"] = "gzip";
    await expect(sendMediaJsonDocument(input, policy, Buffer.from("{}"))).rejects.toMatchObject({
      code: "invalid_content",
    });
  });

  it("rejects cookies, mismatched credential origins and oversized JSON uploads", async () => {
    await expect(
      sendMediaJsonDocument(
        input,
        { ...policy, credential: { ...policy.credential, cookie: "private" } },
        Buffer.from("{}"),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      sendMediaJsonDocument(
        input,
        { ...policy, credential: { ...policy.credential, origin: "https://evil.example.com" } },
        Buffer.from("{}"),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      sendMediaJsonDocument(input, policy, Buffer.alloc(7 * 1024 * 1024 + 1)),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(request).not.toHaveBeenCalled();
  });
});
