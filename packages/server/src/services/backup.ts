import type { Database } from "@cos-tool-bot/database";
import { backups, settings } from "@cos-tool-bot/database";
import type { BackupConfig, BackupRecord, BackupStorageConfig } from "@cos-tool-bot/shared";
import { desc, eq } from "drizzle-orm";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { decrypt, encrypt } from "../utils/crypto.js";
import { createStorageProvider, type StorageProvider } from "./storage/index.js";

const CONFIG_KEY = "backup_config";

interface BackupServiceOptions {
  db: Database;
  databaseUrl: string;
  backupDir: string;
  encryptionKey: string;
}

export class BackupService {
  private db: Database;
  private databaseUrl: string;
  private backupDir: string;
  private encryptionKey: string;
  private isBackingUp = false;

  constructor(options: BackupServiceOptions) {
    this.db = options.db;
    this.databaseUrl = options.databaseUrl;
    this.backupDir = options.backupDir;
    this.encryptionKey = options.encryptionKey;
  }

  async createBackup(): Promise<BackupRecord> {
    if (this.isBackingUp) {
      throw new Error("A backup is already in progress");
    }
    this.isBackingUp = true;
    const startTime = Date.now();

    try {
      await mkdir(this.backupDir, { recursive: true });

      const config = await this.getConfig();
      const prefix = config?.filePrefix || "cos-tool-bot";
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `${prefix}_${timestamp}.sql.gz`;
      const filePath = join(this.backupDir, filename);

      // Run pg_dump and pipe through gzip
      await this.runPgDump(filePath);

      const fileStats = await stat(filePath);
      const durationMs = Date.now() - startTime;

      // Upload to remote if configured
      let remoteUrl: string | null = null;
      let remoteProvider: string | null = null;

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
          const [record] = await this.db
            .insert(backups)
            .values({
              filename,
              sizeBytes: fileStats.size,
              durationMs,
              remoteUrl: null,
              remoteProvider: null,
              status: "completed",
              error: `Remote upload failed: ${msg}`,
            })
            .returning();
          await this.cleanupOldBackups();
          return this.toRecord(record!);
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
        })
        .returning();

      await this.cleanupOldBackups();
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
    return join(this.backupDir, filename);
  }

  async deleteBackup(id: number): Promise<void> {
    const [row] = await this.db.select().from(backups).where(eq(backups.id, id));
    if (!row) throw new Error("Backup not found");

    // Delete local file
    const filePath = join(this.backupDir, row.filename);
    await unlink(filePath).catch(() => {});

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
      } catch {
        // Ignore remote deletion errors
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
      .select()
      .from(backups)
      .where(eq(backups.status, "completed"))
      .orderBy(desc(backups.createdAt));

    if (rows.length <= maxCount) return;

    const toDelete = rows.slice(maxCount);
    for (const row of toDelete) {
      try {
        await this.deleteBackup(row.id);
      } catch {
        // Continue cleaning up other backups
      }
    }
  }

  private async getStorageProvider(config: BackupStorageConfig): Promise<StorageProvider | null> {
    return createStorageProvider(config, (encrypted) => decrypt(encrypted, this.encryptionKey));
  }

  private runPgDump(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        "pg_dump",
        [this.databaseUrl, "--no-owner", "--no-privileges", "--clean", "--if-exists"],
        { maxBuffer: 512 * 1024 * 1024 },
      );

      if (!child.stdout) {
        reject(new Error("pg_dump stdout not available"));
        return;
      }

      child.on("error", (err) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error("pg_dump not found. Install postgresql-client to enable backups."));
        } else {
          reject(err);
        }
      });

      const gzip = createGzip();
      const outStream = createWriteStream(filePath);

      pipeline(child.stdout, gzip, outStream).then(resolve).catch(reject);

      child.on("exit", (code) => {
        if (code !== 0) {
          reject(new Error(`pg_dump exited with code ${code}`));
        }
      });
    });
  }

  private toRecord(row: typeof backups.$inferSelect): BackupRecord {
    return {
      id: row.id,
      filename: row.filename,
      sizeBytes: row.sizeBytes,
      durationMs: row.durationMs,
      remoteUrl: row.remoteUrl,
      remoteProvider: row.remoteProvider,
      status: row.status,
      error: row.error,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
