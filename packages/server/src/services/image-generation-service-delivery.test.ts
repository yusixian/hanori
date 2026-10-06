import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { getDataDir } from "@cos-tool-bot/shared";
import type { Database } from "@cos-tool-bot/database";
import { ImageDeliveryError } from "@cos-tool-bot/shared";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageGenerationService } from "./image-generation-service.js";
import {
  applyGenerationMutation,
  ACTOR,
  createDependencies,
  generationRow,
  query,
} from "./image-generation-service-test-fakes.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(overrides: Record<string, unknown> = {}) {
  const row = generationRow({
    state: "succeeded",
    providerMetadata: { deliveryState: "pending" },
    localFiles: ["saved.png"],
    requestSnapshot: {
      requestContext: { messageId: 7, threadId: 73, traceId: "trace-1", toolCallId: "call-1" },
    },
    ...overrides,
  });
  const deps = createDependencies();
  const deliver = vi.fn().mockResolvedValue([123]);
  const events: Record<string, unknown>[] = [];
  let failReceiptWrite = false;
  const db = {
    select: vi.fn((projection?: Record<string, unknown>) =>
      projection && "id" in projection ? query([{ id: row.id }]) : query([structuredClone(row)]),
    ),
    insert: vi.fn(() => ({
      values: async (value: Record<string, unknown>) => {
        events.push(value);
      },
    })),
    update: vi.fn(() => ({
      set: (values: Record<string, unknown>) => ({
        where: (condition: SQL) => {
          const statement = new PgDialect().sqlToQuery(condition);
          const sql = statement.sql;
          // Model the atomic claim predicates, including the two-worker race.
          const refused =
            ((sql.includes('"state" in') || sql.includes('"state" =')) &&
              !statement.params.includes(row.state)) ||
            (sql.includes("not in ('requested', 'unknown')") &&
              ["requested", "unknown"].includes(
                String(row.providerMetadata?.["cancellationState"]),
              )) ||
            (sql.includes("->>'cancelAttempted' = 'false'") &&
              row.providerMetadata?.["cancelAttempted"] !== false) ||
            (sql.includes("->>'cancelAttempted' is distinct from 'false'") &&
              row.providerMetadata?.["cancelAttempted"] === false) ||
            (sql.includes('"delivery_claimed_at" is null') && !!row.deliveryClaimedAt) ||
            (sql.includes('"delivered_at" is null') && !!row.deliveredAt) ||
            (sql.includes("not in ('unknown', 'delivered')") &&
              ["unknown", "delivered"].includes(
                String((row.providerMetadata as Record<string, unknown> | null)?.deliveryState),
              ));
          const result = (async () => {
            if (failReceiptWrite && values.deliveredAt)
              throw new Error("synthetic receipt persistence failed");
            if (!refused) applyGenerationMutation(row, values);
            return undefined;
          })() as Promise<void> & { returning: () => Promise<unknown[]> };
          result.returning = async () => {
            await result;
            return refused ? [] : [{ id: row.id, botId: row.botId }];
          };
          return result;
        },
      }),
    })),
  } as unknown as Database;
  const options = { ...deps, db, delivery: { deliver } } as unknown as ConstructorParameters<
    typeof ImageGenerationService
  >[0];
  const service = new ImageGenerationService(options);
  const deliverRow = (target = service) =>
    (
      target as unknown as {
        deliverCompleted: (row: unknown) => Promise<void>;
      }
    ).deliverCompleted(structuredClone(row));
  return {
    row,
    deps,
    db,
    deliver,
    service,
    options,
    events,
    deliverRow,
    failReceipt: () => {
      failReceiptWrite = true;
    },
  };
}

