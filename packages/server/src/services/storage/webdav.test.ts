import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebDAVProvider } from "./webdav.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

const directories: string[] = [];
const provider = () => new WebDAVProvider("https://storage.test/backups/", "user", "password");

async function backupFile(content: string | Buffer = "backup data") {
  const directory = await mkdtemp(join(tmpdir(), "webdav-test-"));
  directories.push(directory);
  const path = join(directory, "backup.gz");
  await writeFile(path, content);
  return path;
}

function response(status: number, cancel = vi.fn()) {
  return {
    result: new Response(new ReadableStream({ cancel }), { status }),
    cancel,
  };
}

afterEach(async () => {
  for (const result of vi.mocked(createReadStream).mock.results) {
    if (result.type === "return") result.value.destroy();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(createReadStream).mockClear();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("WebDAV resource cleanup", () => {
  it("closes a real file after native fetch rejects an unsupported URL", async () => {
    const storage = new WebDAVProvider("ftp://storage.invalid/backups", "user", "password");
    await expect(
      storage.upload(await backupFile(Buffer.alloc(2 * 1024 * 1024, 0x61)), "backup.gz"),
    ).rejects.toThrow();
    const source = vi.mocked(createReadStream).mock.results[0]!.value;
    await vi.waitFor(() => expect(source.closed).toBe(true));
  });

  it("accepts a successful response without a body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(provider().delete("backup.gz")).resolves.toBeUndefined();
  });

  it("preserves a failed DELETE response body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("denied", { status: 403 })));
    await expect(provider().delete("backup.gz")).rejects.toThrow(
      "WebDAV delete failed (403): denied",
    );
  });

  it.each([200, 404])("releases an unused DELETE response with status %i", async (status) => {
    const { result, cancel } = response(status);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(result));
    await expect(provider().delete("backup.gz")).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([207, 403])("releases a PROPFIND response with status %i", async (status) => {
    const { result, cancel } = response(status);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(result));
    expect((await provider().test()).ok).toBe(status === 207);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("releases a successful upload response and its source file", async () => {
    const { result, cancel } = response(201);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(result));
    await expect(provider().upload(await backupFile(), "backup.gz")).resolves.toBe(
      "https://storage.test/backups/backup.gz",
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.mocked(createReadStream).mock.results[0]!.value.destroyed).toBe(true);
  });

  it("closes the source when the request fails before reading it", async () => {
    const failure = new Error("connection refused");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));
    await expect(provider().upload(await backupFile(), "backup.gz")).rejects.toBe(failure);
    expect(vi.mocked(createReadStream).mock.results[0]!.value.destroyed).toBe(true);
  });

  it("preserves server error details and closes the failed upload source", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("quota reached", { status: 507 })),
    );
    await expect(provider().upload(await backupFile(), "backup.gz")).rejects.toThrow(
      "WebDAV upload failed (507): quota reached",
    );
    expect(vi.mocked(createReadStream).mock.results[0]!.value.destroyed).toBe(true);
  });

  it("does not turn response cleanup failure into an operation failure", async () => {
    const { result } = response(207, vi.fn().mockRejectedValue(new Error("cancel failed")));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(result));
    await expect(provider().test()).resolves.toEqual({ ok: true });
  });
});

it.each([
  "backup#1.sql.gz",
  "backup?part=1.sql.gz",
  "backup%2Fname.sql.gz",
  "个人 备份.sql.gz",
  "backup.sql.gz",
])("uses the same literal filename %j for upload and deletion", async (filename) => {
  const fetchMock = vi.fn().mockImplementation(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  const storage = provider();
  const remoteUrl = await storage.upload(await backupFile(), filename);
  await storage.delete(filename);
  expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
    `/backups/${encodeURIComponent(filename)}`,
    `/backups/${encodeURIComponent(filename)}`,
  ]);
  expect(new URL(remoteUrl).pathname).toBe(`/backups/${encodeURIComponent(filename)}`);
  for (const [url] of fetchMock.mock.calls) {
    expect(new URL(url).search).toBe("");
    expect(new URL(url).hash).toBe("");
  }
});

it.each(["fixture", "fixture/"])(
  "preserves configured query value %j when appending a filename",
  async (queryValue) => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const storage = new WebDAVProvider(
      `https://storage.test/base%20folder/?scope=${queryValue}`,
      "user",
      "password",
    );
    const remoteUrl = await storage.upload(await backupFile(), "backup#1.sql.gz");
    await storage.delete("backup#1.sql.gz");
    expect(remoteUrl).toBe(
      `https://storage.test/base%20folder/backup%231.sql.gz?scope=${queryValue}`,
    );
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([remoteUrl, remoteUrl]);
  },
);
