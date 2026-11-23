import type { Database } from "@cos-tool-bot/database";
import { backups, settings } from "@cos-tool-bot/database";
import type { BackupConfig, BackupRecord, BackupStorageConfig } from "@cos-tool-bot/shared";
import { isValidBackupFilePrefix } from "@cos-tool-bot/shared";
import { desc, eq } from "drizzle-orm";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type { Logger } from "pino";
import { decrypt, encrypt } from "../utils/crypto.js";
import { withBackupConnection } from "./backup-connection.js";
import { createStorageProvider, type StorageProvider } from "./storage/index.js";

import { webdavRecordUrl } from "./storage/webdav.js";

const CONFIG_KEY = "backup_config";

function safeBackupError(message: string | null): string | null {
  if (!message?.startsWith("Remote upload failed:")) return message;
  return (
    message.match(/^Remote upload failed: WebDAV upload failed \(\d{3}\)/)?.[0] ??
    "Remote upload failed"
  );
}

interface BackupServiceOptions {
  db: Database;
  databaseUrl: string;
  backupDir: string;
  encryptionKey: string;
  logger: Logger;
}

export class BackupService {
  private db: Database;
  private databaseUrl: string;
  private backupDir: string;
  private encryptionKey: string;
  private logger: Logger;
  private isBackingUp = false;

  constructor(options: BackupServiceOptions) {
    this.db = options.db;
    this.databaseUrl = options.databaseUrl;
    this.backupDir = options.backupDir;
    this.encryptionKey = options.encryptionKey;
    this.logger = options.logger;
  }

  async init(): Promise<void> {
    await mkdir(this.backupDir, { recursive: true, mode: 0o700 });
    this.logger.info({ backupDir: this.backupDir }, "Backup directory ready");
  }

  async createBackup(): Promise<BackupRecord> {
    if (this.isBackingUp) {
      throw new Error("A backup is already in progress");
    }
    this.isBackingUp = true;
    const startTime = Date.now();

    try {
      await mkdir(this.backupDir, { recursive: true, mode: 0o700 });

      const config = await this.getConfig();
      const prefix = config?.filePrefix || "cos-tool-bot";
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `${prefix}_${timestamp}.sql.gz`;
      const filePath = this.getBackupFilePath(filename);

      // Run pg_dump and pipe through gzip
      await withBackupConnection(this.databaseUrl, (url, env) =>
        this.runPgDump(filePath, url, env),
      );

      const fileStats = await stat(filePath);
      const durationMs = Date.now() - startTime;

      // Upload to remote if configured
      let remoteUrl: string | null = null;
      let remoteProvider: string | null = null;
      let uploadError: string | null = null;

      if (config?.storage && config.storage.type !== "local") {
        try {
          const provider = await this.getStorageProvider(config.storage);
          if (provider) {
            remoteUrl = await provider.upload(filePath, filename);
            remoteProvider = config.storage.type;
          }
        } catch (err) {
          // Remote upload failure doesn't fail the backup
          const msg = err instanceof Error ? err.message : String(err);
          uploadError = safeBackupError(`Remote upload failed: ${msg}`);
        }
      }

      const [record] = await this.db
        .insert(backups)
        .values({
          filename,
          sizeBytes: fileStats.size,
          durationMs,
          remoteUrl,
          remoteProvider,
          status: "completed",
          error: uploadError,
        })
        .returning();

      await this.cleanupOldBackups().catch((err) => {
        this.logger.warn({ err }, "Failed to clean up old backups");
      });
      return this.toRecord(record!);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const [record] = await this.db
        .insert(backups)
        .values({
          filename: "failed",
          sizeBytes: 0,
          durationMs: Date.now() - startTime,
          status: "failed",
          error: msg,
        })
        .returning();
      throw Object.assign(new Error(msg), { record: this.toRecord(record!) });
    } finally {
      this.isBackingUp = false;
    }
  }

  async listBackups(): Promise<BackupRecord[]> {
    const rows = await this.db.select().from(backups).orderBy(desc(backups.createdAt));
    return rows.map((r) => this.toRecord(r));
  }

  async getBackup(id: number): Promise<BackupRecord | null> {
    const [row] = await this.db.select().from(backups).where(eq(backups.id, id));
    return row ? this.toRecord(row) : null;
  }

  getBackupFilePath(filename: string): string {
    if (!filename || filename === "." || filename === ".." || !isValidBackupFilePrefix(filename)) {
      throw new Error("Invalid backup filename");
    }
    return join(this.backupDir, filename);
  }

