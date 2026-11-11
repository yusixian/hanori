import type { ScheduledTaskActor } from "@cos-tool-bot/shared";

const discussions = new Map<string, number>();
const ttlMs = 10 * 60 * 1000;
function key(actor: Pick<ScheduledTaskActor, "botId" | "chatId" | "threadId" | "userId">) {
  return JSON.stringify([actor.botId, actor.chatId, actor.threadId ?? null, actor.userId]);
}
export function beginTaskDiscussion(actor: ScheduledTaskActor, now = Date.now()) {
  for (const [id, expiry] of discussions) if (expiry <= now) discussions.delete(id);
  discussions.set(key(actor), now + ttlMs);
}
export function hasTaskDiscussion(
  actor: Pick<ScheduledTaskActor, "botId" | "chatId" | "threadId" | "userId">,
  now = Date.now(),
) {
  const id = key(actor);
  const expiry = discussions.get(id);
  if (expiry === undefined) return false;
  if (expiry <= now) {
    discussions.delete(id);
    return false;
  }
  return true;
}
export function endTaskDiscussion(actor: ScheduledTaskActor) {
  discussions.delete(key(actor));
}
