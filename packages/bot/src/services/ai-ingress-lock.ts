class KeyedIngressLock {
  private readonly tails = new Map<number, Promise<void>>();

  acquire(key: number): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let resolveCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      resolveCurrent = resolve;
    });
    this.tails.set(key, current);
    return previous.then(() => {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        resolveCurrent();
        if (this.tails.get(key) === current) this.tails.delete(key);
      };
    });
  }

  async run<T>(key: number, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(key);
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

/**
 * Short-lived ingress locks owned by one Bot runtime. They coordinate ordinary message capture
 * with destructive commands without holding a lock for the long AI execution phase.
 */
export class AiIngressLock {
  private readonly chats = new KeyedIngressLock();
  private readonly users = new KeyedIngressLock();
  private readonly admittedContexts = new WeakSet<object>();

  async runMessage<T>(chatId: number, userId: number, operation: () => Promise<T>): Promise<T> {
    return this.runExecutionAdmission(chatId, userId, operation);
  }

  async runExecutionAdmission<T>(
    chatId: number,
    userId: number | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    // Register both ownership requests synchronously before yielding. A destructive command
    // arriving in the next microtask therefore cannot overtake this admission on either scope.
    const chatPermit = this.chats.acquire(chatId);
    const userPermit = userId === undefined ? undefined : this.users.acquire(userId);
    const releaseChat = await chatPermit;
    const releaseUser = await userPermit;
    try {
      return await operation();
    } finally {
      releaseUser?.();
      releaseChat();
    }
  }

  /**
   * Registers a message before the middleware chain can yield, then marks the Context while the
   * short ingress phase owns both fences. The AI handler uses the marker to avoid acquiring the
   * same non-reentrant locks again when it is invoked through createBot.
   */
  runAdmittedMessage<T>(
    context: object,
    chatId: number,
    userId: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.runMessage(chatId, userId, async () => {
      this.admittedContexts.add(context);
      try {
        return await operation();
      } finally {
        this.admittedContexts.delete(context);
      }
    });
  }

  hasMessageAdmission(context: object): boolean {
    return this.admittedContexts.has(context);
  }

  runChatMutation<T>(chatId: number, operation: () => Promise<T>): Promise<T> {
    return this.chats.run(chatId, operation);
  }

  runUserMutation<T>(userId: number, operation: () => Promise<T>): Promise<T> {
    return this.users.run(userId, operation);
  }
}
