import { pixaiGenerations } from "@cos-tool-bot/database";
import type { PixAIGenerationRecord } from "@cos-tool-bot/shared";
import { and, eq } from "drizzle-orm";
import {
  confirmPendingInsertAbsent,
  persistTerminalGenerationClaim,
} from "../generation-recovery.js";
import { cleanupGenerationImages, downloadGenerationImages } from "./generation-files.js";
import type { BotRuntimeServices } from "./types.js";

type GenerationTrackingServices = Readonly<
  Pick<BotRuntimeServices, "db" | "logger" | "generationInsertFallbacks">
>;

export function createGenerationTracker(botId: string, services: GenerationTrackingServices) {
  const { db, logger, generationInsertFallbacks } = services;
  return async (record: PixAIGenerationRecord) => {
    try {
      if (record.status === "pending") {
        try {
          await db.insert(pixaiGenerations).values({
            botId,
            chatId: record.chatId,
            userId: record.userId,
            taskId: record.taskId,
            prompt: record.prompt,
            negativePrompt: record.negativePrompt,
            modelId: record.modelId,
            width: record.width,
            height: record.height,
            batchSize: record.batchSize,
            samplingSteps: record.samplingSteps,
            cfgScale: record.cfgScale,
            promptHelper: record.promptHelper,
            pixaiConfig: record.pixaiConfig,
            status: record.status,
          });
          generationInsertFallbacks.clear(botId, record.taskId);
        } catch (err) {
          try {
            const confirmedAbsent = await confirmPendingInsertAbsent(async () => {
              const [existing] = await db
                .select({ id: pixaiGenerations.id })
                .from(pixaiGenerations)
                .where(
                  and(
                    eq(pixaiGenerations.botId, botId),
                    eq(pixaiGenerations.taskId, record.taskId),
                  ),
                );
              return existing;
            });
            if (confirmedAbsent) {
              generationInsertFallbacks.markPendingInsertFailure(botId, record.taskId);
            } else {
              generationInsertFallbacks.clear(botId, record.taskId);
            }
          } catch {
            // The insert and verification both had transient failures. Keep a
            // bounded marker so terminal persistence can safely re-check later.
            generationInsertFallbacks.markPendingInsertFailure(botId, record.taskId);
          }
          throw err;
        }
      } else {
        await persistTerminalGeneration(botId, record, services);
      }
    } catch (err) {
      logger.error(err, "Failed to write PixAI generation record");
      throw err;
    }
  };
}

async function persistTerminalGeneration(
  botId: string,
  record: PixAIGenerationRecord,
  { db, logger, generationInsertFallbacks }: GenerationTrackingServices,
): Promise<void> {
  const completedAt = new Date();
  let claimedGenerationId: number | undefined;
  await persistTerminalGenerationClaim(
    record.taskId,
    async () => {
      const [updated] = await db
        .update(pixaiGenerations)
        .set({
          status: record.status,
          mediaUrls: record.mediaUrls,
          mediaIds: record.mediaIds,
          nsfwScores: record.nsfwScores,
          errorMessage: record.errorMessage,
          durationMs: record.durationMs,
          completedAt,
        })
        .where(
          and(
            eq(pixaiGenerations.botId, botId),
            eq(pixaiGenerations.taskId, record.taskId),
            eq(pixaiGenerations.status, "pending"),
          ),
        )
        .returning({ id: pixaiGenerations.id });

      if (!updated) return false;
      claimedGenerationId = updated.id;
      generationInsertFallbacks.clear(botId, record.taskId);
      return true;
    },
    () =>
      generationInsertFallbacks.insertIfClaimed(
        botId,
        record.taskId,
        async () => {
          const [existing] = await db
            .select({ id: pixaiGenerations.id })
            .from(pixaiGenerations)
            .where(
              and(eq(pixaiGenerations.botId, botId), eq(pixaiGenerations.taskId, record.taskId)),
            );
          return existing === undefined;
        },
        async () => {
          const [inserted] = await db
            .insert(pixaiGenerations)
            .values({
              botId,
              chatId: record.chatId,
              userId: record.userId,
              taskId: record.taskId,
              prompt: record.prompt,
              negativePrompt: record.negativePrompt,
              modelId: record.modelId,
              width: record.width,
              height: record.height,
              batchSize: record.batchSize,
              samplingSteps: record.samplingSteps,
              cfgScale: record.cfgScale,
              promptHelper: record.promptHelper,
              pixaiConfig: record.pixaiConfig,
              status: record.status,
              mediaUrls: record.mediaUrls,
              mediaIds: record.mediaIds,
              nsfwScores: record.nsfwScores,
              errorMessage: record.errorMessage,
              durationMs: record.durationMs,
              completedAt,
            })
            .returning({ id: pixaiGenerations.id });
          if (!inserted) throw new Error(`Failed to insert PixAI generation ${record.taskId}`);
          claimedGenerationId = inserted.id;
        },
      ),
  );

  if (record.status !== "completed" || !record.mediaUrls?.length) return;
  if (claimedGenerationId === undefined) {
    throw new Error(`PixAI generation ${record.taskId} claim did not return an id`);
  }

  let localFiles: string[];
  try {
    localFiles = await downloadGenerationImages(botId, record.taskId, record.mediaUrls, logger);
  } catch (err) {
    logger.warn({ err, botId, taskId: record.taskId }, "PixAI image download failed");
    return;
  }
  if (localFiles.length === 0) return;

  try {
    const updated = await db
      .update(pixaiGenerations)
      .set({ localFiles })
      .where(eq(pixaiGenerations.id, claimedGenerationId))
      .returning({ id: pixaiGenerations.id });
    if (updated.length === 0) {
      await cleanupGenerationImages(botId, localFiles, logger);
    }
  } catch (err) {
    logger.warn(
      { err, botId, taskId: record.taskId },
      "Failed to persist PixAI local files; keeping files because commit outcome is unknown",
    );
  }
}
