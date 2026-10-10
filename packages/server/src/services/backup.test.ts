import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackupService } from "./backup.js";
import { createStorageProvider } from "./storage/index.js";

vi.mock("./storage/index.js", () => ({ createStorageProvider: vi.fn() }));

const state = vi.hoisted(() => ({ script: "", missing: false, outputDirectory: "" }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((_file, _args, options) =>
      actual.spawn(
        state.missing ? "/nonexistent/cos-test-pg-dump" : process.execPath,
        ["-e", state.script],
        options,
      ),
    ),
    execFile: vi.fn((_file, _args, options) =>
      actual.execFile(
        state.missing ? "/nonexistent/cos-test-pg-dump" : process.execPath,
        ["-e", state.script],
        options,
      ),
    ),
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createWriteStream: (path: string) => actual.createWriteStream(state.outputDirectory || path),
  };
});

const directories: string[] = [];
async function fixture() {
  const backupDir = await mkdtemp(join(tmpdir(), "backup-lifecycle-"));
  directories.push(backupDir);
  const records: Array<Record<string, unknown>> = [];
  const db = {
    select: () => ({ from: () => ({ where: async () => [] }) }),
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    insert: () => ({
      values: (value: Record<string, unknown>) => ({
        returning: async () => {
          const record = { id: records.length + 1, createdAt: new Date(), ...value };
          records.push(record);
          return [record];
        },
      }),
    }),
  };
  const logger = { warn: vi.fn(), error: vi.fn() };
  const service = new BackupService({
    db: db as never,
    databaseUrl: "postgres://synthetic",
    backupDir,
    encryptionKey: "synthetic",
    logger: logger as never,
  });
  return { service, backupDir, records, logger, db };
}

