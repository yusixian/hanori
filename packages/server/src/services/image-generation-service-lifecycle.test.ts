import * as fs from "node:fs/promises";
import type { Database } from "@cos-tool-bot/database";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DEFAULT_IMAGE_GOVERNANCE_CONFIG,
  ImageGenerationService,
} from "./image-generation-service.js";
import {
  ACTOR,
  applyGenerationMutation,
  createDependencies,
  generationRow,
  query,
} from "./image-generation-service-test-fakes.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  unlink: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(snapshotFailure?: "read" | "write") {
  const deps = createDependencies();
  const row = generationRow({
    state: "preparing",
    providerOperationId: null,
    providerMetadata: { planId: "plan-1" },
  });
  const db = {
    select: vi.fn((projection?: Record<string, unknown>) => {
      if (snapshotFailure === "read" && row.providerOperationId)
        throw new Error("snapshot read failed");
      return projection ? query([{ id: row.id }]) : query([row]);
    }),
    insert: vi.fn(() => ({ values: vi.fn(async () => {}) })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(() => {
          if (snapshotFailure === "write" && "requestSnapshot" in values)
            return Promise.reject(new Error("snapshot write failed"));
          applyGenerationMutation(row, values);
          return Object.assign(Promise.resolve([]), { returning: async () => [] });
        }),
      })),
    })),
  };
  const service = new ImageGenerationService({
    db: db as unknown as Database,
    ...deps,
  } as unknown as ConstructorParameters<typeof ImageGenerationService>[0]);
  return { service, deps, row, db };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("waits for an admitted provider start and its late snapshot before closing", async () => {
  const { service, deps, row } = fixture();
  const start = deferred<{ operationId: string; state: string }>();
  const details = deferred<unknown>();
  deps.pixai.startGeneration.mockReturnValue(start.promise);
  deps.pixai.getGenerationDetails.mockReturnValue(details.promise);
  const recovery = service.recoverPending();
  await vi.waitFor(() => expect(deps.pixai.startGeneration).toHaveBeenCalledOnce());
  let closed = false;
  const close = service.close();
  expect(service.close()).toBe(close);
  void close.then(() => {
    closed = true;
  });
  start.resolve({ operationId: "accepted-operation", state: "queued" });
  await recovery;
  expect(closed).toBe(false);
  expect(row.providerOperationId).toBe("accepted-operation");
  details.resolve({ width: 1024 });
  await close;
  expect(row).toMatchObject({ requestSnapshot: { width: 1024 } });
  expect(deps.usageGovernor.refund).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("clears future retries and rejects new executions after close without database work", async () => {
  const { service, deps, db, row } = fixture();
  deps.pixai.startGeneration.mockRejectedValue(new Error("connection lost"));
  await service.recoverPending();
  expect(vi.getTimerCount()).toBe(1);
  await service.close();
  const reads = db.select.mock.calls.length;
  await expect(service.recoverPending()).rejects.toThrow("service is closing");
  await expect(
    service.create(ACTOR, { purpose: "anime_illustration", prompt: "draw" }),
  ).rejects.toThrow("service is closing");
  await expect(service.cancel(ACTOR, row.id)).rejects.toThrow("service is closing");
  await expect(service.retryDelivery(ACTOR, row.id)).rejects.toThrow("service is closing");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(db.select).toHaveBeenCalledTimes(reads);
  expect(deps.pixai.startGeneration).toHaveBeenCalledOnce();
  expect(deps.usageGovernor.refund).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["read", "write"] as const)(
  "contains a detached snapshot %s failure and drains it",
  async (failure) => {
    const { service, deps, row } = fixture(failure);
    deps.pixai.startGeneration.mockResolvedValue({
      operationId: "accepted-operation",
      state: "queued",
    });
    deps.pixai.getGenerationDetails.mockResolvedValue({ width: 1024 });
    await service.recoverPending();
    await service.close();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      { generationId: row.id, task: "snapshot" },
      "Image background task failed",
    );
    expect(row.providerOperationId).toBe("accepted-operation");
    expect(deps.usageGovernor.refund).not.toHaveBeenCalled();
  },
);

it("drains an admitted admin snapshot lookup through its database write", async () => {
  const { service, deps, row } = fixture();
  row.providerOperationId = "existing-operation";
  const details = deferred<unknown>();
  deps.pixai.getGenerationDetails.mockReturnValue(details.promise);
  const lookup = service.getAdminRequestSnapshot(row.botId, row.id);
  await vi.waitFor(() => expect(deps.pixai.getGenerationDetails).toHaveBeenCalledOnce());
  let closed = false;
  const close = service.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  details.resolve({ width: 768 });
  await expect(lookup).resolves.toMatchObject({ width: 768 });
  await close;
  expect(row).toMatchObject({ requestSnapshot: { width: 768 } });
  await expect(service.getAdminRequestSnapshot(row.botId, row.id)).rejects.toThrow(
    "service is closing",
  );
  await expect(service.listRoutes(ACTOR)).rejects.toThrow("service is closing");
  await expect(service.listPresets(ACTOR)).rejects.toThrow("service is closing");
  await expect(service.findByDeliveryMessage(ACTOR, 42)).rejects.toThrow("service is closing");
});

it("drains an admitted general request without treating shutdown as provider cancellation", async () => {
  const deps = createDependencies();
  const config = structuredClone(DEFAULT_IMAGE_GOVERNANCE_CONFIG);
  config.generalRouteMode = "semantic_auto";
  const route = config.routes.find((item) => item.purpose === "general_image")!;
  route.enabled = true;
  delete route.defaultBackendId;
  const row = generationRow({
    provider: "general_backend",
    purpose: "general_image",
    state: "preparing",
    providerOperationId: null,
  });
  const response = deferred<void>();
  const generalBackend = {
    isConfigured: async () => true,
    create: vi.fn(async (_input: { signal?: AbortSignal }) => {
      await response.promise;
      throw new Error("provider disconnected");
    }),
  };
  const db = {
    select: (projection?: Record<string, unknown>) =>
      projection && "config" in projection ? query([{ config }]) : query([row]),
    insert: () => ({
      values: async (values: Record<string, unknown>) => {
        if (values.provider) Object.assign(row, values);
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          applyGenerationMutation(row, values);
          return Object.assign(Promise.resolve([row]), { returning: async () => [row] });
        },
      }),
    }),
  };
  const service = new ImageGenerationService({
    db,
    ...deps,
    generalBackend,
  } as unknown as ConstructorParameters<typeof ImageGenerationService>[0]);
  await expect(
    service.create(ACTOR, { purpose: "general_image", prompt: "draw", routingIntent: "explicit" }),
  ).resolves.toMatchObject({ accepted: true });
  await vi.waitFor(() => expect(generalBackend.create).toHaveBeenCalledOnce());
  let closed = false;
  const close = service.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(generalBackend.create.mock.calls[0]![0].signal?.aborted).toBe(false);
  response.resolve();
  await close;
  expect(row).toMatchObject({
    state: "attention_required",
    errorCode: "GENERAL_BACKEND_RESULT_UNKNOWN",
  });
  expect(deps.usageGovernor.refund).not.toHaveBeenCalled();
  expect(generalBackend.create).toHaveBeenCalledOnce();
});

