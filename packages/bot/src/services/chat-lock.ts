// Per-chat promise-chain mutex shared across all generation paths (the main
// AI-reply handler and timer-driven continueChat) so their streamText calls
// never run concurrently for the same chat and corrupt shared state
// (recentBotMessageIds, moodState, conversation history).
const chatLocks = new Map<number, Promise<void>>();

/**
 * Acquire the per-chat lock, queuing behind any current holder.
 * Returns a release function that MUST be called exactly once (e.g. in a finally).
 */
export async function acquireChatLock(chatId: number): Promise<() => void> {
  const prev = chatLocks.get(chatId) ?? Promise.resolve();
  let resolve!: () => void;
  const current = new Promise<void>((r) => {
    resolve = r;
  });
  chatLocks.set(chatId, current);
  await prev;
  return () => {
    resolve();
    if (chatLocks.get(chatId) === current) {
      chatLocks.delete(chatId);
    }
  };
}

/** Run `fn` while holding the per-chat lock. */
export async function withChatLock<T>(chatId: number, fn: () => Promise<T>): Promise<T> {
  const release = await acquireChatLock(chatId);
  try {
    return await fn();
  } finally {
    release();
  }
}
