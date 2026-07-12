import { botRuns, bots } from "@cos-tool-bot/database";
import type { Database } from "@cos-tool-bot/database";
import { describe, expect, it } from "vitest";
import { encrypt } from "../utils/crypto.js";
import { BotRunService } from "./bot-run-service.js";

const encryptionKey = "test-key";

function fakeDb() {
  const state = {
    bots: [
      {
        id: "00000000-0000-4000-8000-000000000017",
        platform: "telegram",
        aiConfig: {
          enabled: true,
          systemPrompt: "Be useful",
          activeProviderId: "p1",
          providers: [
            {
              id: "p1",
              label: "Fake",
              encryptedApiKey: encrypt("test-secret", encryptionKey),
              baseURL: "http://fake.invalid/v1",
              providerFormat: "openai",
              defaultModel: "fake-model",
            },
          ],
          triggerConfig: {
            replyToBot: true,
            mentionBot: true,
            triggerWords: [],
            randomReplyPercent: 0,
            randomReplyCooldown: 60,
          },
          groupOverrides: {},
        },
      },
    ] as Array<Record<string, unknown>>,
    runs: [] as Array<Record<string, unknown>>,
    events: [] as Array<Record<string, unknown>>,
  };

  class Query implements PromiseLike<unknown[]> {
    constructor(private rows: () => Array<Record<string, unknown>>) {}
    from() {
      return this;
    }
    where() {
      return this;
    }
    orderBy() {
      return this;
    }
    limit(count: number) {
      return new Query(() => this.rows().slice(0, count));
    }
    // oxlint-disable-next-line unicorn/no-thenable -- Drizzle queries are intentionally awaitable.
    then<TResult1 = unknown[], TResult2 = never>(
      onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      return Promise.resolve(this.rows()).then(onfulfilled, onrejected);
    }
  }

  const db = {
    select: () => ({
      from: (table: unknown) =>
        new Query(() => {
          if (table === bots) return state.bots;
          if (table === botRuns) return state.runs;
          return state.events;
        }),
    }),
    insert: (table: unknown) => ({
      values: (value: Record<string, unknown>) => {
        const row = {
          id: table === botRuns ? crypto.randomUUID() : state.events.length + 1,
          createdAt: new Date(),
          ...(table === botRuns ? { status: "running", failureReason: null } : {}),
          ...value,
        };
        if (table === botRuns) state.runs.push(row);
        else state.events.push(row);
        return { returning: async () => [row] };
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          const rows = table === botRuns ? state.runs : state.events;
          Object.assign(rows.at(-1) ?? {}, values);
          return { returning: async () => (rows.at(-1) ? [rows.at(-1)] : []) };
        },
      }),
    }),
  } as unknown as Database;
  return { db, state };
}

