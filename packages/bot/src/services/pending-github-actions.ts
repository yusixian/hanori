import { randomBytes } from "node:crypto";
import { drainTasks } from "./drain-tasks.js";

export interface AdminActionResult {
  summary: string;
  url?: string;
}

export type AdminActionKind =
  | "github"
  | "rss:mark_rss_read"
  | "rss:add_rss_feed"
  | "rss:remove_rss_feed"
  | "rss:create_rss_collection";

export interface PendingAdminAction {
  id: string;
  kind: AdminActionKind;
  chatId: number;
  userId: number;
  description: string;
  createdAt: number;
  execute: (signal?: AbortSignal) => Promise<AdminActionResult>;
}

export type GitHubActionResult = AdminActionResult;
export type PendingGitHubAction = PendingAdminAction;

export interface AdminActionDrainResult {
  readonly settled: boolean;
  readonly timedOut: boolean;
}

export const PENDING_ADMIN_ACTION_TTL_MS = 10 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;
const DEFAULT_DRAIN_WAIT_MS = 5_000;

interface ActiveAdminAction {
  controller: AbortController;
  settled: Promise<void>;
}

export class PendingAdminActionRegistry {
  private readonly actions = new Map<string, PendingAdminAction>();
  private readonly active = new Map<string, ActiveAdminAction>();
  private readonly cleanupHandle: ReturnType<typeof setInterval>;
  private destroyed = false;

  constructor() {
    this.cleanupHandle = setInterval(() => this.cleanExpired(), CLEANUP_INTERVAL_MS);
    this.cleanupHandle.unref();
  }

  register(
    input: Omit<PendingAdminAction, "id" | "kind" | "createdAt"> & {
      kind?: AdminActionKind;
    },
  ): PendingAdminAction {
    if (this.destroyed) throw new Error("Admin action registry was destroyed");
    const action = {
      ...input,
      kind: input.kind ?? "github",
      id: randomBytes(6).toString("base64url"),
      createdAt: Date.now(),
    };
    this.actions.set(action.id, action);
    return action;
  }

  get(id: string): PendingAdminAction | undefined {
    const action = this.actions.get(id);
    if (action && Date.now() - action.createdAt >= PENDING_ADMIN_ACTION_TTL_MS) {
      this.actions.delete(id);
      return undefined;
    }
    return action;
  }

  take(id: string): PendingAdminAction | undefined {
    const action = this.get(id);
    if (action) this.actions.delete(id);
    return action;
  }

  remove(id: string): void {
    this.actions.delete(id);
  }

  async run(action: PendingAdminAction): Promise<AdminActionResult> {
    if (this.destroyed) throw new Error("Admin action registry was destroyed");
    if (this.active.has(action.id)) throw new Error("Admin action is already running");
    const controller = new AbortController();
    const execution = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return action.execute(controller.signal);
    });
    const active: ActiveAdminAction = {
      controller,
      settled: execution
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => {
          if (this.active.get(action.id) === active) this.active.delete(action.id);
        }),
    };
    this.active.set(action.id, active);
    return execution;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    clearInterval(this.cleanupHandle);
    this.actions.clear();
    for (const action of this.active.values()) {
      action.controller.abort(new Error("Admin action registry was destroyed"));
    }
  }

  async drain(waitMs = DEFAULT_DRAIN_WAIT_MS): Promise<AdminActionDrainResult> {
    return drainTasks(
      [...this.active.values()].map((action) => action.settled),
      waitMs,
    );
  }

  async destroyAndDrain(waitMs = DEFAULT_DRAIN_WAIT_MS): Promise<AdminActionDrainResult> {
    this.destroy();
    return this.drain(waitMs);
  }

  private cleanExpired(): void {
    const now = Date.now();
    for (const [id, action] of this.actions) {
      if (now - action.createdAt >= PENDING_ADMIN_ACTION_TTL_MS) this.actions.delete(id);
    }
  }
}

// Compatibility export for existing GitHub tool integrations.
export { PendingAdminActionRegistry as PendingGitHubActionRegistry };
