import type { Database } from "@cos-tool-bot/database";
import { bots, miniAppAuditEvents } from "@cos-tool-bot/database";
import type { AiConfigStored } from "@cos-tool-bot/shared";
import { eq } from "drizzle-orm";
import { migrateAiConfig } from "../utils/ai-config-migrate.js";
import type { BotLifecycleActor, BotLifecycleService } from "./bot-lifecycle-service.js";

export type BotSettingsErrorCode =
  | "invalid_actor"
  | "not_found"
  | "ai_not_configured"
  | "stale_revision"
  | "persistence_failed";

const SAFE_MESSAGES: Readonly<Record<BotSettingsErrorCode, string>> = {
  invalid_actor: "A valid administrator is required",
  not_found: "Bot was not found",
  ai_not_configured: "AI is not configured",
  stale_revision: "Bot settings changed since they were loaded",
  persistence_failed: "Bot settings could not be persisted",
};

export class BotSettingsError extends Error {
  constructor(readonly code: BotSettingsErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = "BotSettingsError";
  }
}

export interface BotSettingsProjection {
  revision: string;
  ai: {
    enabled: boolean;
    systemPrompt: string;
  };
}

function revision(updatedAt: Date | null): string {
  return updatedAt?.toISOString() ?? "0";
}

function nextUpdatedAt(now: Date, previous: Date | null): Date {
  return new Date(Math.max(now.getTime(), (previous?.getTime() ?? 0) + 1));
}

function validateActor(actor: BotLifecycleActor): BotLifecycleActor {
  const id = actor.id.trim();
  if (
    !id ||
    id.length > 128 ||
    (actor.kind === "telegram_user" &&
      (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))))
  ) {
    throw new BotSettingsError("invalid_actor");
  }
  return { ...actor, id };
}

export class BotSettingsService {
  constructor(
    private readonly db: Database,
    private readonly lifecycle: Pick<BotLifecycleService, "read" | "restart">,
    private readonly withBotLock: <T>(botId: string, operation: () => Promise<T>) => Promise<T>,
    private readonly now = () => new Date(),
  ) {}

  async read(botId: string): Promise<BotSettingsProjection> {
    const [bot] = await this.persist(() =>
      this.db
        .select({ aiConfig: bots.aiConfig, updatedAt: bots.updatedAt })
        .from(bots)
        .where(eq(bots.id, botId)),
    );
    if (!bot) throw new BotSettingsError("not_found");
    if (!bot.aiConfig) throw new BotSettingsError("ai_not_configured");
    return this.project(bot.aiConfig, bot.updatedAt);
  }

  patch(input: {
    botId: string;
    expectedRevision: string;
    patch: { enabled?: boolean; systemPrompt?: string };
    actor: BotLifecycleActor;
  }) {
    const actor = validateActor(input.actor);
    return this.patchLocked(input, actor);
  }

  private async patchLocked(
    input: {
      botId: string;
      expectedRevision: string;
      patch: { enabled?: boolean; systemPrompt?: string };
    },
    actor: BotLifecycleActor,
  ) {
    const settings = await this.withBotLock(input.botId, async () => {
      await this.persist(() =>
        this.db.transaction(async (tx) => {
          const [bot] = await tx
            .select({ aiConfig: bots.aiConfig, updatedAt: bots.updatedAt })
            .from(bots)
            .where(eq(bots.id, input.botId))
            .for("update");
          if (!bot) throw new BotSettingsError("not_found");
          if (!bot.aiConfig) throw new BotSettingsError("ai_not_configured");
          if (revision(bot.updatedAt) !== input.expectedRevision) {
            throw new BotSettingsError("stale_revision");
          }

          const current = migrateAiConfig(bot.aiConfig);
          const changedAt = nextUpdatedAt(this.now(), bot.updatedAt);
          const next: AiConfigStored = {
            ...current,
            ...(input.patch.enabled === undefined ? {} : { enabled: input.patch.enabled }),
            ...(input.patch.systemPrompt === undefined
              ? {}
              : { systemPrompt: input.patch.systemPrompt }),
          };
          await tx
            .update(bots)
            .set({ aiConfig: next, updatedAt: changedAt })
            .where(eq(bots.id, input.botId));
          await tx.insert(miniAppAuditEvents).values({
            botId: input.botId,
            actorTelegramUserId: actor.kind === "telegram_user" ? Number(actor.id) : null,
            actorRole: "admin",
            capability: "bot.settings.write",
            action: "bot.settings.updated",
            resourceType: "bot",
            resourceId: input.botId,
            previousSummary: {
              revision: input.expectedRevision,
              aiEnabled: current.enabled,
            },
            nextSummary: {
              revision: revision(changedAt),
              aiEnabled: next.enabled,
              systemPromptChanged:
                input.patch.systemPrompt !== undefined &&
                input.patch.systemPrompt !== current.systemPrompt,
              actorKind: actor.kind,
              actorId: actor.id,
            },
            outcome: "succeeded",
            createdAt: changedAt,
          });
        }),
      );
      return this.read(input.botId);
    });

    let applied = true;
    let applyErrorCode: "restart_failed" | undefined;
    try {
      const lifecycle = await this.lifecycle.read(input.botId);
      if (lifecycle.desiredActive) {
        const result = await this.lifecycle.restart({ botId: input.botId, actor });
        applied = result.applied;
        if (!result.applied) applyErrorCode = "restart_failed";
      }
    } catch {
      applied = false;
      applyErrorCode = "restart_failed";
    }

    return {
      persisted: true as const,
      applied,
      applyState: applied ? ("applied" as const) : ("pending" as const),
      ...(applyErrorCode ? { errorCode: applyErrorCode } : {}),
      settings,
    };
  }

  private project(aiConfig: AiConfigStored, updatedAt: Date | null): BotSettingsProjection {
    const migrated = migrateAiConfig(aiConfig);
    return {
      revision: revision(updatedAt),
      ai: {
        enabled: migrated.enabled,
        systemPrompt: migrated.systemPrompt,
      },
    };
  }

  private async persist<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof BotSettingsError) throw error;
      throw new BotSettingsError("persistence_failed");
    }
  }
}
