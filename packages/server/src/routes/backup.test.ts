import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { BackupService } from "../services/backup.js";
import { backupRoutes } from "./backup.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, createReadStream: vi.fn(original.createReadStream) };
});

const directories: string[] = [];
async function fixture() {
  const backupDir = await mkdtemp(join(tmpdir(), "backup-routes-"));
  directories.push(backupDir);
  const service = new BackupService({
    db: {} as never,
    databaseUrl: "postgres://synthetic",
    backupDir,
    encryptionKey: "synthetic",
    logger: {} as never,
  });
  const getConfig = vi.spyOn(service, "getConfig").mockResolvedValue(null);
  const saveConfig = vi.spyOn(service, "saveConfig").mockResolvedValue(undefined);
  return { service, backupDir, getConfig, saveConfig, app: backupRoutes(service, "synthetic") };
}
afterEach(async () => {
  for (const result of vi.mocked(createReadStream).mock.results) {
    if (result.type === "return") result.value.destroy();
  }
  vi.mocked(createReadStream).mockClear();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

it.each(["../outside", "sub/folder", "sub\\folder", "bad\0", "bad\r\n"])(
  "rejects unsafe prefix %j before loading or saving config",
  async (filePrefix) => {
    const { app, getConfig, saveConfig } = await fixture();
    const response = await app.request("/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ storage: { type: "local" }, filePrefix }),
    });
    expect(response.status).toBe(400);
    expect(getConfig).not.toHaveBeenCalled();
    expect(saveConfig).not.toHaveBeenCalled();
  },
);

it.each(["", "个人 备份", "daily-backup"])("preserves valid prefix %j", async (filePrefix) => {
  const { app, saveConfig } = await fixture();
  const response = await app.request("/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storage: { type: "local" }, filePrefix }),
  });
  expect(response.status).toBe(200);
  expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ filePrefix }));
});

it.each(["个人 备份.sql.gz", 'quoted "backup" (1).sql.gz', "daily.sql.gz"])(
  "downloads %j with an ASCII-safe header and encoded original filename",
  async (filename) => {
    const { app, service, backupDir } = await fixture();
    const bytes = Buffer.from([0x1f, 0x8b, 0x00, 0xff]);
    await writeFile(join(backupDir, filename), bytes);
    vi.spyOn(service, "getBackup").mockResolvedValue({ filename, status: "completed" } as never);
    const response = await app.request("/1/download");
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
    const disposition = response.headers.get("content-disposition")!;
    expect([...disposition].every((char) => char.charCodeAt(0) < 128)).toBe(true);
    expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]!)).toBe(filename);
    expect(response.headers.get("content-length")).toBe(String(bytes.length));
  },
);

it("rejects a stored path outside the backup directory without an internal error", async () => {
  const { app, service } = await fixture();
  vi.spyOn(service, "getBackup").mockResolvedValue({
    filename: "../outside.sql.gz",
    status: "completed",
  } as never);
  const response = await app.request("/1/download");
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ ok: false });
});

it("does not open a backup source when the request is already cancelled", async () => {
  const { app, service, backupDir } = await fixture();
  await writeFile(join(backupDir, "backup.sql.gz"), "synthetic");
  vi.spyOn(service, "getBackup").mockResolvedValue({
    filename: "backup.sql.gz",
    status: "completed",
  } as never);
  const controller = new AbortController();
  controller.abort();
  const response = await app.request("/1/download", { signal: controller.signal });
  expect(response.status).toBe(499);
  expect(await response.text()).toBe("");
  expect(createReadStream).not.toHaveBeenCalled();
});

it.each(["request", "reader"])("closes the backup source on %s cancellation", async (cancel) => {
  const { app, service, backupDir } = await fixture();
  await writeFile(join(backupDir, "backup.sql.gz"), Buffer.alloc(8 * 1024 * 1024, 1));
  vi.spyOn(service, "getBackup").mockResolvedValue({
    filename: "backup.sql.gz",
    status: "completed",
  } as never);
  const controller = new AbortController();
  const response = await app.request("/1/download", { signal: controller.signal });
  const reader = response.body!.getReader();
  await reader.read();
  const source = vi.mocked(createReadStream).mock.results[0]!.value;
  if (cancel === "reader") {
    await reader.cancel();
  } else {
    controller.abort();
    await expect(
      (async () => {
        while (!(await reader.read()).done) {
          /* Buffered chunks may precede cancellation. */
        }
      })(),
    ).rejects.toMatchObject({ name: "AbortError" });
  }
  await vi.waitFor(() => expect(source.closed).toBe(true));
  expect(source.bytesRead).toBeLessThan(8 * 1024 * 1024);
});