describe("image delivery provenance and safe recovery", () => {
  it("persists real receipts with the original topic and never repeats a delivered image", async () => {
    const { row, deliver, deliverRow, service, events } = setup();
    await deliverRow();
    await deliverRow();
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ generationId: row.id, chatId: -100, threadId: 73 }),
    );
    await expect(service.get(ACTOR, row.id)).resolves.toMatchObject({
      state: "succeeded",
      deliveryState: "delivered",
      deliveryMessageIds: [123],
      providerOperationId: "operation-1",
      requestContext: { messageId: 7, threadId: 73, traceId: "trace-1", toolCallId: "call-1" },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "delivered",
        metadata: expect.objectContaining({ deliveryMessageIds: [123], threadId: 73 }),
      }),
    );
  });

  it("does not resend an ambiguous failure on restart, after the claim expires, or across workers", async () => {
    const { row, deliver, deliverRow, options, service } = setup();
    deliver.mockRejectedValueOnce(new Error("connection lost after Telegram accepted the photo"));
    await deliverRow();
    expect(row.deliveryClaimedAt).not.toBeNull();
    await expect(service.get(ACTOR, row.id)).resolves.toMatchObject({
      state: "succeeded",
      deliveryState: "unknown",
      deliveryMessageIds: [],
    });
    await vi.advanceTimersByTimeAsync(16 * 60 * 1000);
    await new ImageGenerationService(options).recoverPending();
    await deliverRow();
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("treats legacy undelivered rows without attempt evidence as unknown even when diagnostics are empty", async () => {
    const { row, service, deliver, deliverRow } = setup({ providerMetadata: null });
    await expect(service.get(ACTOR, row.id)).resolves.toMatchObject({ deliveryState: "unknown" });
    await deliverRow();
    expect(deliver).not.toHaveBeenCalled();
    await expect(service.retryDelivery(ACTOR, row.id)).resolves.toMatchObject({
      ok: false,
      reason: "delivery_unknown",
    });
  });

  it("marks an interrupted send unknown when its claim expires instead of reacquiring it", async () => {
    const { row, deliver, deliverRow, service } = setup({
      deliveryClaimedAt: new Date(Date.now() - 16 * 60 * 1000),
    });
    await deliverRow();
    expect(deliver).not.toHaveBeenCalled();
    await expect(service.get(ACTOR, row.id)).resolves.toMatchObject({
      deliveryState: "unknown",
      deliveryErrorCode: "RECEIPT_MISSING",
    });
  });

  it("never resends a successful upload whose receipt could not be saved", async () => {
    const { deliver, deliverRow, failReceipt, options } = setup();
    failReceipt();
    await expect(deliverRow()).rejects.toThrow("receipt persistence failed");
    await vi.advanceTimersByTimeAsync(16 * 60 * 1000);
    await new ImageGenerationService(options).recoverPending();
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("retries only a positively unsent failure and persists the resulting receipt", async () => {
    const { row, deliver, deliverRow, service } = setup();
    deliver.mockRejectedValueOnce(new ImageDeliveryError("not_sent", "TELEGRAM_429", 2));
    await deliverRow();
    await expect(service.get(ACTOR, row.id)).resolves.toMatchObject({
      deliveryState: "failed",
      deliveryErrorCode: "TELEGRAM_429",
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(deliver).toHaveBeenCalledTimes(2);
    await expect(service.get(ACTOR, row.id)).resolves.toMatchObject({
      deliveryState: "delivered",
      deliveryMessageIds: [123],
    });
  });

  it("allows explicit delivery retry only after a proven unsent failure and preserves provider identity", async () => {
    const { row, service, deliver, deliverRow, deps } = setup();
    await expect(service.retryDelivery(ACTOR, row.id)).resolves.toMatchObject({
      ok: false,
      reason: "not_ready",
    });
    deliver.mockRejectedValueOnce(new ImageDeliveryError("not_sent", "TELEGRAM_400"));
    await deliverRow();
    await expect(service.retryDelivery({ ...ACTOR, botId: "other" }, row.id)).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
    await expect(service.retryDelivery(ACTOR, row.id)).resolves.toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deps.pixai.startGeneration).not.toHaveBeenCalled();
    await expect(service.retryDelivery(ACTOR, row.id)).resolves.toMatchObject({
      ok: false,
      reason: "already_delivered",
    });
  });

  it("does not accept empty or malformed receipts as delivery evidence", async () => {
    const { row, deliver, deliverRow, service } = setup();
    deliver.mockResolvedValue([]);
    await deliverRow();
    await expect(service.get(ACTOR, row.id)).resolves.toMatchObject({
      deliveryState: "unknown",
      deliveryErrorCode: "INVALID_TELEGRAM_RECEIPT",
    });
    expect(row.deliveredAt).toBeNull();
  });

  it("lets only one worker send after both read the same unclaimed generation", async () => {
    const { deliver, deliverRow, options } = setup();
    let finish!: (ids: number[]) => void;
    deliver.mockImplementationOnce(
      () =>
        new Promise<number[]>((resolve) => {
          finish = resolve;
        }),
    );
    const first = deliverRow();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
    await deliverRow(new ImageGenerationService(options));
    finish([123]);
    await first;
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("keeps cancellation refusal separate and resumes polling the original task", async () => {
    const { row, service, deps, deliver } = setup({ state: "running", localFiles: [] });
    const cancelGeneration = vi
      .fn()
      .mockResolvedValue({ operationId: "operation-1", state: "cancel_rejected" });
    Object.assign(deps.pixai, { cancelGeneration });
    deps.pixai.waitForGeneration.mockResolvedValue({
      operationId: "operation-1",
      state: "running",
    });
    await expect(service.cancel(ACTOR, row.id)).resolves.toMatchObject({
      ok: false,
      generation: { state: "running", cancellationState: "rejected" },
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.pixai.waitForGeneration).toHaveBeenCalledWith("operation-1", 10_000);
    expect(deps.pixai.startGeneration).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(deps.usageGovernor.refund).not.toHaveBeenCalled();
  });

  it("continues to generate and deliver after cancellation is rejected without losing concurrent metadata", async () => {
    const { row, service, deps, deliver } = setup({
      id: randomUUID(),
      botId: randomUUID(),
      state: "running",
      localFiles: [],
    });
    const actor = { ...ACTOR, botId: row.botId };
    Object.assign(deps.pixai, {
      cancelGeneration: vi
        .fn()
        .mockResolvedValue({ operationId: "operation-1", state: "cancel_rejected" }),
      getGenerationResult: vi
        .fn()
        .mockResolvedValue({ images: [{ data: "synthetic" }], resourceLinks: [] }),
    });
    deps.pixai.waitForGeneration.mockResolvedValue({
      operationId: "operation-1",
      state: "succeeded",
    });
    deps.artifacts.readInline.mockReturnValue({
      bytes: Uint8Array.from([1, 2, 3]),
      mimeType: "image/png",
      source: "inline",
    });
    try {
      await expect(service.cancel(actor, row.id)).resolves.toMatchObject({ ok: false });
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(row.deliveredAt).not.toBeNull());
      await expect(service.get(actor, row.id)).resolves.toMatchObject({
        state: "succeeded",
        deliveryState: "delivered",
        cancellationState: "rejected",
        deliveryMessageIds: [123],
      });
      expect(deliver).toHaveBeenCalledOnce();
      expect(deps.pixai.startGeneration).not.toHaveBeenCalled();
      expect(deps.usageGovernor.refund).not.toHaveBeenCalled();
    } finally {
      await rm(getDataDir(row.botId), { recursive: true, force: true });
    }
  });

  it("preserves the original task after an ambiguous cancellation RPC error", async () => {
    const { row, service, deps } = setup({ state: "queued", localFiles: [] });
    Object.assign(deps.pixai, {
      cancelGeneration: vi.fn(async () => {
        expect(row.providerMetadata).toMatchObject({ cancelAttempted: true });
        throw new Error("lost cancel response");
      }),
    });
    deps.pixai.waitForGeneration.mockResolvedValue({ operationId: "operation-1", state: "queued" });
    await expect(service.cancel(ACTOR, row.id)).resolves.toMatchObject({
      ok: false,
      reason: "provider_error",
      generation: { state: "queued", cancellationState: "unknown" },
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.pixai.waitForGeneration).toHaveBeenCalledOnce();
    await expect(service.cancel(ACTOR, row.id)).resolves.toMatchObject({
      ok: false,
      reason: "provider_error",
      generation: { cancellationState: "unknown" },
    });
    expect(
      (deps.pixai as unknown as { cancelGeneration: ReturnType<typeof vi.fn> }).cancelGeneration,
    ).toHaveBeenCalledOnce();
    expect(deps.usageGovernor.refund).not.toHaveBeenCalled();
  });

  it.each([true, undefined])(
    "only observes the original task after interrupted cancellation with attempt marker %s",
    async (cancelAttempted) => {
      const { row, options, deps } = setup({
        state: "cancel_requested",
        localFiles: [],
        providerMetadata: {
          cancelRequested: true,
          cancelAttempted,
          cancellationState: "requested",
          cancellationPreviousState: "queued",
        },
      });
      const cancel = vi.fn();
      Object.assign(deps.pixai, { cancelGeneration: cancel });
      deps.pixai.waitForGeneration.mockResolvedValue({
        operationId: "operation-1",
        state: "queued",
      });
      const restarted = new ImageGenerationService(options);
      await restarted.recoverPending();
      await vi.advanceTimersByTimeAsync(1);
      await expect(restarted.get(ACTOR, row.id)).resolves.toMatchObject({
        state: "queued",
        cancellationState: "unknown",
      });
      expect(cancel).not.toHaveBeenCalled();
      expect(deps.pixai.waitForGeneration).toHaveBeenCalledWith("operation-1", 10_000);
      expect(deps.pixai.startGeneration).not.toHaveBeenCalled();
      expect(deps.usageGovernor.refund).not.toHaveBeenCalled();
    },
  );

  it("claims a deferred cancellation only once across concurrent recovery instances", async () => {
    const { row, service, options, deps } = setup({
      state: "cancel_requested",
      localFiles: [],
      providerMetadata: {
        cancelRequested: true,
        cancelAttempted: false,
        cancellationState: "requested",
        cancellationPreviousState: "queued",
      },
    });
    let finish!: (value: { operationId: string; state: string }) => void;
    const cancel = vi.fn(() => {
      expect(row.providerMetadata).toMatchObject({ cancelAttempted: true });
      return new Promise<{ operationId: string; state: string }>((resolve) => {
        finish = resolve;
      });
    });
    Object.assign(deps.pixai, { cancelGeneration: cancel });
    deps.pixai.waitForGeneration.mockResolvedValue({ operationId: "operation-1", state: "queued" });
    const other = new ImageGenerationService(options);
    const first = service.recoverPending();
    const second = other.recoverPending();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    finish({ operationId: "operation-1", state: "running" });
    await Promise.all([first, second]);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(cancel).toHaveBeenCalledOnce();
    expect(deps.pixai.startGeneration).not.toHaveBeenCalled();
    expect(deps.usageGovernor.refund).not.toHaveBeenCalled();
  });

  it("keeps an accepted cancellation under observation until confirmation", async () => {
    const { row, service, deps } = setup({ state: "running", localFiles: [] });
    Object.assign(deps.pixai, {
      cancelGeneration: vi.fn().mockResolvedValue({ operationId: "operation-1", state: "running" }),
    });
    deps.pixai.waitForGeneration.mockResolvedValue({
      operationId: "operation-1",
      state: "cancelled",
    });
    await expect(service.cancel(ACTOR, row.id)).resolves.toMatchObject({
      ok: true,
      generation: { state: "running", cancellationState: "requested" },
    });
    await vi.advanceTimersByTimeAsync(1);
    await expect(service.get(ACTOR, row.id)).resolves.toMatchObject({
      state: "cancelled",
      cancellationState: "confirmed",
    });
    expect(deps.usageGovernor.refund).toHaveBeenCalledOnce();
  });

  it("denies unrelated actors and returns a bounded task view without prompts, files or provider metadata", async () => {
    const { row, service } = setup({
      prompt: "private prompt",
      artifacts: [
        { ordinal: 0, mimeType: "image/png", filename: "private.png", sha256: "private hash" },
      ],
      providerMetadata: { token: "private token" },
    });
    await expect(service.get({ ...ACTOR, botId: "other" }, row.id)).resolves.toBeNull();
    await expect(
      service.get({ ...ACTOR, isBotAdmin: false, userId: 99 }, row.id),
    ).resolves.toBeNull();
    const view = await service.get(ACTOR, row.id);
    expect(JSON.stringify(view)).not.toContain("private");
  });

  it("deduplicates the same host request after restart without reserving or submitting again", async () => {
    const { row, service, deps } = setup({ state: "queued" });
    await expect(
      service.create(
        { ...ACTOR, requestContext: { messageId: 7, threadId: 73 } },
        {
          purpose: "anime_illustration",
          prompt: "cat",
          toolCallId: "call-1",
        },
      ),
    ).resolves.toMatchObject({ accepted: true, generation: { id: row.id, state: "queued" } });
    const selection = vi.mocked((service as unknown as { db: Database }).db.select).mock.results[0]!
      .value as unknown as { where: ReturnType<typeof vi.fn> };
    const condition = new PgDialect().sqlToQuery(selection.where.mock.calls[0]![0] as SQL);
    expect(condition.params[0]).toBe(ACTOR.botId);
    expect(condition.params[1]).toMatch(/^cos-tool-bot:[a-z0-9-]+:[a-f0-9]{64}$/);
    expect(deps.usageGovernor.reserve).not.toHaveBeenCalled();
    expect(deps.pixai.startGeneration).not.toHaveBeenCalled();
  });
  it("deduplicates identical requests across different tool call ids without equating distinct prompts", async () => {
    const { row, service, db, deps } = setup({ state: "attention_required" });
    const actor = { ...ACTOR, requestContext: { messageId: 7 } };
    for (const [toolCallId, prompt] of [
      ["call-1", "cat"],
      ["call-2", "cat"],
      ["call-3", "dog"],
    ]) {
      await expect(
        service.create(actor, { purpose: "anime_illustration", prompt: prompt!, toolCallId }),
      ).resolves.toMatchObject({ generation: { id: row.id } });
    }
    const keys = vi.mocked(db.select).mock.results.map((result) => {
      const selection = result.value as unknown as { where: ReturnType<typeof vi.fn> };
      return new PgDialect().sqlToQuery(selection.where.mock.calls[0]![0]).params[1];
    });
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).not.toBe(keys[2]);
    expect(deps.pixai.startGeneration).not.toHaveBeenCalled();
  });
});
