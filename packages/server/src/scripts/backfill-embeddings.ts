/**
 * Backfill embeddings for existing conversation messages and bot memories.
 *
 * Usage: tsx packages/server/src/scripts/backfill-embeddings.ts
 *
 * Reads each bot's embeddingConfig from the bots table to obtain API credentials.
 * Processes a bounded ID range with `embedding IS NULL` in batches, once per row.
 * Safe to re-run: skips rows that already have embeddings.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDb, bots, EMBEDDING_DIMENSIONS } from "@cos-tool-bot/database";
import {
  backfillMissingEmbeddings,
  type EmbeddingBackfillProgress,
} from "../services/embedding-backfill.js";
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
      dimensions: EMBEDDING_DIMENSIONS,
    });

    console.log(`Bot "${bot.name}" (${bot.id}): starting backfill...`);

    for (const kind of ["memories", "messages"] as const) {
      const report = (progress: EmbeddingBackfillProgress) =>
        console.log(
          `  ${kind}: ${progress.attempted} attempted, ${progress.saved} saved, ${progress.failed} failed, ${progress.skipped} skipped`,
        );
      const progress = await backfillMissingEmbeddings(db, bot.id, kind, service, report);
      if (progress.attempted === 0) report(progress);
    }
    console.log(
      `Bot "${bot.name}": backfill complete; failed or changed rows remain for a later run`,
    );
  }

  console.log("Backfill finished");
} finally {
  await client.end();
}
