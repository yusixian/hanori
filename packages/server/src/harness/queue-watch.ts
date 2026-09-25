import { escapeHtml } from "@cos-tool-bot/bot/utils/format";
import type { ProjectEffectiveConfig } from "./config/schema.js";
import { durationMs } from "./config/units.js";
import { formatElapsed, queueAge } from "./job-card.js";
import { generalThread } from "./job-monitor.js";
import type { HarnessRequestRecord } from "./store.js";
import type { HarnessWork } from "./work.js";

interface Episode {
  key: string;
  since: Date;
}

/**
 * Tracks how long each request has been queued. The start of a wait is stored as a keyed event
 * (one per start attempt), so it survives restarts without a schema change.
 */
export class QueueWatch {
  private readonly episodes = new Map<string, Episode>();
  private readonly shownAge = new Map<string, string | null>();

  constructor(private readonly work: HarnessWork) {}

  /** Drops state for requests that are no longer queued. */
  forget(queued: readonly HarnessRequestRecord[]) {
    const ids = new Set(queued.map((request) => request.id));
    for (const map of [this.episodes, this.shownAge]) {
      for (const id of map.keys()) if (!ids.has(id)) map.delete(id);
    }
  }

  private async episode(request: HarnessRequestRecord): Promise<Episode> {
    const { store } = this.work.service;
    const job = await store.latestJob(request.id);
    const key = `harness-queue:${request.id}:${job?.attempt ?? 0}`;
    const cached = this.episodes.get(request.id);
    if (cached?.key === key) return cached;
    const now = this.work.service.now();
    await store.recordDelivery(key, {
      type: "queue.waiting",
      projectKey: request.projectKey,
      requestId: request.id,
      payload: { since: now.toISOString() },
    });
    const recorded = (await store.findDelivery(key))?.payload?.since;
    const since = typeof recorded === "string" ? new Date(recorded) : now;
    const episode = { key, since: Number.isNaN(since.getTime()) ? now : since };
    this.episodes.set(request.id, episode);
    return episode;
  }

  async since(request: HarnessRequestRecord): Promise<Date> {
    return (await this.episode(request)).since;
  }

  /** True when the queued-for label on the card would read differently now. */
  ageChanged(request: HarnessRequestRecord, since: Date): boolean {
    const label = queueAge(this.work.service.now().getTime() - since.getTime());
    if (this.shownAge.has(request.id) && this.shownAge.get(request.id) === label) return false;
    this.shownAge.set(request.id, label);
    return true;
  }

  /** One General-topic notice per wait once no machine has been reachable for too long. */
  async escalate(
    request: HarnessRequestRecord,
    config: ProjectEffectiveConfig,
    since: Date,
    reason: string,
  ) {
    const { service } = this.work;
    const telegram = service.telegram;
    const after = config.guardrails.time.queueEscalateAfter;
    if (!telegram || !after) return;
    const waitedMs = service.now().getTime() - since.getTime();
    if (waitedMs < durationMs(after)) return;
    const { key } = await this.episode(request);
    const fresh = await service.store.recordDelivery(`${key}:escalated`, {
      type: "queue.escalated",
      projectKey: request.projectKey,
      requestId: request.id,
      payload: { waitedMs, reason },
    });
    if (!fresh) return;
    const global = service.globalView().config;
    const subject = [
      config.project.key,
      request.issueNumber ? `#${request.issueNumber}` : null,
      (request.title ?? "").slice(0, 60),
    ]
      .filter(Boolean)
      .join(" ");
    await telegram.send(global.telegram.chatId, {
      html: [
        `⚠️ ${escapeHtml(subject)} 已排队 ${formatElapsed(waitedMs)}：${escapeHtml(reason)}`,
        "请检查 Mac 是否在线、Lody daemon 与 lody-bridge 是否正常。",
      ].join("\n"),
      threadId: generalThread(global.telegram.topics.overview),
    });
  }
}
