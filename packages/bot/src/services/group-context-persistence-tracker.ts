interface GroupMessageIdentity {
  messageId: number;
}

export class GroupContextPersistenceTracker {
  private contextSavedThrough = new Map<number, number>();
  private individuallySavedMessageIds = new Map<number, Set<number>>();

  selectUnsavedContext<T extends GroupMessageIdentity>(
    chatId: number,
    currentMessageId: number,
    messages: T[],
  ): T[] {
    const watermark = this.contextSavedThrough.get(chatId) ?? 0;
    const individuallySaved = this.individuallySavedMessageIds.get(chatId);
    return messages.filter(
      (message) =>
        message.messageId !== currentMessageId &&
        message.messageId > watermark &&
        !individuallySaved?.has(message.messageId),
    );
  }

  commitReply(
    chatId: number,
    currentMessageId: number,
    contextSavedThrough: number | undefined,
    bufferedMessageIds: number[],
  ): void {
    const previousWatermark = this.contextSavedThrough.get(chatId) ?? 0;
    const watermark = Math.max(previousWatermark, contextSavedThrough ?? 0);
    if (watermark > 0) this.contextSavedThrough.set(chatId, watermark);

    const individuallySaved = this.individuallySavedMessageIds.get(chatId) ?? new Set<number>();
    individuallySaved.add(currentMessageId);
    const buffered = new Set(bufferedMessageIds);
    for (const messageId of individuallySaved) {
      if (messageId <= watermark || !buffered.has(messageId)) {
        individuallySaved.delete(messageId);
      }
    }

    if (individuallySaved.size > 0) {
      this.individuallySavedMessageIds.set(chatId, individuallySaved);
    } else {
      this.individuallySavedMessageIds.delete(chatId);
    }
  }

  clearChat(chatId: number): void {
    this.contextSavedThrough.delete(chatId);
    this.individuallySavedMessageIds.delete(chatId);
  }
}
