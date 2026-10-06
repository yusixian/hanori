import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { NsfwChecker } from "@cos-tool-bot/bot";
import type { Database } from "@cos-tool-bot/database";
import { getDataDir, type ImageArtifact } from "@cos-tool-bot/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageGenerationService } from "./image-generation-service.js";
import {
  applyGenerationMutation,
  createDependencies,
  generationRow,
} from "./image-generation-service-test-fakes.js";

type TestGenerationRow = Omit<ReturnType<typeof generationRow>, "artifacts"> & {
  artifacts: ImageArtifact[];
};

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const checked = {
  status: "checked" as const,
  isNsfw: true,
  scores: { porn: 0.8, hentai: 0.1, sexy: 0, neutral: 0.1, drawing: 0 },
};

function setup() {
  const deps = createDependencies();
  const botId = randomUUID();
  directories.push(path.join(getDataDir(botId), "generations"));
  const row: TestGenerationRow = generationRow({ id: randomUUID(), botId, state: "running" });
  const writes: Record<string, unknown>[] = [];
  const db = {
    update: vi.fn(() => ({
      set: (value: Record<string, unknown>) => {
        writes.push(value);
        applyGenerationMutation(row, value);
        const result = Promise.resolve() as Promise<void> & { returning: () => Promise<unknown[]> };
        result.returning = async () => [{ id: row.id }];
        return { where: () => result };
      },
    })),
    insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
  } as unknown as Database;
  const nsfwChecker = {
    checkImageBytes: vi.fn().mockResolvedValue(checked),
  } as unknown as NsfwChecker;
  const options = { ...deps, db, nsfwChecker } as unknown as ConstructorParameters<
    typeof ImageGenerationService
  >[0];
  const service = new ImageGenerationService(options);
  const complete = (data: Array<{ bytes: Uint8Array; mimeType: string; source: "inline" }>) =>
    (
      service as unknown as {
        completeWithArtifacts: (generation: TestGenerationRow, data: unknown[]) => Promise<void>;
      }
    ).completeWithArtifacts(row, data);
  return { service, row, writes, nsfwChecker, options, complete };
}

describe("generation safety persistence and recovery", () => {
  it.each(["mcp_pixai", "general_backend"])(
    "saves real scores with %s artifacts before delivery",
    async (provider) => {
      const { row, writes, nsfwChecker, options } = setup();
      row.provider = provider;
      const delivery = {
        deliver: vi.fn(async () => {
          expect(
            writes.some(
              (value) => Array.isArray(value.artifacts) && value.artifacts[0].nsfw === checked,
            ),
          ).toBe(true);
          return [42];
        }),
      };
      const service = new ImageGenerationService({ ...options, delivery });
      const bytes = Uint8Array.from([1, 2, 3]);
      await (
        service as unknown as {
          completeWithArtifacts: (generation: TestGenerationRow, data: unknown[]) => Promise<void>;
        }
      ).completeWithArtifacts(row, [{ bytes, mimeType: "image/png", source: "inline" }]);
      expect(nsfwChecker.checkImageBytes).toHaveBeenCalledWith(bytes);
      expect(row.artifacts).toEqual([expect.objectContaining({ ordinal: 0, nsfw: checked })]);
      expect(delivery.deliver).toHaveBeenCalledOnce();
    },
  );
  it("retains unknown classification with no invented scores", async () => {
    const { row, nsfwChecker, complete } = setup();
    vi.mocked(nsfwChecker.checkImageBytes).mockResolvedValue({
      status: "failed",
      isNsfw: true,
      scores: null,
    });
    await complete([
      { bytes: Uint8Array.from([1, 2, 3]), mimeType: "image/png", source: "inline" },
    ]);
    expect(row.artifacts).toEqual([
      expect.objectContaining({ nsfw: { status: "failed", isNsfw: true, scores: null } }),
    ]);
    expect(row.state).toBe("succeeded");
  });
  it("checks an older undelivered artifact from disk before recovering delivery", async () => {
    const { row, nsfwChecker, options, complete } = setup();
    await complete([
      { bytes: Uint8Array.from([1, 2, 3]), mimeType: "image/png", source: "inline" },
    ]);
    row.artifacts = row.artifacts.map(({ nsfw: _nsfw, ...artifact }) => artifact);
    vi.mocked(nsfwChecker.checkImageBytes).mockClear();
    const deliver = vi.fn().mockResolvedValue([42]);
    const service = new ImageGenerationService({ ...options, delivery: { deliver } });
    await (
      service as unknown as { deliverCompleted: (generation: TestGenerationRow) => Promise<void> }
    ).deliverCompleted(row);
    expect(nsfwChecker.checkImageBytes).toHaveBeenCalledWith(Buffer.from([1, 2, 3]));
    expect(row.artifacts).toEqual([expect.objectContaining({ nsfw: checked })]);
    expect(deliver).toHaveBeenCalledOnce();
  });
});
