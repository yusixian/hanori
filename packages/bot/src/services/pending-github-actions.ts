import { randomBytes } from "node:crypto";

export interface GitHubActionResult {
  summary: string;
  url?: string;
}

export interface PendingGitHubAction {
  id: string;
  chatId: number;
  userId: number;
  description: string;
  createdAt: number;
  execute: (signal?: AbortSignal) => Promise<GitHubActionResult>;
}

const TTL_MS = 10 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

export class PendingGitHubActionRegistry {
  private readonly actions = new Map<string, PendingGitHubAction>();
  private readonly active = new Map<string, AbortController>();
  private readonly cleanupHandle: ReturnType<typeof setInterval>;
  private destroyed = false;

  constructor() {
    this.cleanupHandle = setInterval(() => this.cleanExpired(), CLEANUP_INTERVAL_MS);
    this.cleanupHandle.unref();
  }

  register(input: Omit<PendingGitHubAction, "id" | "createdAt">): PendingGitHubAction {
    if (this.destroyed) throw new Error("GitHub action registry was destroyed");
    const action = {
      ...input,
      id: randomBytes(6).toString("base64url"),
      createdAt: Date.now(),
    };
    this.actions.set(action.id, action);
    return action;
  }

  get(id: string): PendingGitHubAction | undefined {
    const action = this.actions.get(id);
    if (action && Date.now() - action.createdAt > TTL_MS) {
      this.actions.delete(id);
      return undefined;
    }
    return action;
  }

  take(id: string): PendingGitHubAction | undefined {
    const action = this.get(id);
    if (action) this.actions.delete(id);
    return action;
  }

  remove(id: string): void {
    this.actions.delete(id);
  }

  async run(action: PendingGitHubAction): Promise<GitHubActionResult> {
    if (this.destroyed) throw new Error("GitHub action registry was destroyed");
    if (this.active.has(action.id)) throw new Error("GitHub action is already running");
    const controller = new AbortController();
    this.active.set(action.id, controller);
    try {
      return await action.execute(controller.signal);
    } finally {
      this.active.delete(action.id);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    clearInterval(this.cleanupHandle);
    this.actions.clear();
    for (const controller of this.active.values()) {
      controller.abort(new Error("GitHub action registry was destroyed"));
    }
    this.active.clear();
  }

  private cleanExpired(): void {
    const now = Date.now();
    for (const [id, action] of this.actions) {
      if (now - action.createdAt > TTL_MS) this.actions.delete(id);
    }
  }
}
