export interface CoalescedTurnMessage {
  tgMessageId: number;
  text: string;
  /** Group ingress turn to finalize together with the owning run; absent for private chats. */
  sourceKey?: string;
}

export interface CoalesceBatchHandle {
  /** Marks the run as started and returns messages merged so far. Idempotent. */
  drain(): CoalescedTurnMessage[];
  /** Releases a run that never started and returns undrained messages for finalization. */
  close(): CoalescedTurnMessage[];
}

interface Batch {
  readonly userId: number;
  extras: CoalescedTurnMessage[];
  open: boolean;
}

/**
 * Merges rapid follow-up messages into an already-queued AI run for the same chat and user,
 * so one model call answers the whole burst instead of one call per message. Only the run
 * owner interacts with its handle; followers go through tryAppend before scheduling.
 */
export class AiTurnCoalescer {
  private readonly batches = new Map<number, Batch>();

  /** Registers a queued run as the open batch for its chat. Call before the run can start. */
  open(chatId: number, userId: number): CoalesceBatchHandle {
    const batch: Batch = { userId, extras: [], open: true };
    this.batches.set(chatId, batch);

    const take = (): CoalescedTurnMessage[] => {
      if (!batch.open) return [];
      batch.open = false;
      if (this.batches.get(chatId) === batch) this.batches.delete(chatId);
      return batch.extras.splice(0);
    };
    return { drain: take, close: take };
  }

  /** Appends a follow-up to the chat's open batch; false means the caller must schedule normally. */
  tryAppend(chatId: number, userId: number, message: CoalescedTurnMessage): boolean {
    const batch = this.batches.get(chatId);
    if (!batch?.open || batch.userId !== userId) return false;
    batch.extras.push(message);
    return true;
  }

  /** Stops accepting new appends; existing handles still drain/close for turn finalization. */
  destroy(): void {
    this.batches.clear();
  }
}
