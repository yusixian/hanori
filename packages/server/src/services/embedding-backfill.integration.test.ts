import { randomUUID } from "node:crypto";
import { DEFAULT_TIMEOUT_CONFIG } from "@cos-tool-bot/shared";
import { createDb } from "@cos-tool-bot/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { backfillMissingEmbeddings } from "./embedding-backfill.js";

const baseUrl = process.env.EMBEDDING_BACKFILL_TEST_DATABASE_URL;

describe.skipIf(!baseUrl)("embedding backfill with PostgreSQL", () => {
  const databaseName = `embedding_backfill_${randomUUID().replaceAll("-", "")}_test`;
  const botId = randomUUID();
  const otherBotId = randomUUID();
  let admin: ReturnType<typeof createDb> | undefined;
  let connection: ReturnType<typeof createDb> | undefined;
  let created = false;
  beforeAll(async () => {
    const parsed = new URL(baseUrl!);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || !parsed.pathname.endsWith("_test"))
      throw new Error("Backfill tests require an explicit local *_test database");
    admin = createDb(parsed.href);
    await admin.client.unsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    parsed.pathname = `/${databaseName}`;
    connection = createDb(parsed.href);
    // Text storage exercises Drizzle's vector serialization and SQL guards, not pgvector search.
    for (const table of ["bot_memories", "conversation_messages"]) {
      await connection.client.unsafe(`CREATE TABLE ${table} (
        id serial PRIMARY KEY, bot_id uuid NOT NULL, content text NOT NULL,
        embedding text, role text DEFAULT 'user', is_active boolean DEFAULT true,
        updated_at timestamp DEFAULT now()
      )`);
    }
  });
  afterAll(async () => {
    await connection?.client.end();
    if (created) await admin!.client.unsafe(`DROP DATABASE "${databaseName}"`);
    await admin?.client.end();
  });
  beforeEach(async () => {
    await connection!.client.unsafe(
      "TRUNCATE bot_memories, conversation_messages RESTART IDENTITY",
    );
  });

  describe.each(["memories", "messages"] as const)("%s", (kind) => {
    const table = kind === "memories" ? "bot_memories" : "conversation_messages";
    async function seed(count: number, owner = botId) {
      return connection!.client.unsafe<{ id: number; content: string }[]>(
        `INSERT INTO ${table} (bot_id, content) SELECT $1, 'row-' || n FROM generate_series(1,$2) n RETURNING id, content`,
        [owner, count],
      );
    }
    async function stored() {
      return connection!.client.unsafe<{ id: number; content: string; embedding: string | null }[]>(
        `SELECT id, content, embedding FROM ${table} WHERE bot_id = $1 ORDER BY id`,
        [botId],
      );
    }

    it("advances across failed batches once and leaves them eligible for a later run", async () => {
      await seed(205);
      await seed(1, otherBotId);
      const generateEmbeddings = vi.fn(async (texts: string[]) => texts.map(() => null));
      const report = vi.fn();
      expect(
        await backfillMissingEmbeddings(
          connection!.db,
          botId,
          kind,
          { generateEmbeddings },
          report,
        ),
      ).toEqual({ attempted: 205, saved: 0, failed: 205, skipped: 0 });
      expect(generateEmbeddings.mock.calls.map(([texts]) => texts.length)).toEqual([100, 100, 5]);
      expect(new Set(generateEmbeddings.mock.calls.flatMap(([texts]) => texts)).size).toBe(205);
      expect(report.mock.calls.map(([progress]) => progress.attempted)).toEqual([100, 200, 205]);
      expect((await stored()).every((row) => row.embedding === null)).toBe(true);
      expect(
        await backfillMissingEmbeddings(connection!.db, botId, kind, {
          generateEmbeddings: async (texts) => texts.map(() => [0.1, 0.2]),
        }),
      ).toEqual({ attempted: 205, saved: 205, failed: 0, skipped: 0 });
    });

    it("times out a batch and continues with a fresh deadline for the next batch", async () => {
      await seed(101);
      const controllers: AbortController[] = [];
      const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
        const controller = new AbortController();
        controllers.push(controller);
        return controller.signal;
      });
      let finishFirst!: () => void;
      const first = new Promise<null[]>((resolve) => {
        finishFirst = () => resolve(Array.from({ length: 100 }, () => null));
      });
      const generateEmbeddings = vi.fn(async (texts: string[], signal?: AbortSignal) => {
        if (generateEmbeddings.mock.calls.length === 1) {
          signal?.addEventListener("abort", finishFirst, { once: true });
          return first;
        }
        return texts.map(() => [1]);
      });
      const pending = backfillMissingEmbeddings(connection!.db, botId, kind, {
        generateEmbeddings,
      });
      try {
        await vi.waitFor(() => expect(generateEmbeddings).toHaveBeenCalledTimes(1));
        expect(timeout).toHaveBeenCalledWith(DEFAULT_TIMEOUT_CONFIG.perStepMs);
        controllers[0]!.abort(new DOMException("Batch deadline", "TimeoutError"));
        expect(await pending).toEqual({ attempted: 101, saved: 1, failed: 100, skipped: 0 });
        expect(timeout).toHaveBeenCalledTimes(2);
        expect(generateEmbeddings.mock.calls[0]![1]).toBe(controllers[0]!.signal);
        expect(generateEmbeddings.mock.calls[1]![1]).toBe(controllers[1]!.signal);
        expect(controllers[1]!.signal.aborted).toBe(false);
        const rows = await stored();
        expect(rows.slice(0, 100).every((row) => row.embedding === null)).toBe(true);
        expect(rows[100]!.embedding).toBe("[1]");
      } finally {
        finishFirst();
        try {
          await pending;
        } finally {
          timeout.mockRestore();
        }
      }
    });

    if (kind === "memories") {
      it.each([null, "2026-09-20 00:00:00.123456"])(
        "preserves the edit version %s when filling only a vector",
        async (version) => {
          const [row] = await seed(1);
          await connection!
            .client`UPDATE bot_memories SET updated_at = ${version} WHERE id = ${row!.id}`;
          expect(
            await backfillMissingEmbeddings(connection!.db, botId, kind, {
              generateEmbeddings: async () => [[1]],
            }),
          ).toEqual({ attempted: 1, saved: 1, failed: 0, skipped: 0 });
          const [stored] = await connection!.client`
          SELECT embedding, updated_at::text AS version FROM bot_memories WHERE id = ${row!.id}
        `;
          expect(stored).toMatchObject({ embedding: "[1]", version });
        },
      );
    }

    it("counts actual saves and does not retry partial failures in the same run", async () => {
      await seed(3);
      const generateEmbeddings = vi.fn(async () => [null, [0.1], [0.2]]);
      expect(
        await backfillMissingEmbeddings(connection!.db, botId, kind, { generateEmbeddings }),
      ).toEqual({ attempted: 3, saved: 2, failed: 1, skipped: 0 });
      expect(generateEmbeddings).toHaveBeenCalledOnce();
      expect((await stored()).map((row) => row.embedding)).toEqual([null, "[0.1]", "[0.2]"]);
    });

    it("does not overwrite changed text, an existing vector, or a deleted row", async () => {
      const rows = await seed(4);
      const original = `${"x".repeat(8000)}original`;
      await connection!.client.unsafe(`UPDATE ${table} SET content = $1 WHERE id = $2`, [
        original,
        rows[0]!.id,
      ]);
      const generateEmbeddings = vi.fn(async (texts: string[]) => {
        expect(texts[0]).toBe(original);
        await connection!.client.unsafe(`UPDATE ${table} SET content = $1 WHERE id = $2`, [
          `${"x".repeat(8000)}changed`,
          rows[0]!.id,
        ]);
        await connection!.client.unsafe(`UPDATE ${table} SET embedding = '[9]' WHERE id = $1`, [
          rows[1]!.id,
        ]);
        await connection!.client.unsafe(`DELETE FROM ${table} WHERE id = $1`, [rows[2]!.id]);
        return texts.map(() => [1]);
      });
      expect(
        await backfillMissingEmbeddings(connection!.db, botId, kind, { generateEmbeddings }),
      ).toEqual({ attempted: 4, saved: 1, failed: 0, skipped: 3 });
      expect((await stored()).map((row) => row.embedding)).toEqual([null, "[9]", "[1]"]);
    });

    it("leaves concurrently inserted rows beyond the initial ID bound for the next run", async () => {
      await seed(101);
      const generateEmbeddings = vi.fn(async (texts: string[]) => {
        if (generateEmbeddings.mock.calls.length === 1) await seed(2);
        return texts.map(() => [1]);
      });
      expect(
        await backfillMissingEmbeddings(connection!.db, botId, kind, { generateEmbeddings }),
      ).toEqual({ attempted: 101, saved: 101, failed: 0, skipped: 0 });
      expect(generateEmbeddings.mock.calls.map(([texts]) => texts.length)).toEqual([100, 1]);
      expect((await stored()).filter((row) => row.embedding === null)).toHaveLength(2);
    });

    it("preserves owner, role and existing-vector selection without excluding inactive memories", async () => {
      const rows = await seed(4);
      await seed(1, otherBotId);
      await connection!.client.unsafe(`UPDATE ${table} SET embedding = '[9]' WHERE id = $1`, [
        rows[0]!.id,
      ]);
      await connection!.client.unsafe(
        `UPDATE ${table} SET role = 'assistant', is_active = false WHERE id = $1`,
        [rows[1]!.id],
      );
      await connection!.client.unsafe(`UPDATE ${table} SET role = 'system' WHERE id = $1`, [
        rows[2]!.id,
      ]);
      const generateEmbeddings = vi.fn(async (texts: string[]) => texts.map(() => [1]));
      const count = kind === "messages" ? 2 : 3;
      expect(
        await backfillMissingEmbeddings(connection!.db, botId, kind, { generateEmbeddings }),
      ).toEqual({ attempted: count, saved: count, failed: 0, skipped: 0 });
      expect(generateEmbeddings.mock.calls[0]![0]).toEqual(
        kind === "messages" ? ["row-2", "row-4"] : ["row-2", "row-3", "row-4"],
      );
      generateEmbeddings.mockClear();
      expect(
        await backfillMissingEmbeddings(connection!.db, botId, kind, { generateEmbeddings }),
      ).toEqual({ attempted: 0, saved: 0, failed: 0, skipped: 0 });
      expect(generateEmbeddings).not.toHaveBeenCalled();
    });

    it("propagates database write errors instead of reporting success or retrying", async () => {
      await seed(1);
      await connection!.client.unsafe(
        `CREATE FUNCTION reject_backfill() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic write failure'; END; $$`,
      );
      await connection!.client.unsafe(
        `CREATE TRIGGER reject_backfill BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_backfill()`,
      );
      const generateEmbeddings = vi.fn(async () => [[1]]);
      try {
        await expect(
          backfillMissingEmbeddings(connection!.db, botId, kind, { generateEmbeddings }),
        ).rejects.toThrow();
        expect(generateEmbeddings).toHaveBeenCalledOnce();
        expect((await stored())[0]!.embedding).toBeNull();
      } finally {
        await connection!.client.unsafe(`DROP TRIGGER reject_backfill ON ${table}`);
        await connection!.client.unsafe("DROP FUNCTION reject_backfill()");
      }
    });
  });
});
