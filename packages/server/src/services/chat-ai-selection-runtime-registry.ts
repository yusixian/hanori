export interface ChatAiSelectionPair {
  readonly providerId: string;
  readonly modelId: string | null;
}

export interface ChatAiSelectionRuntimeSnapshot {
  /** Opaque durable revision represented by this complete runtime snapshot. */
  readonly revision: string;
  readonly global: Readonly<ChatAiSelectionPair>;
  readonly chats: ReadonlyMap<number, Readonly<ChatAiSelectionPair>>;
}

export interface ChatAiSelectionRuntime {
  apply(snapshot: ChatAiSelectionRuntimeSnapshot): Promise<void>;
}

export type ChatAiSelectionPublishResult =
  | {
      readonly status: "applied";
      readonly desiredRevision: string;
      readonly appliedRevision: string;
    }
  | {
      readonly status: "pending";
      readonly desiredRevision: string;
      readonly appliedRevision: string | null;
      readonly reason: "runtime_unavailable" | "apply_failed" | "runtime_replaced";
      readonly error?: unknown;
    };

interface RuntimeEntry {
  readonly runtime: ChatAiSelectionRuntime;
  appliedRevision: string | null;
}

/**
 * Connects durable AI-selection state to a running Bot without owning persistence
 * or mutation ordering. Callers must serialize publishes for the same Bot.
 */
export class ChatAiSelectionRuntimeRegistry {
  private readonly entries = new Map<string, RuntimeEntry>();

  register(botId: string, runtime: ChatAiSelectionRuntime): () => void {
    const entry: RuntimeEntry = { runtime, appliedRevision: null };
    this.entries.set(botId, entry);
    return () => {
      if (this.entries.get(botId) === entry) this.entries.delete(botId);
    };
  }

  unregister(botId: string, runtime: ChatAiSelectionRuntime): boolean {
    const entry = this.entries.get(botId);
    if (!entry || entry.runtime !== runtime) return false;
    return this.entries.delete(botId);
  }

  getAppliedRevision(botId: string): string | null {
    return this.entries.get(botId)?.appliedRevision ?? null;
  }

  async publish(
    botId: string,
    snapshot: ChatAiSelectionRuntimeSnapshot,
  ): Promise<ChatAiSelectionPublishResult> {
    const desiredRevision = snapshot.revision;
    const entry = this.entries.get(botId);
    if (!entry) {
      return {
        status: "pending",
        desiredRevision,
        appliedRevision: null,
        reason: "runtime_unavailable",
      };
    }

    try {
      await entry.runtime.apply(snapshot);
    } catch (error) {
      return {
        status: "pending",
        desiredRevision,
        appliedRevision: entry.appliedRevision,
        reason: "apply_failed",
        error,
      };
    }

    if (this.entries.get(botId) !== entry) {
      return {
        status: "pending",
        desiredRevision,
        appliedRevision: this.getAppliedRevision(botId),
        reason: "runtime_replaced",
      };
    }

    entry.appliedRevision = desiredRevision;
    return { status: "applied", desiredRevision, appliedRevision: desiredRevision };
  }
}
