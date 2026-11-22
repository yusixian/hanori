import { tmpdir } from "node:os";
import {
  realpath,
  open,
  mkdtemp,
  rm,
  symlink,
  truncate,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import type { ReadStream } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { autoRetry } from "@grammyjs/auto-retry";
import { Api, type ApiClientOptions } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendLocalVideoFile } from "./video-download-delivery.js";

type Fetch = NonNullable<ApiClientOptions["fetch"]>;
const response = (body: unknown) => ({ json: async () => body }) as Awaited<ReturnType<Fetch>>;
const receipt = { ok: true, result: { message_id: 123 } };
let directory: string;
let path: string;
let bytes: Buffer;
let opened: Array<{ file: FileHandle; stream: ReadStream }>;

beforeEach(async () => {
  directory = await mkdtemp(join(await realpath(tmpdir()), "video-delivery-"));
  path = join(directory, "video.mp4");
  bytes = Buffer.alloc(2 * 1024 * 1024 + 17);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  await writeFile(path, bytes);
  const handle = await open(path, "r");
  const prototype = Object.getPrototypeOf(handle) as FileHandle;
  const original = prototype.createReadStream;
  await handle.close();
  opened = [];
  vi.spyOn(prototype, "createReadStream").mockImplementation(function (this: FileHandle, options) {
    const stream = original.call(this, options);
    opened.push({ file: this, stream });
    return stream;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

function input(signal = new AbortController().signal) {
  return { title: "视频标题 – short sample", durationSeconds: 1.2, threadId: 73, signal };
}
function client(fetch: Fetch) {
  // The injected transport consumes grammY's real multipart stream and never accesses Telegram.
  return new Api("synthetic:token", { apiRoot: "http://unused.invalid", fetch });
}
async function consume(body: unknown) {
  expect(body).toBeInstanceOf(Readable);
  expect(Buffer.isBuffer(body)).toBe(false);
  const chunks: Buffer[] = [];
  for await (const value of body as Readable) chunks.push(Buffer.from(value));
  return { chunks, payload: Buffer.concat(chunks) };
}
function assertReleased() {
  expect(opened).toHaveLength(1);
  expect(opened[0]!.stream.destroyed).toBe(true);
  expect(opened[0]!.file.fd).toBe(-1);
}

describe("one-shot streamed video delivery", () => {
  it("uploads the complete file through real multipart chunks with caption, duration and topic", async () => {
    const fetch = vi.fn<Fetch>(async (url: Parameters<Fetch>[0], init: Parameters<Fetch>[1]) => {
      expect(String(url)).toBe("http://unused.invalid/botsynthetic:token/sendVideo");
      const { chunks, payload } = await consume(init?.body);
      expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThan(bytes.length);
      const contentType = (init!.headers as Record<string, string>)["content-type"]!;
      const boundary = contentType.split("boundary=")[1]!;
      const parts = payload.toString("latin1").split(`--${boundary}`);
      const fields = new Map<string, string>();
      let uploaded: Buffer | undefined;
      for (const part of parts) {
        const split = part.indexOf("\r\n\r\n");
        if (split < 0) continue;
        const header = part.slice(0, split);
        const content = part.slice(split + 4, -2);
        if (header.includes("filename=video.mp4")) uploaded = Buffer.from(content, "latin1");
        else {
          const name = /name="([^"]+)"/.exec(header)?.[1];
          if (name) fields.set(name, Buffer.from(content, "latin1").toString("utf8"));
        }
      }
      expect(uploaded?.byteLength).toBe(bytes.byteLength);
      expect(uploaded?.equals(bytes)).toBe(true);
      expect(fields.get("chat_id")).toBe("42");
      expect(fields.get("caption")).toBe(input().title);
      expect(fields.get("duration")).toBe("2");
      expect(fields.get("message_thread_id")).toBe("73");
      expect(fields.get("supports_streaming")).toBe("true");
      expect(fields.get("video")).toMatch(/^attach:\/\//);
      return response(receipt);
    });
    expect(await sendLocalVideoFile(client(fetch), 42, path, input())).toBe(123);
    expect(fetch).toHaveBeenCalledOnce();
    assertReleased();
  });

  it("rejects symlinked and over50MB files before opening an upload stream or making a request", async () => {
    const fetch = vi.fn<Fetch>();
    const linked = join(directory, "linked.mp4");
    await symlink(path, linked);
    await expect(sendLocalVideoFile(client(fetch), 42, linked, input())).rejects.toMatchObject({
      code: "ELOOP",
    });
    await truncate(path, 50_000_001);
    await expect(sendLocalVideoFile(client(fetch), 42, path, input())).rejects.toThrow(
      "invalid_video_file",
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(opened).toHaveLength(0);
  });

  it("honors native AbortSignal during upload and closes the real file stream and descriptor", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const fetch = vi.fn<Fetch>(async (_url: Parameters<Fetch>[0], init: Parameters<Fetch>[1]) => {
      const aborted = new Promise<never>((_resolve, reject) => {
        init!.signal!.addEventListener(
          "abort",
          () => reject(new Error("aborted synthetic upload")),
          { once: true },
        );
      });
      let consumed = 0;
      for await (const chunk of init!.body as Readable) {
        consumed += chunk.length;
        if (consumed >= 65_536) {
          markStarted();
          await aborted;
        }
      }
      return response(receipt);
    });
    const controller = new AbortController();
    const pending = sendLocalVideoFile(client(fetch), 42, path, input(controller.signal));
    const rejected = expect(pending).rejects.toMatchObject({ name: "HttpError" });
    await started;
    controller.abort();
    await rejected;
    expect(fetch).toHaveBeenCalledOnce();
    assertReleased();
  });

  it("does not inherit autoRetry or resend after an ambiguous HTTP failure", async () => {
    const fetch = vi.fn<Fetch>(async (_url: Parameters<Fetch>[0], init: Parameters<Fetch>[1]) => {
      const upload = await consume(init?.body);
      expect(upload.payload.includes(bytes)).toBe(true);
      throw new Error("synthetic connection lost after upload");
    });
    const api = client(fetch);
    api.config.use(autoRetry({ maxRetryAttempts: 1 }));
    expect(api.config.installedTransformers()).toHaveLength(1);
    await expect(sendLocalVideoFile(api, 42, path, input())).rejects.toMatchObject({
      name: "HttpError",
    });
    expect(fetch).toHaveBeenCalledOnce();
    assertReleased();
  });
});