  async deleteBackup(id: number): Promise<void> {
    const [row] = await this.db.select().from(backups).where(eq(backups.id, id));
    if (!row) throw new Error("Backup not found");

    // Skip file cleanup for failed backups (no real file exists)
    if (row.status !== "failed") {
      // Delete local file
      const filePath = this.getBackupFilePath(row.filename);
      await unlink(filePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });

      // Delete remote file
      if (row.remoteProvider) {
        try {
          const config = await this.getConfig();
          if (config?.storage && config.storage.type !== "local") {
            const provider = await this.getStorageProvider(config.storage);
            if (provider) {
              await provider.delete(row.filename);
            }
          }
        } catch (err) {
          this.logger.warn({ err, backupId: id }, "Failed to delete remote backup file");
        }
      }
    }

    await this.db.delete(backups).where(eq(backups.id, id));
  }

  async getConfig(): Promise<BackupConfig | null> {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, CONFIG_KEY));
    if (!row) return null;
    return JSON.parse(row.value) as BackupConfig;
  }

  async saveConfig(config: BackupConfig): Promise<void> {
    if (config.filePrefix !== undefined && !isValidBackupFilePrefix(config.filePrefix)) {
      throw new Error("Invalid backup file prefix");
    }
    const value = JSON.stringify(config);
    await this.db
      .insert(settings)
      .values({ key: CONFIG_KEY, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } });
  }

  async testRemoteStorage(config: BackupStorageConfig): Promise<{ ok: boolean; error?: string }> {
    if (config.type === "local") return { ok: true };
    try {
      const provider = await this.getStorageProvider(config);
      if (!provider) return { ok: false, error: "Provider not available" };
      return await provider.test();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  encryptSecret(plaintext: string): string {
    return encrypt(plaintext, this.encryptionKey);
  }

  private async cleanupOldBackups(): Promise<void> {
    const config = await this.getConfig();
    const maxCount = config?.retention?.maxCount;
    if (!maxCount || maxCount <= 0) return;

    const rows = await this.db
      .select({ id: backups.id })
      .from(backups)
      .where(eq(backups.status, "completed"))
      .orderBy(desc(backups.createdAt))
      .offset(maxCount);

    for (const row of rows) {
      try {
        await this.deleteBackup(row.id);
      } catch (err) {
        this.logger.warn({ err, backupId: row.id }, "Failed to delete old backup");
      }
    }
  }

  private async getStorageProvider(config: BackupStorageConfig): Promise<StorageProvider | null> {
    return createStorageProvider(config, (encrypted) => decrypt(encrypted, this.encryptionKey));
  }

  private async runPgDump(filePath: string, url: string, env: NodeJS.ProcessEnv): Promise<void> {
    const destination = createWriteStream(filePath, { flags: "wx", mode: 0o600 });
    await once(destination, "open");
    try {
      await this.streamPgDump(url, env, destination);
    } catch (error) {
      destination.destroy();
      await unlink(filePath).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") this.logger.warn({ err }, "Failed to remove incomplete backup");
      });
      throw error;
    }
  }

  private async streamPgDump(
    url: string,
    env: NodeJS.ProcessEnv,
    destination: ReturnType<typeof createWriteStream>,
  ): Promise<void> {
    const child = spawn(
      "pg_dump",
      [url, "--no-password", "--no-owner", "--no-privileges", "--clean", "--if-exists"],
      { env, stdio: ["ignore", "pipe", "ignore"] },
    );
    let spawnError: Error | undefined;
    child.on("error", (error) => {
      spawnError = error;
    });
    const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
    const output = pipeline(child.stdout!, createGzip(), destination);

    try {
      const [, code] = await Promise.all([output, closed]);
      if (spawnError) throw spawnError;
      if (code !== 0) throw new Error(`pg_dump exited with code ${code ?? 1}`);
    } catch (error) {
      // A failed destination must not leave pg_dump running after the backup lock is released.
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
      await output.catch(() => {});
      if ((spawnError as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        throw new Error("pg_dump not found. Install postgresql-client to enable backups.");
      }
      throw spawnError ?? error;
    }
  }

  private toRecord(row: typeof backups.$inferSelect): BackupRecord {
    return {
      id: row.id,
      filename: row.filename,
      sizeBytes: row.sizeBytes,
      durationMs: row.durationMs,
      remoteUrl:
        row.remoteProvider === "webdav" && row.remoteUrl
          ? webdavRecordUrl(row.remoteUrl)
          : row.remoteUrl,
      remoteProvider: row.remoteProvider,
      status: row.status === "completed" || row.status === "failed" ? row.status : "failed",
      error: safeBackupError(row.error),
      createdAt: row.createdAt.toISOString(),
    };
  }
}
