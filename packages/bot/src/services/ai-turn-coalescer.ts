import type { ConversationForwardOrigin, UserPrivacyMode } from "@cos-tool-bot/shared";

export interface CoalescedTurnMessage {
  tgMessageId: number;
  /** Full request text, including a reply anchor when present. */
  text: string;
  /** Content authored by this user only; safe for cross-chat personalization. */
  userAuthoredContent?: string;
  /** Telegram-visible forwarding attribution retained for request and history rendering. */
  forwardOrigin?: ConversationForwardOrigin;
  /** Group ingress turn to finalize together with the owning run; absent for private chats. */
  sourceKey?: string;
}

/**
 * Identifies the conversation a batch belongs to. `threadId` keeps forum topics apart: a run
 * replies into the thread it was triggered from, so merging across topics would answer one
 * topic's message in another.
 */
export interface CoalesceScope {
  chatId: number;
  threadId?: number;
  userId: number;
  privacyMode: UserPrivacyMode;
}

export interface CoalesceBatchHandle {
  /** Marks the run as started and returns messages merged so far. Idempotent. */
  drain(): CoalescedTurnMessage[];
  /** Releases a run that never started and returns undrained messages for finalization. */
  close(): CoalescedTurnMessage[];
}

export interface CoalesceAdmission {
  readonly sequence: number;
}

export interface AiTurnCoalescerOptions {
  maxMessages?: number;
  maxChars?: number;
  maxScopes?: number;
}

/**
 * Merged follow-ups bypass the scheduler's queue-full guard, so the batch enforces its own
 * ceiling: past it `tryAppend` declines and the message schedules normally, where the queue
 * limit applies again. Without this a burst would grow one prompt without bound.
 */
const DEFAULT_MAX_MESSAGES = 10;
const DEFAULT_MAX_CHARS = 2000;
const DEFAULT_MAX_SCOPES = 10_000;

interface Batch {
  readonly userId: number;
  readonly privacyMode: UserPrivacyMode;
  extras: CoalescedTurnMessage[];
  chars: number;
  open: boolean;
}

function scopeKey(scope: Pick<CoalesceScope, "chatId" | "threadId">): string {
  return `${scope.chatId}:${scope.threadId ?? 0}`;
}

/**
 * Merges rapid follow-up messages into an already-queued AI run for the same conversation and
 * user, so one model call answers the whole burst instead of one call per message. Only the run
 * owner interacts with its handle; followers go through tryAppend before scheduling.
 */
export class AiTurnCoalescer {
  private readonly batches = new Map<string, Batch>();
  private readonly boundarySequences = new Map<string, number>();
  private readonly maxMessages: number;
  private readonly maxChars: number;
  private readonly maxScopes: number;
  private nextSequence = 1;
  private clearSequence = 0;

  constructor(options: AiTurnCoalescerOptions = {}) {
    this.maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    this.maxScopes = options.maxScopes ?? DEFAULT_MAX_SCOPES;
  }

  /** Captures message arrival before asynchronous ingress work can be overtaken by a boundary. */
  capture(_scope: Pick<CoalesceScope, "chatId" | "threadId">): CoalesceAdmission {
    return { sequence: this.nextSequence++ };
  }

  /** Registers a queued run as the open batch for its scope. Call before the run can start. */
  open(scope: CoalesceScope, admission = this.capture(scope)): CoalesceBatchHandle {
    const key = scopeKey(scope);
    const batch: Batch = {
      userId: scope.userId,
      privacyMode: scope.privacyMode,
      extras: [],
      chars: 0,
      open: true,
    };
    const isCurrentAdmission =
      admission.sequence >= this.clearSequence &&
      admission.sequence >= (this.boundarySequences.get(key) ?? 0);
    if (isCurrentAdmission) this.batches.set(key, batch);

    const take = (): CoalescedTurnMessage[] => {
      if (!batch.open) return [];
      batch.open = false;
      if (this.batches.get(key) === batch) this.batches.delete(key);
      return batch.extras.splice(0);
    };
    return { drain: take, close: take };
  }

  /** Appends a follow-up to the scope's open batch; false means the caller must schedule normally. */
  tryAppend(scope: CoalesceScope, message: CoalescedTurnMessage): boolean {
    const batch = this.batches.get(scopeKey(scope));
    if (!batch?.open || batch.userId !== scope.userId || batch.privacyMode !== scope.privacyMode) {
      return false;
    }
    if (batch.extras.length >= this.maxMessages) return false;
    if (batch.chars + message.text.length > this.maxChars) return false;
    batch.extras.push(message);
    batch.chars += message.text.length;
    return true;
  }

  /**
   * Prevents later messages in this conversation from crossing an intervening message. Existing
   * handles remain drainable so extras already accepted by the queued owner are not lost.
   */
  stopAccepting(scope: Pick<CoalesceScope, "chatId" | "threadId">): void {
    const key = scopeKey(scope);
    if (!this.reserveBoundaryScope(key)) return;
    this.boundarySequences.set(key, this.nextSequence++);
    this.batches.delete(key);
  }

  /** Applies a message boundary only if no later-arriving boundary has already overtaken it. */
  advance(scope: Pick<CoalesceScope, "chatId" | "threadId">, admission: CoalesceAdmission): void {
    const key = scopeKey(scope);
    const latestBoundary = Math.max(this.clearSequence, this.boundarySequences.get(key) ?? 0);
    if (latestBoundary > admission.sequence) return;
    if (!this.reserveBoundaryScope(key)) return;
    this.boundarySequences.set(key, admission.sequence);
    this.batches.delete(key);
  }

  /** Bounds inactive scope metadata; a global boundary is the safest overflow fallback. */
  private reserveBoundaryScope(key: string): boolean {
    if (this.boundarySequences.has(key) || this.boundarySequences.size < this.maxScopes)
      return true;
    this.clear();
    return false;
  }

  /** Stops current batches accepting appends; handles still drain/close for finalization. */
  clear(): void {
    this.clearSequence = this.nextSequence++;
    this.boundarySequences.clear();
    this.batches.clear();
  }
}
