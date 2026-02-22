import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { resolve } from "node:path";
import postgres from "postgres";
import * as schema from "./schema.js";

export * from "./schema.js";
export { schema };

export async function runMigrations(databaseUrl: string) {
  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client);
  await migrate(db, {
    migrationsFolder: resolve(import.meta.dirname!, "../drizzle"),
  });
  await client.end();
}

export function createDb(databaseUrl: string) {
  const client = postgres(databaseUrl, {
    max: 20,
    idle_timeout: 30,
    connect_timeout: 10,
  });
  return { db: drizzle(client, { schema }), client };
}

export type Database = ReturnType<typeof createDb>["db"];
