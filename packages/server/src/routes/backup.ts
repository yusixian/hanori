import type {
  BackupConfig,
  BackupConfigS3,
  BackupConfigWebDAV,
  BackupStorageConfig,
} from "@cos-tool-bot/shared";
import { zValidator } from "@hono/zod-validator";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Hono } from "hono";
import { z } from "zod";
import type { BackupService } from "../services/backup.js";
import { decrypt, encrypt } from "../utils/crypto.js";

const PASSWORD_PLACEHOLDER = "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";

const storageConfigSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("local") }),
  z.object({
    type: z.literal("webdav"),
    url: z.string().url(),
    username: z.string().min(1),
    password: z.string().min(1),
  }),
  z.object({
    type: z.literal("s3"),
    bucket: z.string().min(1),
    region: z.string().min(1),
    endpoint: z.string().optional(),
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
    prefix: z.string().optional(),
    forcePathStyle: z.boolean().optional(),
    storageClass: z
      .enum([
        "STANDARD",
        "REDUCED_REDUNDANCY",
        "STANDARD_IA",
        "ONEZONE_IA",
        "INTELLIGENT_TIERING",
        "GLACIER",
        "DEEP_ARCHIVE",
        "GLACIER_IR",
      ])
      .optional(),
    serverSideEncryption: z.enum(["AES256", "aws:kms", "aws:kms:dsse"]).optional(),
    sseKmsKeyId: z.string().optional(),
  }),
]);

const backupConfigSchema = z.object({
  storage: storageConfigSchema,
  filePrefix: z.string().optional(),
  retention: z
    .object({
      maxCount: z.number().int().min(0).optional(),
    })
    .optional(),
});

const testConfigSchema = z.object({
  storage: storageConfigSchema,
});

