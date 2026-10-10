import { botRunEvents, botRuns, bots } from "@cos-tool-bot/database";
import type { Database } from "@cos-tool-bot/database";
import { DEFAULT_TIMEOUT_CONFIG } from "@cos-tool-bot/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encrypt } from "../utils/crypto.js";
import { BotRunService } from "./bot-run-service.js";

const encryptionKey = "test-key";

afterEach(() => {
  vi.restoreAllMocks();
});

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
    selectedTables: [] as unknown[],
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
      from: (table: unknown) => {
        state.selectedTables.push(table);
        return new Query(() => {
          if (table === bots) return state.bots;
          if (table === botRuns) return state.runs;
          return state.events;
        });
      },
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
          const targets =
            table === botRuns && values["failureReason"] === "interrupted"
              ? rows.filter((row) => row["status"] === "running")
              : rows.slice(-1);
          for (const row of targets) Object.assign(row, values);
          return { returning: async () => targets };
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

function abortEventResult(signal: AbortSignal) {
  return {
    fullStream: (async function* () {
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      yield { type: "abort" };
    })(),
    text: Promise.resolve(""),
    finishReason: Promise.resolve("stop"),
    usage: Promise.resolve({ inputTokens: 2, outputTokens: 0, totalTokens: 2 }),
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
      result: fakeResult(
        [
          { type: "text-delta", text: "partial" },
          { type: "error", error: new Error("broken stream") },
        ],
        "",
      ),
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

  it("does not count a lifecycle start event as provider output", async () => {
    const { db, state } = fakeDb();
    const service = new BotRunService(db, encryptionKey, (() =>
      fakeResult(
        [{ type: "start" }, { type: "error", error: new Error("401 invalid API key") }],
        "",
      )) as never);
    await service.start(String(state.bots[0]?.["id"]), { text: "hello" });
    await waitForCompletion(state);
    expect(state.runs[0]?.["failureReason"]).toBe("provider_request_failed");
  });

  it("classifies a result rejection after start as a provider request failure", async () => {
    const { db, state } = fakeDb();
    const service = new BotRunService(db, encryptionKey, (() => ({
      fullStream: (async function* () {
        yield { type: "start" };
      })(),
      get text() {
        return Promise.reject(new Error("provider rejected authentication"));
      },
      finishReason: Promise.resolve("error"),
      usage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    })) as never);

    await service.start(String(state.bots[0]?.["id"]), { text: "hello" });
    await waitForCompletion(state);

    expect(state.runs[0]?.["failureReason"]).toBe("provider_request_failed");
  });

  it("preserves a streamed failure reason when the result promise also rejects", async () => {
    const { db, state } = fakeDb();
    const service = new BotRunService(db, encryptionKey, (() => ({
      fullStream: (async function* () {
        yield { type: "start" };
        yield {
          type: "error",
          error: new DOMException("The operation was aborted due to timeout", "TimeoutError"),
        };
      })(),
      get text() {
        return Promise.reject(new Error("No output generated"));
      },
      finishReason: Promise.resolve("error"),
      usage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    })) as never);

    await service.start(String(state.bots[0]?.["id"]), { text: "hello" });
    await waitForCompletion(state);

    expect(state.runs[0]).toMatchObject({ status: "failed", failureReason: "timed_out" });
  });

  it.each([
    {
      providerFormat: "openai",
      thinking: "enabled",
      thinkingBudget: 128,
      providerOptions: {
        custom: { thinking: { type: "enabled", budget_tokens: 128 } },
      },
    },
    {
      providerFormat: "gemini",
      thinking: "enabled",
      thinkingBudget: 128,
      providerOptions: {
        google: {
          thinkingConfig: { thinkingBudget: 128, includeThoughts: true },
        },
      },
    },
    {
      providerFormat: "openai",
      thinking: "disabled",
      thinkingBudget: undefined,
      providerOptions: {
        custom: { thinking: { type: "disabled" } },
      },
    },
    {
      providerFormat: "gemini",
      thinking: "disabled",
      thinkingBudget: undefined,
      providerOptions: {
        google: {
          thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
        },
      },
    },
  ] as const)(
    "applies $providerFormat model request controls with thinking $thinking",
    async ({ providerFormat, thinking, thinkingBudget, providerOptions }) => {
      const { db, state } = fakeDb();
      const aiConfig = state.bots[0]?.["aiConfig"] as {
        providers: Array<Record<string, unknown>>;
      };
      aiConfig.providers[0]!["providerFormat"] = providerFormat;
      aiConfig.providers[0]!["models"] = [
        {
          id: "fake-model",
          temperature: 0.35,
          maxTokens: 2048,
          thinking,
          thinkingBudget,
        },
      ];
      const stream = vi.fn((_options: unknown) =>
        fakeResult([{ type: "text-delta", text: "ok" }], "ok"),
      );
      const service = new BotRunService(db, encryptionKey, stream as never);

      await service.start(String(state.bots[0]?.["id"]), { text: "hello" });
      await waitForCompletion(state);

      expect(stream).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: 0.35,
          maxOutputTokens: 2048,
          providerOptions,
        }),
      );
      if (providerFormat === "openai") {
        const request = stream.mock.calls[0]?.[0] as { model: { provider: string } };
        expect(request.model.provider).toBe("custom.chat");
      }
    },
  );

  it.each([
    { name: "configured", timeoutMs: 25 },
    { name: "default", timeoutMs: DEFAULT_TIMEOUT_CONFIG.aiReplyMs },
  ])("uses the $name AI reply timeout", async ({ name, timeoutMs }) => {
    const { db, state } = fakeDb();
    const aiConfig = state.bots[0]?.["aiConfig"] as Record<string, unknown>;
    if (name === "configured") aiConfig["timeoutConfig"] = { aiReplyMs: timeoutMs };
    const timeoutSignal = AbortSignal.abort(new DOMException("timeout probe", "TimeoutError"));
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutSignal);
    const service = new BotRunService(db, encryptionKey, (() => fakeResult([], "ok")) as never);

    await service.start(String(state.bots[0]?.["id"]), { text: "hello" });
    await waitForCompletion(state);

    expect(timeout).toHaveBeenCalledWith(timeoutMs);
    timeout.mockRestore();
  });

  it("finishes the run when an invalid timeout cannot create an abort signal", async () => {
    const { db, state } = fakeDb();
    const aiConfig = state.bots[0]?.["aiConfig"] as Record<string, unknown>;
    aiConfig["timeoutConfig"] = { aiReplyMs: 4_294_967_296 };
    const stream = vi.fn((_options: unknown) => fakeResult([], "ok"));
    const service = new BotRunService(db, encryptionKey, stream as never);

    await service.start(String(state.bots[0]?.["id"]), { text: "hello" });
    await waitForCompletion(state);

    expect(stream).not.toHaveBeenCalled();
    expect(state.runs[0]).toMatchObject({
      status: "failed",
      failureReason: "provider_request_failed",
    });
  });

  it("classifies an AI reply timeout as timed out", async () => {
    const { db, state } = fakeDb();
    const aiConfig = state.bots[0]?.["aiConfig"] as Record<string, unknown>;
    aiConfig["timeoutConfig"] = { aiReplyMs: 5 };
    const service = new BotRunService(db, encryptionKey, ((options: {
      abortSignal: AbortSignal;
    }) => ({
      fullStream: (async function* () {
        await new Promise<never>((_resolve, reject) => {
          options.abortSignal.addEventListener("abort", () => reject(options.abortSignal.reason), {
            once: true,
          });
        });
        yield { type: "finish" };
      })(),
      text: Promise.resolve(""),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve({ inputTokens: 2, outputTokens: 0, totalTokens: 2 }),
    })) as never);

    await service.start(String(state.bots[0]?.["id"]), { text: "hello" });
    await waitForCompletion(state);

    expect(state.runs[0]).toMatchObject({ status: "failed", failureReason: "timed_out" });
  });

  it("keeps operator cancellation distinct from timeouts", async () => {
    const { db, state } = fakeDb();
    const service = new BotRunService(db, encryptionKey, ((options: {
      abortSignal: AbortSignal;
    }) => ({
      fullStream: (async function* () {
        await new Promise<never>((_resolve, reject) => {
          options.abortSignal.addEventListener("abort", () => reject(options.abortSignal.reason), {
            once: true,
          });
        });
        yield { type: "finish" };
      })(),
      text: Promise.resolve(""),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve({ inputTokens: 2, outputTokens: 0, totalTokens: 2 }),
    })) as never);

    const run = await service.start(String(state.bots[0]?.["id"]), { text: "hello" });
    expect(await service.cancel(String(state.bots[0]?.["id"]), run.id)).toBe(true);
    await waitForCompletion(state);

    expect(state.runs[0]).toMatchObject({ status: "failed", failureReason: "cancelled" });
  });

  it("records a streamed abort event as operator cancellation", async () => {
    const { db, state } = fakeDb();
    let markStreamReady: (() => void) | undefined;
    const streamReady = new Promise<void>((resolve) => {
      markStreamReady = resolve;
    });
    const service = new BotRunService(db, encryptionKey, ((options: {
      abortSignal: AbortSignal;
    }) => {
      markStreamReady?.();
      return abortEventResult(options.abortSignal);
    }) as never);

    const run = await service.start(String(state.bots[0]?.["id"]), { text: "hello" });
    await streamReady;
    expect(await service.cancel(String(state.bots[0]?.["id"]), run.id)).toBe(true);
    await waitForCompletion(state);

    expect(state.events.map((event) => event["kind"])).toContain("ai-abort");
    expect(state.runs[0]).toMatchObject({ status: "failed", failureReason: "cancelled" });
  });

  it("records a streamed abort event caused by the reply timeout", async () => {
    const { db, state } = fakeDb();
    const aiConfig = state.bots[0]?.["aiConfig"] as Record<string, unknown>;
    aiConfig["timeoutConfig"] = { aiReplyMs: 5 };
    const service = new BotRunService(db, encryptionKey, ((options: { abortSignal: AbortSignal }) =>
      abortEventResult(options.abortSignal)) as never);

    await service.start(String(state.bots[0]?.["id"]), { text: "hello" });
    await waitForCompletion(state);

    expect(state.events.map((event) => event["kind"])).toContain("ai-abort");
    expect(state.runs[0]).toMatchObject({ status: "failed", failureReason: "timed_out" });
  });

  it("cancels a running record even when no in-memory controller remains", async () => {
    const { db, state } = fakeDb();
    const botId = String(state.bots[0]?.["id"]);
    const service = new BotRunService(db, encryptionKey);
    await service.list(botId);
    const run = {
      id: crypto.randomUUID(),
      botId,
      status: "running",
      failureReason: null,
      createdAt: new Date(),
    };
    state.runs.push(run);
    state.selectedTables.length = 0;

    await expect(service.cancel(botId, run.id)).resolves.toBe(true);

    expect(state.selectedTables).toEqual([botRuns]);
    expect(run).toMatchObject({ status: "failed", failureReason: "cancelled" });
    expect(run["completedAt" as keyof typeof run]).toBeInstanceOf(Date);
  });

  it("reconciles running records left behind by an interrupted service", async () => {
    const { db, state } = fakeDb();
    state.runs.push({
      id: crypto.randomUUID(),
      botId: state.bots[0]?.["id"],
      status: "running",
      failureReason: null,
      createdAt: new Date(),
    });

    const service = new BotRunService(db, encryptionKey);
    await service.list(String(state.bots[0]?.["id"]));

    expect(state.runs[0]).toMatchObject({ status: "failed", failureReason: "interrupted" });
    expect(state.runs[0]?.["completedAt"]).toBeInstanceOf(Date);
  });

  it("returns status without loading events", async () => {
    const { db, state } = fakeDb();
    state.runs.push({
      id: crypto.randomUUID(),
      botId: state.bots[0]?.["id"],
      status: "succeeded",
      failureReason: null,
      createdAt: new Date(),
    });
    const service = new BotRunService(db, encryptionKey);
    state.selectedTables.length = 0;

    await expect(
      service.getStatus(String(state.bots[0]?.["id"]), String(state.runs[0]?.["id"])),
    ).resolves.toBe("succeeded");
    expect(state.selectedTables).toEqual([botRuns]);
    expect(state.selectedTables).not.toContain(botRunEvents);
  });

  it("records replay provenance when replaying a channel event", async () => {
    const { db, state } = fakeDb();
    const service = new BotRunService(db, encryptionKey, (() =>
      fakeResult([{ type: "text-delta", text: "ok" }], "ok")) as never);

    await service.start(String(state.bots[0]?.["id"]), {
      channelEvent: { message: { text: "replayed channel text" } },
      replayOf: crypto.randomUUID(),
    });

    expect(state.runs[0]?.["source"]).toBe("replay");
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

  it("records undecryptable credentials", async () => {
    const { db, state } = fakeDb();
    const config = state.bots[0]?.["aiConfig"] as {
      providers: Array<Record<string, unknown>>;
    };
    config.providers[0]!["encryptedApiKey"] = "not-encrypted";
    const service = new BotRunService(db, encryptionKey);
    await service.start(String(state.bots[0]?.["id"]), { text: "hello" });
    await waitForCompletion(state);
    expect(state.runs[0]?.["failureReason"]).toBe("provider_request_failed");
  });
});

