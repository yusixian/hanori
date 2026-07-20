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
  execute: () => Promise<GitHubActionResult>;
}

const TTL_MS = 10 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

export class PendingGitHubActionRegistry {
  private readonly actions = new Map<string, PendingGitHubAction>();
  private readonly cleanupHandle: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupHandle = setInterval(() => this.cleanExpired(), CLEANUP_INTERVAL_MS);
    this.cleanupHandle.unref();
  }

  register(input: Omit<PendingGitHubAction, "id" | "createdAt">): PendingGitHubAction {
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

  destroy(): void {
    clearInterval(this.cleanupHandle);
    this.actions.clear();
  }

  private cleanExpired(): void {
    const now = Date.now();
    for (const [id, action] of this.actions) {
      if (now - action.createdAt > TTL_MS) this.actions.delete(id);
    }
  }
}
