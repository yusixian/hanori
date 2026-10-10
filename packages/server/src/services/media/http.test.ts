import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import {
  isPublicMediaAddress,
  downloadMediaFile,
  MediaHttpError,
  readMediaDocument,
  resolveMediaUrl,
  sendMediaDocument,
  type MediaDocumentPolicy,
  type MediaDownloadPolicy,
} from "./http.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("node:https", () => ({ request: vi.fn() }));

const policy: MediaDocumentPolicy = {
  allowedHosts: ["api.example.com", "short.example.com", "cdn.example.com"],
  mimeTypes: ["application/json"],
  maxBytes: 64,
};
const pendingResponses: IncomingMessage[] = [];
const requestBodies: Array<Buffer | undefined> = [];

function response(
  status = 200,
  headers: IncomingHttpHeaders = { "content-type": "application/json" },
  chunks: Array<string | Buffer> = ['{"ok":true}'],
): IncomingMessage {
  const stream = Readable.from(chunks.map((chunk) => Buffer.from(chunk))) as IncomingMessage;
  stream.statusCode = status;
  stream.headers = headers;
  pendingResponses.push(stream);
  return stream;
}

beforeEach(async () => {
  vi.resetAllMocks();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(open).mockImplementation(actual.open);
  pendingResponses.length = 0;
  requestBodies.length = 0;
  vi.mocked(lookup).mockResolvedValue([{ address: "8.8.8.8", family: 4 }] as never);
  vi.mocked(request).mockImplementation(((
    options: { signal: AbortSignal },
    callback: (response: IncomingMessage) => void,
  ) => {
    const req = new EventEmitter() as EventEmitter & { end: (body?: Buffer) => void };
    req.end = (body) => {
      requestBodies.push(body);
      queueMicrotask(() => {
        const next = pendingResponses.shift();
        if (!next) {
          req.emit("error", new Error("Synthetic missing response"));
          return;
        }
        callback(next);
      });
    };
    // Real https.request owns socket cancellation. The mock keeps the same body behavior.
    options.signal.addEventListener("abort", () => req.emit("error", options.signal.reason), {
      once: true,
    });
    return req;
  }) as never);
});

