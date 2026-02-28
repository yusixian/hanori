import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// Load .env from monorepo root if DATABASE_URL not set
if (!process.env["DATABASE_URL"]) {
  try {
    const envPath = resolve(import.meta.dirname, "../../../.env");
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
  throw new Error("DATABASE_URL is required");
}

const client = postgres(databaseUrl, { max: 1 });
const db = drizzle(client);

// Ensure pgvector extension is available before running migrations
await client`CREATE EXTENSION IF NOT EXISTS vector`;

await migrate(db, { migrationsFolder: "./drizzle" });
await client.end();

console.log("Migrations applied successfully");
