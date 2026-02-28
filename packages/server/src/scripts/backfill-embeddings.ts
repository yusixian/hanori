/**
 * Backfill embeddings for existing conversation messages and bot memories.
 *
 * Usage: tsx packages/server/src/scripts/backfill-embeddings.ts
 *
 * Reads each bot's embeddingConfig from the bots table to obtain API credentials.
 * Processes records with `embedding IS NULL` in batches.
 * Safe to re-run: skips rows that already have embeddings.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDb, bots, botMemories, conversationMessages } from "@cos-tool-bot/database";
import { and, eq, isNull, inArray } from "drizzle-orm";
import { EmbeddingService } from "../services/embedding-service.js";
import { tryDecrypt } from "../utils/crypto.js";

// Load .env from monorepo root
if (!process.env["DATABASE_URL"]) {
  try {
    const envPath = resolve(import.meta.dirname, "../../../../.env");
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx);
      const value = trimmed.slice(eqIdx + 1).replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // ignore
  }
}

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const encryptionKey = process.env["ENCRYPTION_KEY"] ?? "";

const BATCH_SIZE = 100;

const { db, client } = createDb(databaseUrl);

try {
  const allBots = await db.select().from(bots);

  for (const bot of allBots) {
    const embCfg = bot.aiConfig?.embeddingConfig;
    if (!embCfg?.enabled || !embCfg.encryptedApiKey) {
      console.log(`Bot "${bot.name}" (${bot.id}): embedding not configured, skipping`);
      continue;
    }

    const apiKey = tryDecrypt(embCfg.encryptedApiKey, encryptionKey);
    if (!apiKey) {
      console.log(`Bot "${bot.name}" (${bot.id}): cannot decrypt embedding API key, skipping`);
      continue;
    }

    const service = new EmbeddingService({
      apiKey,
      baseURL: embCfg.baseURL,
      model: embCfg.model,
      dimensions: embCfg.dimensions,
    });

    console.log(`Bot "${bot.name}" (${bot.id}): starting backfill...`);

    // Backfill bot memories
    let memoryCount = 0;
    while (true) {
      const rows = await db
        .select({ id: botMemories.id, content: botMemories.content })
        .from(botMemories)
        .where(and(eq(botMemories.botId, bot.id), isNull(botMemories.embedding)))
        .limit(BATCH_SIZE);

      if (rows.length === 0) break;

      const embeddings = await service.generateEmbeddings(rows.map((r) => r.content));
      const updates = rows
        .map((r, i) => ({ id: r.id, embedding: embeddings[i] }))
        .filter((u): u is { id: number; embedding: number[] } => u.embedding != null);
      await Promise.all(
        updates.map((u) =>
          db.update(botMemories).set({ embedding: u.embedding }).where(eq(botMemories.id, u.id)),
        ),
      );
      memoryCount += rows.length;
      console.log(`  memories: ${memoryCount} processed`);
    }

    // Backfill conversation messages (only user/assistant)
    let msgCount = 0;
    while (true) {
      const rows = await db
        .select({ id: conversationMessages.id, content: conversationMessages.content })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.botId, bot.id),
            isNull(conversationMessages.embedding),
            inArray(conversationMessages.role, ["user", "assistant"]),
          ),
        )
        .limit(BATCH_SIZE);

      if (rows.length === 0) break;

      const embeddings = await service.generateEmbeddings(rows.map((r) => r.content));
      const updates = rows
        .map((r, i) => ({ id: r.id, embedding: embeddings[i] }))
        .filter((u): u is { id: number; embedding: number[] } => u.embedding != null);
      await Promise.all(
        updates.map((u) =>
          db
            .update(conversationMessages)
            .set({ embedding: u.embedding })
            .where(eq(conversationMessages.id, u.id)),
        ),
      );
      msgCount += rows.length;
      console.log(`  messages: ${msgCount} processed`);
    }

    console.log(
      `Bot "${bot.name}": backfill complete (${memoryCount} memories, ${msgCount} messages)`,
    );
  }

  console.log("Backfill finished");
} finally {
  await client.end();
}