it.each(["events", "finish", "logger"] as const)(
  "contains background persistence failure at %s without leaking credentials",
  async (stage) => {
    const { db, state } = fakeDb();
    const logger = {
      error: vi.fn((_detail: unknown, _message?: string) => {
        if (stage === "logger") throw new Error("synthetic logger failure");
      }),
    };
    const stream = vi.fn(() => fakeResult([], "ok"));
    const service = new BotRunService(db, encryptionKey, stream as never, logger);
    const botId = String(state.bots[0]!["id"]);
    await service.list(botId);
    const failure = Object.assign(
      new Error("database rejected test-secret token=synthetic-token", {
        cause: new Error("upstream test-secret Authorization: Bearer nested-token"),
      }),
      { params: ["test-secret", { apiKey: "parameter-key" }], code: "08006" },
    );
    const persist = vi.fn(async () => {
      await Promise.resolve();
      throw failure;
    });
    if (stage === "finish") {
      vi.spyOn(db, "update").mockReturnValue({
        set: () => ({ where: persist }),
      } as unknown as ReturnType<typeof db.update>);
    } else {
      const insert = db.insert.bind(db);
      vi.spyOn(db, "insert").mockImplementation(((table: unknown) => {
        if (table === botRunEvents) return { values: persist };
        return insert(table as typeof botRuns);
      }) as typeof db.insert);
    }
    const run = await service.start(botId, { text: "hello" });
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledOnce());
    const [detail, message] = logger.error.mock.calls[0]!;
    expect(message).toBe("Bot Run background execution failed");
    expect(detail).toMatchObject({
      runId: run.id,
      error: {
        message: "database rejected [REDACTED] token=[REDACTED]",
        cause: { message: "upstream [REDACTED] Authorization: [REDACTED]" },
        params: ["[REDACTED]", { apiKey: "[REDACTED]" }],
        code: "08006",
      },
    });
    expect(JSON.stringify(detail)).not.toContain("test-secret");
    expect(JSON.stringify(detail)).not.toContain("synthetic-token");
    expect(JSON.stringify(detail)).not.toContain("nested-token");
    expect(JSON.stringify(detail)).not.toContain("parameter-key");
    expect(persist).toHaveBeenCalledTimes(2);
    expect(stream).toHaveBeenCalledTimes(stage === "finish" ? 1 : 0);
  },
);
