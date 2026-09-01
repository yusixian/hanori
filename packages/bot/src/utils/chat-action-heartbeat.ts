export const CHAT_ACTION_REFRESH_INTERVAL_MS = 4_000;

/**
 * Refresh a best-effort Telegram chat action while a longer operation is running.
 * The caller sends the first action so it can preserve its existing admission/error semantics.
 */
export function startChatActionHeartbeat(
  sendAction: () => Promise<unknown>,
  intervalMs = CHAT_ACTION_REFRESH_INTERVAL_MS,
): () => void {
  let stopped = false;
  let actionInFlight = false;

  const timer = setInterval(() => {
    if (stopped || actionInFlight) return;
    actionInFlight = true;
    void Promise.resolve()
      .then(sendAction)
      .catch(() => {})
      .finally(() => {
        actionInFlight = false;
      });
  }, intervalMs);
  timer.unref();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
