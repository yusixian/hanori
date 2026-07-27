import type { Database } from "@cos-tool-bot/database";
import { bots, miniAppAuditEvents } from "@cos-tool-bot/database";
import type { BotStatus } from "@cos-tool-bot/shared";
import { eq } from "drizzle-orm";
import { KeyedAsyncLock } from "./keyed-async-lock.js";

export interface BotLifecycleRuntime {
  getStatus(botId: string): BotStatus;
  start(botId: string): Promise<void>;
  stop(botId: string): Promise<void>;
  restart(botId: string): Promise<void>;
}

export interface BotLifecycleState {
  desiredActive: boolean;
  runtimeStatus: BotStatus;
  reconciled: boolean;
}

export type BotLifecycleRuntimeErrorCode = "start_failed" | "stop_failed" | "restart_failed";

export interface BotLifecycleMutationResult extends BotLifecycleState {
  persisted: true;
  applied: boolean;
  errorCode?: BotLifecycleRuntimeErrorCode;
}

export type BotLifecycleErrorCode =
  | "invalid_actor"
  | "not_found"
  | "desired_inactive"
  | "persistence_failed";

const SAFE_ERROR_MESSAGES: Readonly<Record<BotLifecycleErrorCode, string>> = {
  invalid_actor: "A valid Telegram administrator ID is required",
  not_found: "Bot was not found",
  desired_inactive: "A disabled Bot cannot be restarted",
  persistence_failed: "Bot lifecycle state could not be persisted",
};

export class BotLifecycleError extends Error {
  constructor(readonly code: BotLifecycleErrorCode) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = "BotLifecycleError";
  }
}

export interface LifecycleInput {
  botId: string;
  actorTelegramUserId: number;
}

function state(desiredActive: boolean, runtimeStatus: BotStatus): BotLifecycleState {
  return {
    desiredActive,
    runtimeStatus,
    reconciled: desiredActive ? runtimeStatus === "running" : runtimeStatus === "stopped",
  };
}

export class BotLifecycleService {
  private readonly locks = new KeyedAsyncLock();

  constructor(
    private readonly db: Database,
    private readonly runtime: BotLifecycleRuntime,
    private readonly now = () => new Date(),
  ) {}

  async read(botId: string): Promise<BotLifecycleState> {
    const [bot] = await this.persist(() =>
      this.db.select({ isActive: bots.isActive }).from(bots).where(eq(bots.id, botId)),
    );
    if (!bot) throw new BotLifecycleError("not_found");
    return state(bot.isActive, this.runtime.getStatus(botId));
  }

  enable(input: LifecycleInput): Promise<BotLifecycleMutationResult> {
    return this.changeDesired(input, true, "bot.lifecycle.enabled", "start_failed", () =>
      this.runtime.start(input.botId),
    );
  }

  disable(input: LifecycleInput): Promise<BotLifecycleMutationResult> {
    return this.changeDesired(input, false, "bot.lifecycle.disabled", "stop_failed", () =>
      this.runtime.stop(input.botId),
    );
  }

  restart(input: LifecycleInput): Promise<BotLifecycleMutationResult> {
    this.assertActor(input.actorTelegramUserId);
    return this.locks.run(input.botId, async () => {
      const desiredActive = await this.persist(() =>
        this.db.transaction(async (tx) => {
          const [bot] = await tx
            .select({ isActive: bots.isActive })
            .from(bots)
            .where(eq(bots.id, input.botId))
            .for("update");
          if (!bot) throw new BotLifecycleError("not_found");
          const allowed = bot.isActive;
          await tx.insert(miniAppAuditEvents).values({
            botId: input.botId,
            actorTelegramUserId: input.actorTelegramUserId,
            actorRole: "admin",
            capability: "bot.lifecycle.manage",
            action: allowed ? "bot.lifecycle.restart-requested" : "bot.lifecycle.restart-rejected",
            resourceType: "bot",
            resourceId: input.botId,
            previousSummary: { desiredActive: bot.isActive },
            nextSummary: {
              desiredActive: bot.isActive,
              runtimeAction: allowed ? "requested" : "rejected",
            },
            outcome: allowed ? "succeeded" : "failed",
            createdAt: this.now(),
          });
          return allowed;
        }),
      );

      if (!desiredActive) throw new BotLifecycleError("desired_inactive");
      return this.applyRuntime(input.botId, true, "restart_failed", () =>
        this.runtime.restart(input.botId),
      );
    });
  }

  private changeDesired(
    input: LifecycleInput,
    desiredActive: boolean,
    action: string,
    errorCode: BotLifecycleRuntimeErrorCode,
    apply: () => Promise<void>,
  ): Promise<BotLifecycleMutationResult> {
    this.assertActor(input.actorTelegramUserId);
    return this.locks.run(input.botId, async () => {
      await this.persist(() =>
        this.db.transaction(async (tx) => {
          const [bot] = await tx
            .select({ isActive: bots.isActive })
            .from(bots)
            .where(eq(bots.id, input.botId))
            .for("update");
          if (!bot) throw new BotLifecycleError("not_found");
          if (bot.isActive !== desiredActive) {
            await tx.update(bots).set({ isActive: desiredActive }).where(eq(bots.id, input.botId));
          }
          await tx.insert(miniAppAuditEvents).values({
            botId: input.botId,
            actorTelegramUserId: input.actorTelegramUserId,
            actorRole: "admin",
            capability: "bot.lifecycle.manage",
            action,
            resourceType: "bot",
            resourceId: input.botId,
            previousSummary: { desiredActive: bot.isActive },
            nextSummary: {
              desiredActive,
              desiredChanged: bot.isActive !== desiredActive,
              runtimeAction: "requested",
            },
            outcome: "succeeded",
            createdAt: this.now(),
          });
        }),
      );

      const runtimeStatus = this.runtime.getStatus(input.botId);
      const alreadyReconciled = desiredActive
        ? runtimeStatus === "running"
        : runtimeStatus === "stopped";
      return alreadyReconciled
        ? { ...state(desiredActive, runtimeStatus), persisted: true, applied: true }
        : this.applyRuntime(input.botId, desiredActive, errorCode, apply);
    });
  }

  private async applyRuntime(
    botId: string,
    desiredActive: boolean,
    errorCode: BotLifecycleRuntimeErrorCode,
    apply: () => Promise<void>,
  ): Promise<BotLifecycleMutationResult> {
    let applied = true;
    try {
      await apply();
    } catch {
      applied = false;
    }
    const nextState = state(desiredActive, this.runtime.getStatus(botId));
    return {
      ...nextState,
      persisted: true,
      applied: applied && nextState.reconciled,
      ...(!applied || !nextState.reconciled ? { errorCode } : {}),
    };
  }

  private assertActor(actorTelegramUserId: number): void {
    if (!Number.isSafeInteger(actorTelegramUserId) || actorTelegramUserId <= 0) {
      throw new BotLifecycleError("invalid_actor");
    }
  }

  private async persist<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof BotLifecycleError) throw error;
      throw new BotLifecycleError("persistence_failed");
    }
  }
}