it("drains an admitted admin deletion and rejects new deletions after close", async () => {
  const { service, db, row } = fixture();
  row.state = "succeeded";
  const selected = query([row]);
  const lookup = deferred<(typeof row)[]>();
  selected.limit.mockReturnValue(lookup.promise);
  db.select.mockReturnValueOnce(selected);
  const deletion = deferred<{ id: string; localFiles: string[] }[]>();
  const returning = vi.fn(() => deletion.promise);
  const deleteRow = vi.fn(() => ({ where: vi.fn(() => ({ returning })) }));
  Object.assign(db, { delete: deleteRow });
  const operation = service.deleteAdminGeneration(row.botId, row.id);
  let closed = false;
  const close = service.close().then(() => {
    closed = true;
  });
  try {
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(false);
    lookup.resolve([row]);
    await vi.waitFor(() => expect(returning).toHaveBeenCalledOnce());
    expect(closed).toBe(false);
    deletion.resolve([{ id: row.id, localFiles: [] }]);
    await expect(operation).resolves.toBe("deleted");
    await close;
    const reads = db.select.mock.calls.length;
    await expect(service.deleteAdminGeneration(row.botId, row.id)).rejects.toThrow(
      "service is closing",
    );
    expect(db.select).toHaveBeenCalledTimes(reads);
    expect(deleteRow).toHaveBeenCalledOnce();
  } finally {
    lookup.resolve([row]);
    deletion.resolve([{ id: row.id, localFiles: [] }]);
    await Promise.allSettled([operation, close]);
  }
});

it("drains admitted generation file cleanup even when unlink fails", async () => {
  const { service, db, row } = fixture();
  row.state = "succeeded";
  Object.assign(db, {
    delete: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(async () => [{ id: row.id, localFiles: ["result.png"] }]),
      })),
    })),
  });
  const cleanup = deferred<void>();
  const unlink = vi.mocked(fs.unlink).mockImplementation(async () => {
    await cleanup.promise;
    throw new Error("synthetic unlink failure");
  });
  const operation = service.deleteAdminGeneration(row.botId, row.id);
  let close: Promise<void> | undefined;
  try {
    await vi.waitFor(() => expect(unlink).toHaveBeenCalledOnce());
    let closed = false;
    close = service.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(false);
    cleanup.resolve();
    await expect(operation).resolves.toBe("deleted");
    await close;
    expect(closed).toBe(true);
  } finally {
    cleanup.resolve();
    await Promise.allSettled([operation, close]);
    unlink.mockReset();
  }
});
