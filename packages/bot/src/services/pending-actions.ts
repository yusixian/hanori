export interface PendingPoll {
  type: "poll";
  pollId: string;
  chatId: number;
  messageId: number;
  question: string;
  options: string[];
  answers: Map<number, { userId: number; userName: string; optionIds: number[] }>;
  debounceTimer?: ReturnType<typeof setTimeout>;
  createdAt: number;
}

export interface PendingChoice {
  type: "choice";
  choiceId: string;
  chatId: number;
  messageId: number;
  prompt: string;
  options: string[];
  targetUserId?: number;
  createdAt: number;
  resolved: boolean;
}

export interface PendingTimer {
  type: "timer";
  timerId: string;
  chatId: number;
  reason: string;
  handle: ReturnType<typeof setTimeout>;
  createdAt: number;
}

const TTL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function shortId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 8);
}

export class PendingActionRegistry {
  private polls = new Map<string, PendingPoll>();
  private choices = new Map<string, PendingChoice>();
  private timers = new Map<string, PendingTimer>();
  private cleanupHandle: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupHandle = setInterval(() => this.cleanExpired(), CLEANUP_INTERVAL_MS);
    this.cleanupHandle.unref();
  }

  // --- Polls ---

  registerPoll(
    pollId: string,
    chatId: number,
    messageId: number,
    question: string,
    options: string[],
  ): PendingPoll {
    const pending: PendingPoll = {
      type: "poll",
      pollId,
      chatId,
      messageId,
      question,
      options,
      answers: new Map(),
      createdAt: Date.now(),
    };
    this.polls.set(pollId, pending);
    return pending;
  }

  getPoll(pollId: string): PendingPoll | undefined {
    return this.polls.get(pollId);
  }

  removePoll(pollId: string): PendingPoll | undefined {
    const poll = this.polls.get(pollId);
    if (poll?.debounceTimer) clearTimeout(poll.debounceTimer);
    this.polls.delete(pollId);
    return poll;
  }

  // --- Choices ---

  generateChoiceId(): string {
    return shortId();
  }

  registerChoice(
    choiceId: string,
    chatId: number,
    messageId: number,
    prompt: string,
    options: string[],
    targetUserId?: number,
  ): PendingChoice {
    const pending: PendingChoice = {
      type: "choice",
      choiceId,
      chatId,
      messageId,
      prompt,
      options,
      targetUserId,
      createdAt: Date.now(),
      resolved: false,
    };
    this.choices.set(choiceId, pending);
    return pending;
  }

  getChoice(choiceId: string): PendingChoice | undefined {
    return this.choices.get(choiceId);
  }

  removeChoice(choiceId: string): PendingChoice | undefined {
    const choice = this.choices.get(choiceId);
    this.choices.delete(choiceId);
    return choice;
  }

  // --- Timers ---

  registerTimer(
    chatId: number,
    reason: string,
    handle: ReturnType<typeof setTimeout>,
  ): PendingTimer {
    const timerId = shortId();
    const pending: PendingTimer = {
      type: "timer",
      timerId,
      chatId,
      reason,
      handle,
      createdAt: Date.now(),
    };
    this.timers.set(timerId, pending);
    return pending;
  }

  getTimer(timerId: string): PendingTimer | undefined {
    return this.timers.get(timerId);
  }

  removeTimer(timerId: string): PendingTimer | undefined {
    const timer = this.timers.get(timerId);
    if (timer) clearTimeout(timer.handle);
    this.timers.delete(timerId);
    return timer;
  }

  // --- Bulk ops ---

  clearChat(chatId: number): void {
    for (const [id, poll] of this.polls) {
      if (poll.chatId === chatId) {
        if (poll.debounceTimer) clearTimeout(poll.debounceTimer);
        this.polls.delete(id);
      }
    }
    for (const [id, choice] of this.choices) {
      if (choice.chatId === chatId) this.choices.delete(id);
    }
    for (const [id, timer] of this.timers) {
      if (timer.chatId === chatId) {
        clearTimeout(timer.handle);
        this.timers.delete(id);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupHandle);
    for (const poll of this.polls.values()) {
      if (poll.debounceTimer) clearTimeout(poll.debounceTimer);
    }
    for (const timer of this.timers.values()) {
      clearTimeout(timer.handle);
    }
    this.polls.clear();
    this.choices.clear();
    this.timers.clear();
  }

  private cleanExpired(): void {
    const now = Date.now();
    for (const [id, poll] of this.polls) {
      if (now - poll.createdAt > TTL_MS) {
        if (poll.debounceTimer) clearTimeout(poll.debounceTimer);
        this.polls.delete(id);
      }
    }
    for (const [id, choice] of this.choices) {
      if (now - choice.createdAt > TTL_MS) this.choices.delete(id);
    }
    for (const [id, timer] of this.timers) {
      if (now - timer.createdAt > TTL_MS) {
        clearTimeout(timer.handle);
        this.timers.delete(id);
      }
    }
  }
}