export function backupRoutes(backupService: BackupService, encryptionKey: string) {
  return new Hono()
    .post("/", async (c) => {
      try {
        const record = await backupService.createBackup();
        return c.json({ ok: true as const, data: record });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ ok: false as const, error: msg }, 500);
      }
    })
    .get("/", async (c) => {
      try {
        const records = await backupService.listBackups();
        return c.json({ ok: true as const, data: records });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ ok: false as const, error: msg }, 500);
      }
    })
    .get("/:id/download", async (c) => {
      const id = Number(c.req.param("id"));
      if (Number.isNaN(id)) return c.json({ ok: false as const, error: "Invalid ID" }, 400);

      const record = await backupService.getBackup(id);
      if (!record) return c.json({ ok: false as const, error: "Backup not found" }, 404);

      if (record.status === "failed") {
        return c.json({ ok: false as const, error: "Cannot download a failed backup" }, 400);
      }

      const filePath = backupService.getBackupFilePath(record.filename);
      try {
        const fileStats = await stat(filePath);
        const stream = createReadStream(filePath);
        return new Response(stream as unknown as ReadableStream, {
          headers: {
            "Content-Type": "application/gzip",
            "Content-Disposition": `attachment; filename="${record.filename}"`,
            "Content-Length": String(fileStats.size),
          },
        });
      } catch {
        return c.json({ ok: false as const, error: "Backup file not found on disk" }, 404);
      }
    })
    .delete("/:id", async (c) => {
      const id = Number(c.req.param("id"));
      if (Number.isNaN(id)) return c.json({ ok: false as const, error: "Invalid ID" }, 400);

      try {
        await backupService.deleteBackup(id);
        return c.json({ ok: true as const });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ ok: false as const, error: msg }, 500);
      }
    })
    .get("/config", async (c) => {
      const config = await backupService.getConfig();
      if (!config) return c.json({ ok: true as const, data: null });

      // Redact secrets
      const redacted = { ...config };
      if (redacted.storage.type === "webdav") {
        redacted.storage = {
          ...redacted.storage,
          encryptedPassword: PASSWORD_PLACEHOLDER,
        };
      } else if (redacted.storage.type === "s3") {
        redacted.storage = {
          ...redacted.storage,
          encryptedSecretKey: PASSWORD_PLACEHOLDER,
        };
      }
      return c.json({ ok: true as const, data: redacted });
    })
    .put("/config", zValidator("json", backupConfigSchema), async (c) => {
      const body = c.req.valid("json");
      const existing = await backupService.getConfig();

      // Build the storage config with encrypted secrets
      let storage: BackupStorageConfig;
      if (body.storage.type === "local") {
        storage = { type: "local" };
      } else if (body.storage.type === "webdav") {
        let encryptedPassword: string;
        if (body.storage.password === PASSWORD_PLACEHOLDER && existing?.storage.type === "webdav") {
          encryptedPassword = existing.storage.encryptedPassword;
        } else {
          encryptedPassword = encrypt(body.storage.password, encryptionKey);
        }
        storage = {
          type: "webdav",
          url: body.storage.url,
          username: body.storage.username,
          encryptedPassword,
        } satisfies BackupConfigWebDAV;
      } else {
        let encryptedSecretKey: string;
        if (
          body.storage.secretAccessKey === PASSWORD_PLACEHOLDER &&
          existing?.storage.type === "s3"
        ) {
          encryptedSecretKey = existing.storage.encryptedSecretKey;
        } else {
          encryptedSecretKey = encrypt(body.storage.secretAccessKey, encryptionKey);
        }
        storage = {
          type: "s3",
          bucket: body.storage.bucket,
          region: body.storage.region,
          endpoint: body.storage.endpoint,
          accessKeyId: body.storage.accessKeyId,
          encryptedSecretKey,
          prefix: body.storage.prefix,
          forcePathStyle: body.storage.forcePathStyle,
          storageClass: body.storage.storageClass,
          serverSideEncryption: body.storage.serverSideEncryption,
          sseKmsKeyId: body.storage.sseKmsKeyId,
        } satisfies BackupConfigS3;
      }

      const config: BackupConfig = {
        storage,
        filePrefix: body.filePrefix,
        retention: body.retention,
      };

      await backupService.saveConfig(config);
      return c.json({ ok: true as const });
    })
    .post("/config/test", zValidator("json", testConfigSchema), async (c) => {
      const body = c.req.valid("json");

      // Resolve passwords: if placeholder, use existing encrypted value
      let testConfig: BackupStorageConfig;
      if (body.storage.type === "local") {
        return c.json({ ok: true as const, data: { ok: true } });
      } else if (body.storage.type === "webdav") {
        let password: string;
        if (body.storage.password === PASSWORD_PLACEHOLDER) {
          const existing = await backupService.getConfig();
          if (existing?.storage.type !== "webdav") {
            return c.json({
              ok: true as const,
              data: { ok: false, error: "No existing WebDAV config" },
            });
          }
          try {
            password = decrypt(existing.storage.encryptedPassword, encryptionKey);
          } catch {
            return c.json({
              ok: true as const,
              data: {
                ok: false,
                error: "Encryption key mismatch, cannot decrypt storage credentials",
              },
            });
          }
        } else {
          password = body.storage.password;
        }
        testConfig = {
          type: "webdav",
          url: body.storage.url,
          username: body.storage.username,
          encryptedPassword: encrypt(password, encryptionKey),
        };
      } else {
        let secretAccessKey: string;
        if (body.storage.secretAccessKey === PASSWORD_PLACEHOLDER) {
          const existing = await backupService.getConfig();
          if (existing?.storage.type !== "s3") {
            return c.json({
              ok: true as const,
              data: { ok: false, error: "No existing S3 config" },
            });
          }
          try {
            secretAccessKey = decrypt(existing.storage.encryptedSecretKey, encryptionKey);
          } catch {
            return c.json({
              ok: true as const,
              data: {
                ok: false,
                error: "Encryption key mismatch, cannot decrypt storage credentials",
              },
            });
          }
        } else {
          secretAccessKey = body.storage.secretAccessKey;
        }
        testConfig = {
          type: "s3",
          bucket: body.storage.bucket,
          region: body.storage.region,
          endpoint: body.storage.endpoint,
          accessKeyId: body.storage.accessKeyId,
          encryptedSecretKey: encrypt(secretAccessKey, encryptionKey),
          prefix: body.storage.prefix,
          forcePathStyle: body.storage.forcePathStyle,
          storageClass: body.storage.storageClass,
          serverSideEncryption: body.storage.serverSideEncryption,
          sseKmsKeyId: body.storage.sseKmsKeyId,
        };
      }

      const result = await backupService.testRemoteStorage(testConfig);
      return c.json({ ok: true as const, data: result });
    });
}