describe("bounded media file downloads", () => {
  let directory: string;
  const audioPolicy = {
    allowedHosts: ["cdn.example.com"],
    mimeTypes: ["audio/mp4", "application/octet-stream"],
    maxBytes: 128,
  };
  const mp4 = Buffer.alloc(24);
  mp4.writeUInt32BE(24);
  mp4.write("ftyp", 4);
  mp4.write("M4A ", 8);
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "media-download-test-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("streams an exclusive regular file with split MP4 magic and stable SHA256", async () => {
    const path = join(directory, "audio.m4a");
    response(200, { "content-type": "audio/mp4", "content-length": "24" }, [
      mp4.subarray(0, 3),
      mp4.subarray(3, 9),
      mp4.subarray(9),
    ]);
    await expect(
      downloadMediaFile("https://cdn.example.com/audio?signature=synthetic", audioPolicy, path),
    ).resolves.toEqual({
      bytes: 24,
      sha256: createHash("sha256").update(mp4).digest("hex"),
      mimeType: "audio/mp4",
    });
    expect(await readFile(path)).toEqual(mp4);
    const options = vi.mocked(request).mock.calls[0]![0] as unknown as {
      headers: Record<string, string>;
    };
    expect(options.headers).not.toHaveProperty("Cookie");
    expect(options.headers).not.toHaveProperty("Authorization");
  });

  it("downloads video/mp4 with awaited cumulative progress and a dynamic byte limit", async () => {
    const path = join(directory, "video.mp4");
    response(200, { "content-type": "video/mp4" }, [mp4.subarray(0, 12), mp4.subarray(12)]);
    const onProgress = vi.fn(async (_bytes: number) => undefined);
    expect(
      await downloadMediaFile(
        "https://cdn.example.com/video",
        { ...audioPolicy, mimeTypes: ["video/mp4"], maxBytes: 24, onProgress },
        path,
      ),
    ).toMatchObject({ bytes: 24, mimeType: "video/mp4" });
    expect(onProgress.mock.calls.at(-1)).toEqual([24]);
    expect(await readFile(path)).toEqual(mp4);
  });

  it("awaits budget rejection before writing the chunk and removes its file", async () => {
    const path = join(directory, "video.mp4");
    response(200, { "content-type": "video/mp4" }, [mp4]);
    const onProgress = vi.fn(async () => {
      throw new MediaHttpError("too_large");
    });
    await expect(
      downloadMediaFile(
        "https://cdn.example.com/video",
        { ...audioPolicy, mimeTypes: ["video/mp4"], onProgress },
        path,
      ),
    ).rejects.toMatchObject({ code: "too_large" });
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("supports only the trusted Bilibili public Referer and does not add a Cookie", async () => {
    response(200, { "content-type": "audio/mp4" }, [mp4]);
    await downloadMediaFile(
      "https://cdn.example.com/audio",
      { ...audioPolicy, referer: "https://www.bilibili.com/" },
      join(directory, "audio.m4a"),
    );
    const options = vi.mocked(request).mock.calls[0]![0] as unknown as {
      headers: Record<string, string>;
    };
    expect(options.headers.Referer).toBe("https://www.bilibili.com/");
    expect(options.headers).not.toHaveProperty("Cookie");
    await expect(
      downloadMediaFile(
        "https://cdn.example.com/audio",
        { ...audioPolicy, referer: "https://evil.invalid/" } as unknown as MediaDownloadPolicy,
        join(directory, "rejected.m4a"),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("validates MP4 magic as exact bytes without ASCII high-bit normalization", async () => {
    const fake = Buffer.from(mp4);
    for (let index = 4; index < 8; index++) fake[index] = fake[index]! | 0x80;
    response(200, { "content-type": "audio/mp4" }, [fake]);
    const path = join(directory, "fake.m4a");
    await expect(
      downloadMediaFile("https://cdn.example.com/audio", audioPolicy, path),
    ).rejects.toMatchObject({ code: "invalid_content" });
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["file", "symlink"])("never replaces an existing %s", async (kind) => {
    const target = join(directory, "target");
    const path = join(directory, "audio.m4a");
    await writeFile(target, "preserved");
    if (kind === "symlink") await symlink(target, path);
    else await writeFile(path, "preserved");
    response(200, { "content-type": "audio/mp4" }, [mp4]);
    await expect(
      downloadMediaFile("https://cdn.example.com/audio", audioPolicy, path),
    ).rejects.toMatchObject({ code: "upstream_error" });
    expect(await readFile(path, "utf8")).toBe("preserved");
    expect(await readFile(target, "utf8")).toBe("preserved");
  });

  it.each([
    [{ "content-type": "text/html" }, [mp4], "invalid_content"],
    [{ "content-type": "audio/mp4", "content-encoding": "gzip" }, [mp4], "invalid_content"],
    [{ "content-type": "audio/mp4", "content-length": "999" }, [mp4], "too_large"],
    [{ "content-type": "audio/mp4", "content-length": "25" }, [mp4], "invalid_content"],
    [{ "content-type": "audio/mp4" }, [Buffer.from("this is not MP4 audio")], "invalid_content"],
    [{ "content-type": "audio/mp4" }, [mp4.subarray(0, 10)], "invalid_content"],
    [{ "content-type": "audio/mp4" }, [mp4, Buffer.alloc(129)], "too_large"],
  ])("removes partial files on format or size failure %#", async (headers, chunks, code) => {
    const path = join(directory, "audio.m4a");
    const stream = response(200, headers as IncomingHttpHeaders, chunks as Buffer[]);
    await expect(
      downloadMediaFile("https://cdn.example.com/audio", audioPolicy, path),
    ).rejects.toMatchObject({ code });
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(stream.destroyed).toBe(true);
  });

  it.each(["cancel", "timeout"] as const)(
    "destroys stalled bodies and removes partial files on %s",
    async (mode) => {
      vi.useFakeTimers();
      try {
        const controller = new AbortController();
        const reason = new Error("Synthetic cancellation");
        let beganReading!: () => void;
        const started = new Promise<void>((resolve) => {
          beganReading = resolve;
        });
        const stream = new Readable({ read: beganReading }) as IncomingMessage;
        stream.statusCode = 200;
        stream.headers = { "content-type": "audio/mp4" };
        pendingResponses.push(stream);
        const path = join(directory, "partial.m4a");
        const reading = downloadMediaFile(
          "https://cdn.example.com/audio",
          { ...audioPolicy, signal: controller.signal, timeoutMs: 50 },
          path,
        );
        const assertion =
          mode === "cancel"
            ? expect(reading).rejects.toBe(reason)
            : expect(reading).rejects.toMatchObject({ code: "timeout" });
        await started;
        if (mode === "cancel") controller.abort(reason);
        else await vi.advanceTimersByTimeAsync(51);
        await assertion;
        expect(stream.destroyed).toBe(true);
        await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["write", "close"] as const)(
    "closes the real file and removes partial output after a %s failure",
    async (failureStage) => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const path = join(directory, "failed.m4a");
      const failure = Object.assign(new Error("Synthetic disk failure"), { code: "ENOSPC" });
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      let close: (() => Promise<void>) | undefined;
      let persistedBytes = 0;
      vi.mocked(open).mockImplementationOnce(async (...args) => {
        handle = await actual.open(...args);
        close = handle.close.bind(handle);
        if (failureStage === "write") {
          const write = handle.writeFile.bind(handle);
          vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
            await write(mp4.subarray(0, 12));
            persistedBytes = (await handle!.stat()).size;
            throw failure;
          });
        } else {
          vi.spyOn(handle, "close").mockImplementationOnce(async () => {
            persistedBytes = (await handle!.stat()).size;
            await close!();
            throw failure;
          });
        }
        return handle;
      });
      const stream = response(200, { "content-type": "audio/mp4" }, [mp4]);
      try {
        await expect(
          downloadMediaFile("https://cdn.example.com/audio", audioPolicy, path),
        ).rejects.toMatchObject({ code: "upstream_error" });
        expect(persistedBytes).toBe(failureStage === "write" ? 12 : mp4.length);
        expect(handle).toBeDefined();
        await expect(handle!.stat()).rejects.toMatchObject({ code: "EBADF" });
        await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
        expect(stream.destroyed).toBe(true);
      } finally {
        await close?.().catch(() => undefined);
      }
    },
  );

  it("rejects file limits above 512MiB and deadlines above30min before requesting", async () => {
    await expect(
      downloadMediaFile(
        "https://cdn.example.com/audio",
        { ...audioPolicy, maxBytes: 512 * 1024 * 1024 + 1 },
        join(directory, "a"),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      downloadMediaFile(
        "https://cdn.example.com/audio",
        { ...audioPolicy, timeoutMs: 30 * 60_000 + 1 },
        join(directory, "a"),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(request).not.toHaveBeenCalled();
  });
});

describe("bounded ASR POST transport", () => {
  const postPolicy = {
    allowedHosts: ["api.example.com"],
    mimeTypes: ["application/json"],
    maxBytes: 64,
    credential: { origin: "https://api.example.com", authorization: "Bearer synthetic" },
  };
  const body = {
    contentType: "multipart/form-data; boundary=synthetic",
    bytes: Buffer.from("synthetic bounded upload"),
  };
  it("pins POST, exact Content-Length and Authorization to the configured origin", async () => {
    response();
    await expect(
      sendMediaDocument("https://api.example.com/v1/audio/transcriptions", postPolicy, body),
    ).resolves.toMatchObject({ bytes: Buffer.from('{"ok":true}') });
    expect(vi.mocked(request).mock.calls[0]![0]).toMatchObject({
      method: "POST",
      servername: "api.example.com",
      headers: {
        Authorization: "Bearer synthetic",
        "Content-Type": body.contentType,
        "Content-Length": String(body.bytes.length),
        "Accept-Encoding": "identity",
      },
    });
    expect(requestBodies).toEqual([body.bytes]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
  it.each([301, 302, 303, 307, 308])(
    "never follows HTTP%s even to the same origin",
    async (status) => {
      const stream = response(status, { location: "/v1/new" });
      await expect(
        sendMediaDocument("https://api.example.com/v1/audio/transcriptions", postPolicy, body),
      ).rejects.toMatchObject({ code: "upstream_error" });
      expect(request).toHaveBeenCalledTimes(1);
      expect(stream.destroyed).toBe(true);
    },
  );
  it("rejects body/response/deadline bounds and credentials for other origins before I/O", async () => {
    const input = "https://api.example.com/v1/audio/transcriptions";
    for (const settings of [
      { ...postPolicy, timeoutMs: 180_001 },
      { ...postPolicy, maxBytes: 2 * 1024 * 1024 + 1 },
      {
        ...postPolicy,
        credential: { origin: "https://other.example.com", authorization: "synthetic" },
      },
      { ...postPolicy, credential: { origin: "https://api.example.com", cookie: "synthetic" } },
    ]) {
      await expect(sendMediaDocument(input, settings, body)).rejects.toMatchObject({
        code: "invalid_request",
      });
    }
    await expect(
      sendMediaDocument(input, postPolicy, { ...body, bytes: Buffer.alloc(21 * 1024 * 1024 + 1) }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    for (const suffix of ["?token=private", "#fragment", "?"])
      await expect(sendMediaDocument(input + suffix, postPolicy, body)).rejects.toMatchObject({
        code: "invalid_request",
      });
    expect(request).not.toHaveBeenCalled();
  });
  it("preserves DNS and response content bounds with no retries", async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }] as never);
    await expect(
      sendMediaDocument("https://api.example.com/v1/audio/transcriptions", postPolicy, body),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(request).not.toHaveBeenCalled();
    response(200, { "content-type": "application/json" }, ["x".repeat(65)]);
    await expect(
      sendMediaDocument("https://api.example.com/v1/audio/transcriptions", postPolicy, body),
    ).rejects.toMatchObject({ code: "too_large" });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("includes DNS in the upload deadline", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(lookup).mockImplementation(() => new Promise(() => {}) as never);
      const result = sendMediaDocument(
        "https://api.example.com/v1/audio/transcriptions",
        { ...postPolicy, timeoutMs: 50 },
        body,
      );
      const assertion = expect(result).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(51);
      await assertion;
      expect(request).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("media HTTP public-address policy", () => {
  it.each([
    "0.1.2.3",
    "10.1.2.3",
    "100.64.0.1",
    "100.127.255.254",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.254",
    "192.0.0.192",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.19.255.254",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "168.63.129.16",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:8.8.8.8",
    "64:ff9b::a00:1",
    "2001::1",
    "2001:db8::1",
    "2002:7f00:1::1",
    "fc00::1",
    "fd00:ec2::254",
    "fe80::1",
    "fe80::1%en0",
    "ff02::1",
    "3fff::1",
    "not-an-address",
  ])("blocks special-use address %s", (address) => {
    expect(isPublicMediaAddress(address)).toBe(false);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "100.128.0.1",
    "172.32.0.1",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
  ])("accepts public address %s", (address) => {
    expect(isPublicMediaAddress(address)).toBe(true);
  });
});

describe("bounded media documents", () => {
  it("pins the validated address while preserving TLS hostname and Host identity", async () => {
    const stream = response();
    const result = await readMediaDocument(
      "https://api.example.com/data?signature=fixture",
      policy,
    );
    expect(result.bytes.toString()).toBe('{"ok":true}');
    expect(result.mimeType).toBe("application/json");
    const options = vi.mocked(request).mock.calls[0]![0] as unknown as {
      lookup: (...args: unknown[]) => void;
    };
    expect(options).toMatchObject({
      hostname: "api.example.com",
      servername: "api.example.com",
      agent: false,
      port: 443,
      path: "/data?signature=fixture",
      maxHeaderSize: 16_384,
      headers: { "Accept-Encoding": "identity" },
    });
    const callback = vi.fn();
    options.lookup("api.example.com", {}, callback);
    expect(callback).toHaveBeenLastCalledWith(null, "8.8.8.8", 4);
    options.lookup("api.example.com", { all: true }, callback);
    expect(callback).toHaveBeenLastCalledWith(null, [{ address: "8.8.8.8", family: 4 }]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(stream.destroyed).toBe(true);
  });

  it.each([
    "http://api.example.com/data",
    "https://api.example.com:8443/data",
    "https://secret@api.example.com/data",
    "https://api.example.com.evil.test/data",
    "https://127.0.0.1/data",
    "https://api.example.com./data",
    "https://api.example.com\\@evil.test/data",
    " https://api.example.com/data",
  ])("rejects unsafe target %s without DNS or a request", async (url) => {
    await expect(readMediaDocument(url, policy)).rejects.toMatchObject({ code: "invalid_request" });
    expect(lookup).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects mixed public/private DNS answers before choosing any address", async () => {
    vi.mocked(lookup).mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ] as never);
    await expect(readMediaDocument("https://api.example.com/data", policy)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("checks every redirect and destroys rejected responses without draining their body", async () => {
    const redirect = response(302, { location: "https://evil.example/metadata" }, ["unused"]);
    await expect(readMediaDocument("https://api.example.com/data", policy)).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(redirect.destroyed).toBe(true);
  });

  it("revalidates DNS after a redirect even when the hostname is unchanged", async () => {
    response(302, { location: "/next" });
    vi.mocked(lookup)
      .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }] as never)
      .mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }] as never);
    await expect(readMediaDocument("https://api.example.com/data", policy)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("binds credentials to one origin and strips them permanently after crossing origins", async () => {
    response(302, { location: "/same-origin" });
    response(302, { location: "https://cdn.example.com/subtitle" });
    response(302, { location: "https://api.example.com/return" });
    response();
    await readMediaDocument("https://api.example.com/data", {
      ...policy,
      credential: {
        origin: "https://api.example.com",
        cookie: "session=synthetic",
        authorization: "Bearer synthetic",
      },
    });
    const calls = vi
      .mocked(request)
      .mock.calls.map((call) => call[0] as unknown as { headers: Record<string, string> });
    expect(calls[0]!.headers.Cookie).toBe("session=synthetic");
    expect(calls[1]!.headers.Authorization).toBe("Bearer synthetic");
    for (const call of calls.slice(2)) {
      expect(call.headers).not.toHaveProperty("Cookie");
      expect(call.headers).not.toHaveProperty("Authorization");
    }
  });

  it("does not accept credentials for another origin or header injection", async () => {
    await expect(
      readMediaDocument("https://api.example.com/data", {
        ...policy,
        credential: { origin: "https://cdn.example.com", cookie: "synthetic" },
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      readMediaDocument("https://api.example.com/data", {
        ...policy,
        credential: { origin: "https://api.example.com", cookie: "synthetic\r\nHost: evil.test" },
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    [{ "content-type": "text/html" }, "invalid_content"],
    [{ "content-type": "application/json", "content-encoding": "gzip" }, "invalid_content"],
    [{ "content-type": "application/json", "content-length": "999" }, "too_large"],
    [{ "content-type": "application/json", "content-length": "-1" }, "invalid_content"],
    [{ "content-type": "application/json", "content-length": "2" }, "invalid_content"],
  ])("rejects mismatched or unbounded content headers", async (headers, code) => {
    const stream = response(200, headers);
    await expect(readMediaDocument("https://api.example.com/data", policy)).rejects.toMatchObject({
      code,
    });
    expect(stream.destroyed).toBe(true);
  });

  it("bounds streamed bytes without trusting content-length", async () => {
    const stream = response(200, { "content-type": "application/json" }, [
      "a".repeat(40),
      "b".repeat(40),
    ]);
    await expect(readMediaDocument("https://api.example.com/data", policy)).rejects.toMatchObject({
      code: "too_large",
    });
    expect(stream.destroyed).toBe(true);
  });

  it.each([
    [401, "forbidden"],
    [403, "forbidden"],
    [404, "unavailable"],
    [429, "rate_limited"],
    [500, "upstream_error"],
  ])("classifies HTTP %s without exposing private response data", async (status, code) => {
    response(status as number, {}, ["private upstream body"]);
    await expect(readMediaDocument("https://api.example.com/data", policy)).rejects.toMatchObject({
      code,
      message: `Media request failed: ${code}`,
    });
  });

  it("resolves a short link without retaining HTML or Set-Cookie", async () => {
    response(302, {
      location: "https://api.example.com/video?p=2",
      "set-cookie": ["not-forwarded"],
    });
    const final = response(200, { "content-type": "text/html" }, ["unused HTML"]);
    await expect(resolveMediaUrl("https://short.example.com/abc", policy)).resolves.toBe(
      "https://api.example.com/video?p=2",
    );
    expect(final.destroyed).toBe(true);
    const options = vi.mocked(request).mock.calls[1]![0] as unknown as {
      headers: Record<string, string>;
    };
    expect(options.headers).not.toHaveProperty("Cookie");
  });

  it("bounds redirect loops", async () => {
    const stream = response(302, { location: "/loop" });
    await expect(
      resolveMediaUrl("https://short.example.com/abc", { ...policy, maxRedirects: 0 }),
    ).rejects.toMatchObject({ code: "upstream_error" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(stream.destroyed).toBe(true);
  });

  it("propagates cancellation before dispatch and prevents late DNS from starting a request", async () => {
    const controller = new AbortController();
    const reason = new Error("synthetic cancellation");
    let finish!: (value: unknown) => void;
    vi.mocked(lookup).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }) as never,
    );
    const reading = readMediaDocument("https://api.example.com/data", {
      ...policy,
      signal: controller.signal,
    });
    controller.abort(reason);
    await expect(reading).rejects.toBe(reason);
    finish([{ address: "8.8.8.8", family: 4 }]);
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
    await expect(
      readMediaDocument("https://api.example.com/data", { ...policy, signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("enforces a total deadline including DNS and hides resolver failure details", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(lookup).mockImplementation(() => new Promise(() => {}) as never);
      const reading = readMediaDocument("https://api.example.com/data", {
        ...policy,
        timeoutMs: 50,
      });
      const assertion = expect(reading).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(51);
      await assertion;
      expect(request).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
    vi.mocked(lookup).mockRejectedValue(new Error("private-url?token=synthetic"));
    await expect(readMediaDocument("https://api.example.com/data", policy)).rejects.toEqual(
      new MediaHttpError("upstream_error"),
    );
  });

  it.each(["cancel", "timeout"] as const)(
    "releases a stalled response body on %s",
    async (mode) => {
      vi.useFakeTimers();
      try {
        const controller = new AbortController();
        const reason = new Error("Synthetic cancellation");
        let beganReading!: () => void;
        const bodyStarted = new Promise<void>((resolve) => {
          beganReading = resolve;
        });
        const stream = new Readable({ read: beganReading }) as IncomingMessage;
        stream.statusCode = 200;
        stream.headers = { "content-type": "application/json" };
        pendingResponses.push(stream);
        const reading = readMediaDocument("https://api.example.com/stalled", {
          ...policy,
          timeoutMs: 50,
          signal: controller.signal,
        });
        const assertion =
          mode === "cancel"
            ? expect(reading).rejects.toBe(reason)
            : expect(reading).rejects.toMatchObject({ code: "timeout" });
        await bodyStarted;
        if (mode === "cancel") controller.abort(reason);
        else await vi.advanceTimersByTimeAsync(51);
        await assertion;
        expect(stream.destroyed).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
