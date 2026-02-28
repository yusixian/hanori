import { bots, type Database } from "@cos-tool-bot/database";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { BOT_DATA_TEMPLATES } from "../templates/bot-data-templates.js";
import {
  ALLOWED_EXTENSIONS,
  MAX_FILE_SIZE,
  getDataDir,
  resolveAndValidate,
} from "../utils/file-validation.js";

/**
 * Extract the file sub-path from the raw URL.
 * Hono delivers `c.req.path` already percent-decoded once, so we must NOT
 * call `decodeURIComponent` again (double-decode would turn `%252e` → `..`).
 */
function extractFilePath(reqPath: string, botId: string): string {
  if (botId.includes("/")) return "";
  const prefix = `/api/bots/${botId}/files/`;
  const idx = reqPath.indexOf(prefix);
  if (idx === -1) return "";
  return reqPath.slice(idx + prefix.length);
}

export function botFilesRoutes(db: Database) {
  return new Hono()
    .get("/:botId/files", async (c) => {
      const botId = c.req.param("botId");
      const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
      if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);

      const dataDir = getDataDir(botId);
      try {
        await fs.mkdir(dataDir, { recursive: true });
        const entries = await fs.readdir(dataDir, { withFileTypes: true });
        const files = await Promise.all(
          entries
            .filter((entry) => {
              if (entry.isDirectory()) return false;
              const ext = path.extname(entry.name).toLowerCase();
              return ALLOWED_EXTENSIONS.has(ext);
            })
            .map(async (entry) => {
              const filePath = path.join(dataDir, entry.name);
              const stat = await fs.stat(filePath);
              return {
                name: entry.name,
                path: entry.name,
                size: stat.size,
                type: "file" as const,
              };
            }),
        );
        files.sort((a, b) => a.name.localeCompare(b.name));
        return c.json({ ok: true as const, files });
      } catch {
        return c.json({ ok: true as const, files: [] });
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

      return c.json({ ok: true as const, created });
    });
}
