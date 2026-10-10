/** Waits for tracked, rejection-handled tasks without claiming to stop timed-out work. */
export async function drainTasks(
  tasks: readonly Promise<void>[],
  waitMs: number,
): Promise<{ readonly settled: boolean; readonly timedOut: boolean }> {
  if (tasks.length === 0) return Object.freeze({ settled: true, timedOut: false });
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const allSettled = Promise.all(tasks).then(() => {
    settled = true;
  });
  await Promise.race([
    allSettled,
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, waitMs);
      timeout.unref?.();
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
  return Object.freeze({ settled, timedOut: !settled });
}
