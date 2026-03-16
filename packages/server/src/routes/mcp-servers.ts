import type { Database } from "@cos-tool-bot/database";
import { mcpServers } from "@cos-tool-bot/database";
import type { McpServerRecord } from "@cos-tool-bot/shared";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { mcpPresets } from "../constants/mcp-presets.js";
import type { McpClientManager } from "../services/mcp-client-manager.js";
import { encrypt } from "../utils/crypto.js";

function toRecord(row: typeof mcpServers.$inferSelect): McpServerRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    transport: row.transport as "sse" | "streamable-http",
    url: row.url,
    hasHeaders: !!row.encryptedHeaders,
    presetId: row.presetId,
    isActive: row.isActive,
    toolNamePrefix: row.toolNamePrefix,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

// URL is not filtered for private/internal addresses; acceptable because
// all MCP routes are JWT-protected (admin-only).
const createSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  transport: z.enum(["sse", "streamable-http"]).default("sse"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  presetId: z.string().max(100).optional(),
  isActive: z.boolean().default(true),
  toolNamePrefix: z.string().max(50).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  transport: z.enum(["sse", "streamable-http"]).optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  clearHeaders: z.boolean().optional(),
  isActive: z.boolean().optional(),
  toolNamePrefix: z.string().max(50).nullable().optional(),
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

export function mcpServerRoutes(
  db: Database,
  mcpClientManager: McpClientManager,
  encryptionKey: string,
) {
  return new Hono()
    .get("/", async (c) => {
      const rows = await db.select().from(mcpServers);
      const statuses = mcpClientManager.getStatus();
      const statusMap = new Map(statuses.map((s) => [s.serverId, s]));

      return c.json({
        ok: true as const,
        data: rows.map((r) => ({
          ...toRecord(r),
          status: statusMap.get(r.id) ?? {
            serverId: r.id,
            connected: false,
            toolCount: 0,
            tools: [],
            lastConnectedAt: null,
            error: null,
          },
        })),
      });
    })
    .post("/", zValidator("json", createSchema), async (c) => {
      const body = c.req.valid("json");

      let encryptedHeaders: string | null = null;
      if (body.headers && Object.keys(body.headers).length > 0) {
        encryptedHeaders = encrypt(JSON.stringify(body.headers), encryptionKey);
      }

      const [row] = await db
        .insert(mcpServers)
        .values({
          name: body.name,
          description: body.description ?? null,
          transport: body.transport,
          url: body.url,
          encryptedHeaders,
          presetId: body.presetId ?? null,
          isActive: body.isActive,
          toolNamePrefix: body.toolNamePrefix ?? null,
        })
        .returning();

      if (!row) return c.json({ ok: false as const, error: "Failed to create" }, 500);

      if (row.isActive) {
        // McpClientManager handles retry internally; catch to prevent unhandled rejection
        mcpClientManager.connect(row.id).catch(() => {});
      }

      return c.json({ ok: true as const, data: toRecord(row) }, 201);
    })
    .get("/presets", (c) => {
      return c.json({ ok: true as const, data: mcpPresets });
    })
    .get("/status", (c) => {
      return c.json({ ok: true as const, data: mcpClientManager.getStatus() });
    })
    .get("/:id", zValidator("param", idParam), async (c) => {
      const { id } = c.req.valid("param");
      const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, id));
      if (!row) return c.json({ ok: false as const, error: "Not found" }, 404);

      const status = mcpClientManager.getStatus(id)[0] ?? {
        serverId: id,
        connected: false,
        toolCount: 0,
        tools: [],
        lastConnectedAt: null,
        error: null,
      };
      return c.json({ ok: true as const, data: { ...toRecord(row), status } });
    })
    .patch("/:id", zValidator("param", idParam), zValidator("json", updateSchema), async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");

      const [existing] = await db.select().from(mcpServers).where(eq(mcpServers.id, id));
      if (!existing) return c.json({ ok: false as const, error: "Not found" }, 404);

      const updates: Partial<typeof mcpServers.$inferInsert> = {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.description !== undefined) updates.description = body.description;
      if (body.transport !== undefined) updates.transport = body.transport;
      if (body.url !== undefined) updates.url = body.url;
      if (body.isActive !== undefined) updates.isActive = body.isActive;
      if (body.toolNamePrefix !== undefined) updates.toolNamePrefix = body.toolNamePrefix || null;

      if (body.clearHeaders) {
        updates.encryptedHeaders = null;
      } else if (body.headers && Object.keys(body.headers).length > 0) {
        updates.encryptedHeaders = encrypt(JSON.stringify(body.headers), encryptionKey);
      }

      const [row] = await db
        .update(mcpServers)
        .set(updates)
        .where(eq(mcpServers.id, id))
        .returning();

      if (!row) return c.json({ ok: false as const, error: "Failed to update" }, 500);

      // Reconnect only when connection-relevant fields changed
      const needsReconnect =
        body.url !== undefined ||
        body.transport !== undefined ||
        body.headers !== undefined ||
        body.clearHeaders !== undefined ||
        body.isActive !== undefined;

      if (needsReconnect) {
        if (row.isActive) {
          // McpClientManager handles retry internally; catch to prevent unhandled rejection
          mcpClientManager.connect(id).catch(() => {});
        } else {
          await mcpClientManager.disconnect(id);
        }
      }

      return c.json({ ok: true as const, data: toRecord(row) });
    })
    .delete("/:id", zValidator("param", idParam), async (c) => {
      const { id } = c.req.valid("param");
      await mcpClientManager.disconnect(id);
      const [deleted] = await db.delete(mcpServers).where(eq(mcpServers.id, id)).returning();
      if (!deleted) return c.json({ ok: false as const, error: "Not found" }, 404);
      return c.json({ ok: true as const });
    })
    .post("/:id/connect", zValidator("param", idParam), async (c) => {
      const { id } = c.req.valid("param");
      const [server] = await db.select().from(mcpServers).where(eq(mcpServers.id, id));
      if (!server) return c.json({ ok: false as const, error: "Not found" }, 404);

      try {
        await mcpClientManager.connect(id);
        const status = mcpClientManager.getStatus(id)[0];
        return c.json({ ok: true as const, data: status });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ ok: false as const, error: msg }, 500);
      }
    })
    .post("/:id/disconnect", zValidator("param", idParam), async (c) => {
      const { id } = c.req.valid("param");
      await mcpClientManager.disconnect(id);
      return c.json({ ok: true as const });
    });
}