function fakeResult(parts: Array<Record<string, unknown>>, text: string) {
  return {
    fullStream: (async function* () {
      for (const part of parts) yield part;
    })(),
    text: Promise.resolve(text),
    finishReason: Promise.resolve("stop"),
    usage: Promise.resolve({ inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
  };
}

async function waitForCompletion(state: ReturnType<typeof fakeDb>["state"]) {
  for (let i = 0; i < 50; i++) {
    if (state.runs[0]?.["status"] !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("run did not complete");
}

describe("BotRunService", () => {
  it.each([
    {
      name: "successful output",
      result: fakeResult([{ type: "text-delta", text: "hello" }], "hello"),
      status: "succeeded",
      reason: null,
    },
    {
      name: "stream error event",
      result: fakeResult([{ type: "error", error: new Error("broken stream") }], ""),
      status: "failed",
      reason: "provider_stream_failed",
    },
    {
      name: "empty output",
      result: fakeResult([{ type: "finish", finishReason: "stop" }], ""),
      status: "failed",
      reason: "provider_empty_output",
    },
  ])("records $name with stable diagnostics", async ({ result, status, reason }) => {
    const { db, state } = fakeDb();
    const service = new BotRunService(db, encryptionKey, (() => result) as never);
    await service.start(String(state.bots[0]?.["id"]), { text: "hello" });
    await waitForCompletion(state);
    expect(state.runs[0]).toMatchObject({ status, failureReason: reason, mode: "dry-run" });
    expect(state.events.map((event) => event["kind"])).toContain("ai-request");
    expect(JSON.stringify(state.events)).not.toContain("test-secret");
  });

  it("classifies a failure before streaming as a provider request failure", async () => {
    const { db, state } = fakeDb();
    const service = new BotRunService(db, encryptionKey, (() => {
      throw new Error("connection refused");
    }) as never);
    await service.start(String(state.bots[0]?.["id"]), { text: "hello" });
    await waitForCompletion(state);
    expect(state.runs[0]?.["failureReason"]).toBe("provider_request_failed");
  });

  it("extracts text from Telegram and Lark native events", async () => {
    const { db, state } = fakeDb();
    const service = new BotRunService(db, encryptionKey, (() => fakeResult([], "ok")) as never);
    await service.start(String(state.bots[0]?.["id"]), {
      channelEvent: { message: { text: "telegram text" } },
    });
    await service.start(String(state.bots[0]?.["id"]), {
      channel: "lark-webhook",
      channelEvent: { event: { message: { content: JSON.stringify({ text: "lark text" }) } } },
    });
    expect(state.runs).toHaveLength(2);
  });

  it("supports list, detail, event cursors, pinning, and cancellation APIs", async () => {
    const { db, state } = fakeDb();
    const service = new BotRunService(db, encryptionKey, (() => fakeResult([], "ok")) as never);
    const run = await service.start(String(state.bots[0]?.["id"]), { text: "inspect me" });
    expect(await service.cancel(String(state.bots[0]?.["id"]), run.id)).toBe(true);
    expect(await service.list(String(state.bots[0]?.["id"]), 500)).toHaveLength(1);
    expect(await service.list(String(state.bots[0]?.["id"]), Number.NaN)).toHaveLength(1);
    expect(await service.get(String(state.bots[0]?.["id"]), run.id)).not.toBeNull();
    expect(await service.eventsAfter(run.id, 0)).toBeDefined();
    expect(await service.pin(String(state.bots[0]?.["id"]), run.id, true)).toMatchObject({
      pinned: true,
    });
    await waitForCompletion(state);
    expect(await service.cancel(String(state.bots[0]?.["id"]), run.id)).toBe(false);
  });

  it("rejects missing bots and unsupported native events", async () => {
    const missing = fakeDb();
    missing.state.bots.length = 0;
    const missingService = new BotRunService(missing.db, encryptionKey);
    await expect(missingService.start(crypto.randomUUID(), { text: "hello" })).rejects.toThrow(
      "Bot not found",
    );

    const { db, state } = fakeDb();
    const service = new BotRunService(db, encryptionKey);
    await expect(
      service.start(String(state.bots[0]?.["id"]), { channelEvent: { update_id: 1 } }),
    ).rejects.toThrow("does not contain");
    await expect(
      service.start(String(state.bots[0]?.["id"]), {
        channelEvent: { event: { message: { content: "not-json" } } },
      }),
    ).rejects.toThrow("does not contain");
  });

  it("records missing AI configuration as a request failure", async () => {
    const { db, state } = fakeDb();
    state.bots[0]!["aiConfig"] = null;
    const service = new BotRunService(db, encryptionKey);
    await service.start(String(state.bots[0]?.["id"]), { text: "hello" });
    await waitForCompletion(state);
    expect(state.runs[0]?.["failureReason"]).toBe("provider_request_failed");
  });

  it("rejects empty input and handles providers without credentials", async () => {
    const { db, state } = fakeDb();
    const service = new BotRunService(db, encryptionKey);
    await expect(service.start(String(state.bots[0]?.["id"]), { text: "  " })).rejects.toThrow(
      "required",
    );
    const config = state.bots[0]?.["aiConfig"] as {
      providers: Array<Record<string, unknown>>;
    };
    config.providers[0]!["encryptedApiKey"] = null;
    await service.start(String(state.bots[0]?.["id"]), { text: "hello" });
    await waitForCompletion(state);
    expect(state.runs[0]?.["failureReason"]).toBe("provider_request_failed");
  });

  it("supports Gemini configured providers through the same event protocol", async () => {
    const { db, state } = fakeDb();
    const config = state.bots[0]?.["aiConfig"] as {
      providers: Array<Record<string, unknown>>;
    };
    config.providers[0]!["providerFormat"] = "gemini";
    (state.bots[0]!["aiConfig"] as Record<string, unknown>)["behavioralPrompt"] = "Be concise";
    const service = new BotRunService(db, encryptionKey, (() =>
      fakeResult([{ type: "text-delta", text: "ok" }], "ok")) as never);
    await service.start(String(state.bots[0]?.["id"]), { text: "hello" });
    await waitForCompletion(state);
    expect(state.runs[0]?.["status"]).toBe("succeeded");
  });

  it("records undecryptable credentials and cancels orphaned running records", async () => {
    const { db, state } = fakeDb();
    const config = state.bots[0]?.["aiConfig"] as {
      providers: Array<Record<string, unknown>>;
    };
    config.providers[0]!["encryptedApiKey"] = "not-encrypted";
    const service = new BotRunService(db, encryptionKey);
    await service.start(String(state.bots[0]?.["id"]), { text: "hello" });
    await waitForCompletion(state);
    expect(state.runs[0]?.["failureReason"]).toBe("provider_request_failed");

    state.runs[0]!["status"] = "running";
    const restartedService = new BotRunService(db, encryptionKey);
    expect(
      await restartedService.cancel(String(state.bots[0]?.["id"]), String(state.runs[0]?.["id"])),
    ).toBe(true);
    expect(state.runs[0]).toMatchObject({ status: "failed", failureReason: "cancelled" });
  });
});