afterEach(async () => {
  const { execFile } = await import("node:child_process");
  for (const mock of [vi.mocked(spawn), vi.mocked(execFile)]) {
    for (const result of mock.mock.results) {
      if (result.type === "return") {
        const child = result.value as ChildProcess;
        if (child.exitCode === null && child.signalCode === null) {
          const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
          child.kill("SIGKILL");
          await closed;
        }
      }
    }
    mock.mockClear();
  }
  vi.mocked(createStorageProvider).mockReset();
  state.script = "";
  state.missing = false;
  state.outputDirectory = "";
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("backup dump lifecycle", () => {
  it("records success only after the complete dump is compressed", async () => {
    const { service, backupDir, records } = await fixture();
    state.script = 'process.stdout.write("SELECT 1;\\n".repeat(200000))';
    const record = await service.createBackup();
    const compressed = await readFile(join(backupDir, record.filename));
    expect(gunzipSync(compressed).equals(Buffer.from("SELECT 1;\n".repeat(200000)))).toBe(true);
    expect(record.status).toBe("completed");
    expect(record.sizeBytes).toBe(compressed.length);
    expect(records).toHaveLength(1);
  });

  it("removes the incomplete archive after a failed dump", async () => {
    const { service, backupDir, records } = await fixture();
    state.script = 'process.stdout.write("incomplete SQL", () => process.exit(2))';
    await expect(service.createBackup()).rejects.toThrow("pg_dump exited with code 2");
    expect(await readdir(backupDir)).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("failed");
    state.script = 'process.stdout.write("retry succeeds")';
    await expect(service.createBackup()).resolves.toMatchObject({ status: "completed" });
  });

  it("reports a missing executable and leaves no empty archive", async () => {
    const { service, backupDir } = await fixture();
    state.missing = true;
    await expect(service.createBackup()).rejects.toThrow("pg_dump not found");
    expect(await readdir(backupDir)).toEqual([]);
  });

  it("reaps the dump process before reporting a destination failure", async () => {
    const { service, backupDir } = await fixture();
    state.outputDirectory = backupDir;
    state.script = 'setInterval(() => process.stdout.write("SQL"), 100)';
    await expect(service.createBackup()).rejects.toThrow();
    const { execFile } = await import("node:child_process");
    const calls = [...vi.mocked(spawn).mock.results, ...vi.mocked(execFile).mock.results];
    const child = calls[0]!.value as ChildProcess;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
});

it.each([false, true])(
  "preserves a completed backup when retention setup fails (remote failure: %s)",
  async (remoteFailure) => {
    const { service, backupDir, records, logger } = await fixture();
    state.script = 'process.stdout.write("valid backup")';
    const cleanupError = new Error("retention settings unavailable");
    vi.spyOn(service, "getConfig")
      .mockResolvedValueOnce({
        storage: remoteFailure
          ? {
              type: "webdav",
              url: "https://storage.test",
              username: "test",
              encryptedPassword: "synthetic",
            }
          : { type: "local" },
      })
      .mockRejectedValueOnce(cleanupError);
    vi.mocked(createStorageProvider).mockResolvedValue({
      upload: vi.fn().mockRejectedValue(new Error("remote unavailable")),
      delete: vi.fn(),
      test: vi.fn(),
    });
    const record = await service.createBackup();
    expect(record.status).toBe("completed");
    expect(records).toHaveLength(1);
    expect(gunzipSync(await readFile(join(backupDir, record.filename))).toString()).toBe(
      "valid backup",
    );
    expect(record.error).toBe(remoteFailure ? "Remote upload failed: remote unavailable" : null);
    expect(logger.warn).toHaveBeenCalledWith(
      { err: cleanupError },
      "Failed to clean up old backups",
    );
  },
);

it("keeps successful remote upload metadata on the shared completion path", async () => {
  const { service, records } = await fixture();
  state.script = 'process.stdout.write("valid backup")';
  vi.spyOn(service, "getConfig").mockResolvedValueOnce({
    storage: {
      type: "webdav",
      url: "https://storage.test",
      username: "test",
      encryptedPassword: "synthetic",
    },
  });
  vi.mocked(createStorageProvider).mockResolvedValue({
    upload: vi.fn().mockResolvedValue("https://storage.test/backup.gz"),
    delete: vi.fn(),
    test: vi.fn(),
  });
  await expect(service.createBackup()).resolves.toMatchObject({
    status: "completed",
    remoteUrl: "https://storage.test/backup.gz",
    remoteProvider: "webdav",
    error: null,
  });
  expect(records).toHaveLength(1);
});

it("still rejects when the completed backup cannot be recorded", async () => {
  const { service, records, db, logger } = await fixture();
  state.script = 'process.stdout.write("valid backup")';
  vi.spyOn(db, "insert").mockImplementationOnce(() => {
    throw new Error("record write failed");
  });
  await expect(service.createBackup()).rejects.toThrow("record write failed");
  expect(records).toHaveLength(1);
  expect(records[0]?.status).toBe("failed");
  expect(logger.warn).not.toHaveBeenCalled();
});

it("keeps the backup record when local deletion fails and allows retry", async () => {
  const { service, backupDir, db } = await fixture();
  const filename = "blocked.sql.gz";
  const filePath = join(backupDir, filename);
  await mkdir(filePath);
  vi.spyOn(db, "select").mockReturnValue({
    from: () => ({
      where: async () => [{ id: 1, filename, status: "completed", remoteProvider: "webdav" }],
    }),
  } as never);
  const remoteDelete = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(service, "getConfig").mockResolvedValue({
    storage: {
      type: "webdav",
      url: "https://storage.test",
      username: "test",
      encryptedPassword: "synthetic",
    },
  });
  vi.mocked(createStorageProvider).mockResolvedValue({
    upload: vi.fn(),
    delete: remoteDelete,
    test: vi.fn(),
  });
  await expect(service.deleteBackup(1)).rejects.toThrow();
  expect(remoteDelete).not.toHaveBeenCalled();
  expect(db.delete).not.toHaveBeenCalled();
  await rm(filePath, { recursive: true });
  await writeFile(filePath, "backup");
  await expect(service.deleteBackup(1)).resolves.toBeUndefined();
  expect(db.delete).toHaveBeenCalledOnce();
  expect(remoteDelete).toHaveBeenCalledWith(filename);
  expect(await readdir(backupDir)).toEqual([]);
});

it("removes the record when the local backup file is already absent", async () => {
  const { service, db } = await fixture();
  vi.spyOn(db, "select").mockReturnValue({
    from: () => ({
      where: async () => [
        { id: 1, filename: "already-removed.sql.gz", status: "completed", remoteProvider: null },
      ],
    }),
  } as never);
  await expect(service.deleteBackup(1)).resolves.toBeUndefined();
  expect(db.delete).toHaveBeenCalledOnce();
});

it("deletes failed backup records without attempting file or remote cleanup", async () => {
  const { service, backupDir, db } = await fixture();
  await mkdir(join(backupDir, "failed"));
  vi.spyOn(db, "select").mockReturnValue({
    from: () => ({
      where: async () => [{ id: 1, filename: "failed", status: "failed", remoteProvider: null }],
    }),
  } as never);
  await expect(service.deleteBackup(1)).resolves.toBeUndefined();
  expect(db.delete).toHaveBeenCalledOnce();
  expect(vi.mocked(createStorageProvider)).not.toHaveBeenCalled();
  expect(await readdir(backupDir)).toEqual(["failed"]);
});

it.each([
  "../outside.sql.gz",
  "sub/backup.sql.gz",
  "sub\\backup.sql.gz",
  "..",
  ".",
  "",
  "bad\0.sql.gz",
  "bad\n.sql.gz",
])("rejects invalid stored backup filename %j before file access", async (filename) => {
  const { service, db } = await fixture();
  expect(() => service.getBackupFilePath(filename)).toThrow("Invalid backup filename");
  vi.spyOn(db, "select").mockReturnValue({
    from: () => ({
      where: async () => [{ id: 1, filename, status: "completed", remoteProvider: null }],
    }),
  } as never);
  await expect(service.deleteBackup(1)).rejects.toThrow("Invalid backup filename");
  expect(db.delete).not.toHaveBeenCalled();
});

it("preserves ordinary Unicode and space-containing backup prefixes", async () => {
  const { service, backupDir } = await fixture();
  state.script = 'process.stdout.write("valid backup")';
  vi.spyOn(service, "getConfig").mockResolvedValue({
    storage: { type: "local" },
    filePrefix: "个人 备份",
  });
  const record = await service.createBackup();
  expect(record.filename.startsWith("个人 备份_")).toBe(true);
  expect(gunzipSync(await readFile(join(backupDir, record.filename))).toString()).toBe(
    "valid backup",
  );
});

it("rejects an unsafe persisted prefix before starting pg_dump", async () => {
  const { service, backupDir } = await fixture();
  vi.spyOn(service, "getConfig").mockResolvedValue({
    storage: { type: "local" },
    filePrefix: "../outside",
  });
  await expect(service.createBackup()).rejects.toThrow("Invalid backup filename");
  expect(spawn).not.toHaveBeenCalled();
  expect(await readdir(backupDir)).toEqual([]);
});

it("rejects an unsafe prefix saved directly through the service", async () => {
  const { service, db } = await fixture();
  const insert = vi.spyOn(db, "insert");
  await expect(
    service.saveConfig({ storage: { type: "local" }, filePrefix: "../outside" }),
  ).rejects.toThrow("Invalid backup file prefix");
  expect(insert).not.toHaveBeenCalled();
});

it("reports a failed retention deletion and continues cleaning later backups", async () => {
  const { service, backupDir, db, logger, records } = await fixture();
  state.script = 'process.stdout.write("valid new backup")';
  await mkdir(join(backupDir, "blocked.sql.gz"));
  await writeFile(join(backupDir, "old.sql.gz"), "old backup");
  vi.spyOn(service, "getConfig").mockResolvedValue({
    storage: { type: "local" },
    retention: { maxCount: 1 },
  });
  vi.spyOn(db, "select")
    .mockReturnValueOnce({
      from: () => ({
        where: () => ({ orderBy: () => ({ offset: async () => [{ id: 2 }, { id: 3 }] }) }),
      }),
    } as never)
    .mockReturnValueOnce({
      from: () => ({
        where: async () => [
          { id: 2, filename: "blocked.sql.gz", status: "completed", remoteProvider: null },
        ],
      }),
    } as never)
    .mockReturnValueOnce({
      from: () => ({
        where: async () => [
          { id: 3, filename: "old.sql.gz", status: "completed", remoteProvider: null },
        ],
      }),
    } as never);
  const record = await service.createBackup();
  expect(record.status).toBe("completed");
  expect(records).toHaveLength(1);
  expect(gunzipSync(await readFile(join(backupDir, record.filename))).toString()).toBe(
    "valid new backup",
  );
  expect(await readdir(backupDir)).toEqual(
    expect.arrayContaining([record.filename, "blocked.sql.gz"]),
  );
  await expect(readFile(join(backupDir, "old.sql.gz"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(db.delete).toHaveBeenCalledOnce();
  expect(logger.warn).toHaveBeenCalledWith(
    { err: expect.any(Error), backupId: 2 },
    "Failed to delete old backup",
  );
});
