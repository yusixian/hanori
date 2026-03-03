import { bots, type Database } from "@cos-tool-bot/database";
import { DEFAULT_INJECTABLE_FILES, DEFAULT_MAX_INJECTION_SIZE } from "@cos-tool-bot/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { BOT_DATA_TEMPLATES } from "../templates/bot-data-templates.js";
import type { BotPool } from "../services/bot-pool.js";
import {
  ALLOWED_EXTENSIONS,
  CONTENT_TYPE_MAP,
  MAX_FILE_SIZE,
  getDataDir,
  resolveAndValidate,
  resolveAndValidateDir,
} from "../utils/file-validation.js";

/**
 * Extract the file sub-path from the raw URL.
 * Hono delivers `c.req.path` already percent-decoded once, so we must NOT
 * call `decodeURIComponent` again (double-decode would turn `%252e` → `..`).
 */
function extractFilePath(reqPath: string, botId: string, segment = "files"): string {
  if (botId.includes("/")) return "";
  const prefix = `/api/bots/${botId}/${segment}/`;
  const idx = reqPath.indexOf(prefix);
  if (idx === -1) return "";
  return reqPath.slice(idx + prefix.length);
}

export function botFilesRoutes(db: Database, botPool: BotPool) {
  return new Hono()
    .get(
      "/:botId/files",
      zValidator("query", z.object({ path: z.string().max(500).optional() })),
      async (c) => {
        const botId = c.req.param("botId");
        const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
        if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);

        const dataDir = getDataDir(botId);
        const subPath = c.req.valid("query").path ?? "";
        const resolvedDir = resolveAndValidateDir(dataDir, subPath);
        if (!resolvedDir) return c.json({ ok: false as const, error: "Invalid path" }, 403);

        const dfConfig = bot.aiConfig?.dataFilesConfig;
        const injection = {
          injectableFiles: dfConfig?.injectableFiles ?? DEFAULT_INJECTABLE_FILES,
          maxTotalSize: dfConfig?.maxTotalSize ?? DEFAULT_MAX_INJECTION_SIZE,
        };
        try {
          await fs.mkdir(resolvedDir, { recursive: true });
          const entries = await fs.readdir(resolvedDir, { withFileTypes: true });
          const files = await Promise.all(
            entries
              .filter((entry) => {
                if (entry.isDirectory()) return true;
                const ext = path.extname(entry.name).toLowerCase();
                return ALLOWED_EXTENSIONS.has(ext);
              })
              .map(async (entry) => {
                const fullPath = path.join(resolvedDir, entry.name);
                const relativePath = subPath ? `${subPath}/${entry.name}` : entry.name;
                if (entry.isDirectory()) {
                  return {
                    name: entry.name,
                    path: relativePath,
                    size: 0,
                    type: "dir" as const,
                  };
                }
                const stat = await fs.stat(fullPath);
                return {
                  name: entry.name,
                  path: relativePath,
                  size: stat.size,
                  type: "file" as const,
                };
              }),
          );
          files.sort((a, b) => {
            if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
          return c.json({ ok: true as const, files, injection });
        } catch {
          return c.json({ ok: true as const, files: [], injection });
        }
      },
    )
    .get("/:botId/files-raw/*", async (c) => {
      const botId = c.req.param("botId");
      const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
      if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);

      const filePath = extractFilePath(c.req.path, botId, "files-raw");
      if (!filePath) return c.json({ ok: false as const, error: "File path required" }, 400);

      const dataDir = getDataDir(botId);
      const resolved = resolveAndValidate(dataDir, filePath);
      if (!resolved) return c.json({ ok: false as const, error: "Invalid path" }, 403);

      try {
        const stat = await fs.stat(resolved);
        if (stat.size > MAX_FILE_SIZE) {
          return c.json({ ok: false as const, error: "File too large" }, 413);
        }
        const buffer = await fs.readFile(resolved);
        const ext = path.extname(resolved).toLowerCase();
        const contentType = CONTENT_TYPE_MAP[ext] ?? "application/octet-stream";
        const headers: Record<string, string> = { "Content-Type": contentType };

        const download = c.req.query("download");
        if (download === "true") {
          const fileName = path.basename(resolved);
          headers["Content-Disposition"] =
            `attachment; filename="${fileName.replace(/"/g, '\\"')}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
        }

        return c.body(buffer, 200, headers);
      } catch {
        return c.json({ ok: false as const, error: "File not found" }, 404);
      }
    })
    .get("/:botId/files/*", async (c) => {
      const botId = c.req.param("botId");
      const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
      if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);

      const filePath = extractFilePath(c.req.path, botId);
      if (!filePath) return c.json({ ok: false as const, error: "File path required" }, 400);

      const dataDir = getDataDir(botId);
      const resolved = resolveAndValidate(dataDir, filePath);
      if (!resolved) return c.json({ ok: false as const, error: "Invalid path" }, 403);

      try {
        const stat = await fs.stat(resolved);
        if (stat.size > MAX_FILE_SIZE) {
          return c.json({ ok: false as const, error: "File too large" }, 413);
        }
        const content = await fs.readFile(resolved, "utf-8");
        return c.json({ ok: true as const, content, size: stat.size });
      } catch {
        return c.json({ ok: false as const, error: "File not found" }, 404);
      }
    })
    .put("/:botId/files/*", async (c) => {
      const botId = c.req.param("botId");
      const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
      if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);

      const filePath = extractFilePath(c.req.path, botId);
      if (!filePath) return c.json({ ok: false as const, error: "File path required" }, 400);

      const dataDir = getDataDir(botId);
      const resolved = resolveAndValidate(dataDir, filePath);
      if (!resolved) return c.json({ ok: false as const, error: "Invalid path" }, 403);

      let body: { content: string };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ ok: false as const, error: "Invalid JSON body" }, 400);
      }
      if (typeof body.content !== "string") {
        return c.json({ ok: false as const, error: "Content must be a string" }, 400);
      }
      if (Buffer.byteLength(body.content, "utf-8") > MAX_FILE_SIZE) {
        return c.json({ ok: false as const, error: "Content too large" }, 413);
      }

      try {
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, body.content, "utf-8");
        return c.json({ ok: true as const });
      } catch {
        return c.json({ ok: false as const, error: "Failed to write file" }, 500);
      }
    })
    .delete("/:botId/files/*", async (c) => {
      const botId = c.req.param("botId");
      const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
      if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);

      const filePath = extractFilePath(c.req.path, botId);
      if (!filePath) return c.json({ ok: false as const, error: "File path required" }, 400);

      // Prevent deletion of injectable files
      const injectableFiles =
        bot.aiConfig?.dataFilesConfig?.injectableFiles ?? DEFAULT_INJECTABLE_FILES;
      if (injectableFiles.includes(filePath)) {
        return c.json(
          {
            ok: false as const,
            error: "Cannot delete injectable file. Remove it from injection list first.",
          },
          403,
        );
      }

      const dataDir = getDataDir(botId);
      const resolved = resolveAndValidate(dataDir, filePath);
      if (!resolved) return c.json({ ok: false as const, error: "Invalid path" }, 403);

      try {
        await fs.unlink(resolved);
        return c.json({ ok: true as const });
      } catch {
        return c.json({ ok: false as const, error: "File not found" }, 404);
      }
    })
    .post(
      "/:botId/files-delete-batch",
      zValidator("json", z.object({ files: z.array(z.string().min(1).max(500)).min(1).max(100) })),
      async (c) => {
        const botId = c.req.param("botId");
        const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
        if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);

        const { files: filePaths } = c.req.valid("json");
        const dataDir = getDataDir(botId);
        const injectableFiles =
          bot.aiConfig?.dataFilesConfig?.injectableFiles ?? DEFAULT_INJECTABLE_FILES;

        const deleted: string[] = [];
        const skipped: string[] = [];

        for (const filePath of filePaths) {
          if (injectableFiles.includes(filePath)) {
            skipped.push(filePath);
            continue;
          }
          const resolved = resolveAndValidate(dataDir, filePath);
          if (!resolved) {
            skipped.push(filePath);
            continue;
          }
          try {
            await fs.unlink(resolved);
            deleted.push(filePath);
          } catch {
            skipped.push(filePath);
          }
        }

        return c.json({ ok: true as const, deleted, skipped });
      },
    )
    .put(
      "/:botId/files-injection",
      zValidator(
        "json",
        z.object({
          injectableFiles: z.array(z.string().min(1).max(255)),
          maxTotalSize: z.number().int().min(0).max(1048576),
        }),
      ),
      async (c) => {
        const botId = c.req.param("botId");
        const body = c.req.valid("json");
        const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
        if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);

        const aiConfig = bot.aiConfig ?? ({} as NonNullable<typeof bot.aiConfig>);
        const updated = {
          ...aiConfig,
          dataFilesConfig: {
            injectableFiles: body.injectableFiles,
            maxTotalSize: body.maxTotalSize,
          },
        };
        await db.update(bots).set({ aiConfig: updated }).where(eq(bots.id, botId));

        // Restart bot if running so new config takes effect
        const manager = botPool.getManager(botId);
        if (manager) {
          try {
            await botPool.restartBot(botId);
          } catch {
            // continue
          }
        }

        return c.json({
          ok: true as const,
          injection: updated.dataFilesConfig,
        });
      },
    )
    .post("/:botId/files-init", async (c) => {
      const botId = c.req.param("botId");
      const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
      if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);

      const dataDir = getDataDir(botId);
      await fs.mkdir(dataDir, { recursive: true });

      const created: string[] = [];
      for (const [name, content] of Object.entries(BOT_DATA_TEMPLATES)) {
        const filePath = path.join(dataDir, name);
        try {
          await fs.access(filePath);
          // File already exists, skip
        } catch {
          await fs.writeFile(filePath, content, "utf-8");
          created.push(name);
        }
      }

      // Set default dataFilesConfig if not already configured
      if (!bot.aiConfig?.dataFilesConfig) {
        const aiConfig = bot.aiConfig ?? ({} as NonNullable<typeof bot.aiConfig>);
        await db
          .update(bots)
          .set({
            aiConfig: {
              ...aiConfig,
              dataFilesConfig: {
                injectableFiles: DEFAULT_INJECTABLE_FILES,
                maxTotalSize: DEFAULT_MAX_INJECTION_SIZE,
              },
            },
          })
          .where(eq(bots.id, botId));
      }

      return c.json({ ok: true as const, created });
    });
}
