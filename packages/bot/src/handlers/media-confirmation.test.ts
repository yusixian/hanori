import type { MediaJobActor, MediaJobView, MediaTranscriptionPort } from "@cos-tool-bot/shared";
import type { Api } from "grammy";
import { describe, expect, it, vi } from "vitest";
import {
  createMediaConfirmationCallbackQueryHandler,
  sendMediaConfirmationMessage,
} from "./media-confirmation.js";

const ID = "00000000-0000-4000-8000-000000000166";
const BOT_ID = "00000000-0000-4000-8000-000000000001";
const actor: MediaJobActor = { botId: BOT_ID, chatId: -100, userId: 7, threadId: 9, isAdmin: true };
const pending: MediaJobView = {
  id: ID,
  sourceUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
  title: "示例视频 <b>真实标题</b>",
  part: 2,
  durationSeconds: 75,
  threadId: 9,
  status: "pending_confirmation",
  progress: 0,
  error: null,
  createdAt: "2026-10-03T00:00:00.000Z",
  updatedAt: "2026-10-03T00:00:00.000Z",
  expiresAt: "2026-10-04T00:00:00.000Z",
  language: null,
  source: "asr",
  notification: "pending",
  confirmation: {
    provider: "腾讯云",
    model: "16k_zh",
    currency: "CNY",
    estimatedCost: 0.03,
    maxCost: 0.1,
    freeQuota: "剩余免费额度未知，以腾讯云账单为准",
    expiresAt: "2026-10-03T00:10:00.000Z",
  },
};

function callback(
  options: {
    userId?: number;
    chatId?: number;
    threadId?: number | null;
    decision?: "yes" | "no";
  } = {},
) {
  return {
    callbackQuery: {
      id: "callback-1",
      data: `cos:asr:${ID}:${options.decision ?? "yes"}`,
      from: { id: options.userId ?? actor.userId },
      message: {
        chat: { id: options.chatId ?? actor.chatId },
        message_id: 22,
        ...(options.threadId === null
          ? {}
          : { message_thread_id: options.threadId ?? actor.threadId }),
      },
    },
  };
}

function api() {
  return {
    raw: { answerCallbackQuery: vi.fn().mockResolvedValue(true) },
    editMessageText: vi.fn().mockResolvedValue({ message_id: 22 }),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 22 }),
  };
}

function port(): MediaTranscriptionPort {
  return {
    create: vi.fn(),
    confirm: vi.fn().mockResolvedValue({ ...pending, status: "queued" }),
    cancel: vi.fn().mockResolvedValue({ ...pending, status: "cancelled" }),
    get: vi.fn(),
    read: vi.fn(),
  };
}

function setup(
  options: { port?: MediaTranscriptionPort; adminIds?: number[]; botId?: string } = {},
) {
  const telegram = api();
  const transcription = options.port ?? port();
  const handler = createMediaConfirmationCallbackQueryHandler({
    api: telegram as unknown as Api,
    botId: options.botId ?? BOT_ID,
    adminIds: options.adminIds ?? [7],
    port: transcription,
  });
  return { telegram, transcription, handler };
}

function safeError(code: string) {
  return Object.assign(new Error("Authorization=synthetic-secret provider.private.invalid"), {
    code,
  });
}

/** Represents storage held outside a handler; duplicate claims are decided by the persisted port. */
function persistedPort() {
  let job = { ...pending };
  let starts = 0;
  const transcription = port();
  const check = (actual: MediaJobActor, id: string) => {
    if (
      actual.botId !== actor.botId ||
      actual.chatId !== actor.chatId ||
      actual.userId !== actor.userId ||
      actual.threadId !== actor.threadId ||
      id !== job.id
    )
      throw safeError("not_found");
  };
  transcription.confirm = vi.fn(async (actual, id) => {
    check(actual, id);
    if (job.status === "pending_confirmation") {
      job = { ...job, status: "queued" };
      starts++;
    }
    return job;
  });
  transcription.cancel = vi.fn(async (actual, id) => {
    check(actual, id);
    if (job.status === "pending_confirmation") job = { ...job, status: "cancelled" };
    return job;
  });
  return { transcription, starts: () => starts };
}

describe("persistent audio transcription confirmation callbacks", () => {
  it("acknowledges Telegram before validation and only enqueues the trusted actor's job", async () => {
    const { telegram, transcription, handler } = setup();
    await expect(handler(callback())).resolves.toBe(true);
    expect(transcription.confirm).toHaveBeenCalledExactlyOnceWith(actor, ID);
    expect(telegram.raw.answerCallbackQuery.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(transcription.confirm).mock.invocationCallOrder[0]!,
    );
    expect(transcription.create).not.toHaveBeenCalled();
    expect(telegram.editMessageText).toHaveBeenCalledWith(
      actor.chatId,
      22,
      expect.stringContaining("任务已入队"),
      { reply_markup: { inline_keyboard: [] } },
    );
  });

  it("lets the persisted port claim a double click once", async () => {
    const persisted = persistedPort();
    const { handler } = setup({ port: persisted.transcription });
    await Promise.all([handler(callback()), handler(callback())]);
    expect(persisted.starts()).toBe(1);
  });

  it("can confirm a persisted request after constructing a new Bot handler", async () => {
    const persisted = persistedPort();
    setup({ port: persisted.transcription });
    const restarted = setup({ port: persisted.transcription });
    await restarted.handler(callback());
    expect(persisted.starts()).toBe(1);
    const restartedAgain = setup({ port: persisted.transcription });
    await restartedAgain.handler(callback());
    expect(persisted.starts()).toBe(1);
  });

  it.each([{ adminIds: [] }, { adminIds: [8] }])(
    "rejects callers outside the Bot administrator list %j before port access",
    async ({ adminIds }) => {
      const { telegram, transcription, handler } = setup({ adminIds });
      await handler(callback());
      expect(transcription.confirm).not.toHaveBeenCalled();
      expect(transcription.cancel).not.toHaveBeenCalled();
      expect(telegram.raw.answerCallbackQuery).toHaveBeenCalledWith(
        expect.objectContaining({ show_alert: true }),
      );
      expect(telegram.editMessageText).not.toHaveBeenCalled();
    },
  );

  it.each([{ chatId: -200 }, { threadId: 10 }, { threadId: null }, { userId: 8 }])(
    "uses the real callback scope and preserves another request's card: %j",
    async (scope) => {
      const persisted = persistedPort();
      const { handler, telegram } = setup({ port: persisted.transcription, adminIds: [7, 8] });
      await handler(callback(scope));
      expect(persisted.starts()).toBe(0);
      expect(telegram.editMessageText).not.toHaveBeenCalled();
      expect(telegram.raw.answerCallbackQuery).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: "该转录请求不存在或已过期", show_alert: true }),
      );
    },
  );

  it("binds the Bot ID from its own configuration", async () => {
    const persisted = persistedPort();
    const { handler, telegram } = setup({ port: persisted.transcription, botId: "another-bot" });
    await handler(callback());
    expect(persisted.starts()).toBe(0);
    expect(telegram.editMessageText).not.toHaveBeenCalled();
  });

  it("cancels a pending request without starting ASR and cannot start it on a later click", async () => {
    const persisted = persistedPort();
    const { handler, telegram } = setup({ port: persisted.transcription });
    await handler(callback({ decision: "no" }));
    expect(persisted.transcription.cancel).toHaveBeenCalledExactlyOnceWith(actor, ID);
    expect(persisted.starts()).toBe(0);
    await handler(callback());
    expect(persisted.starts()).toBe(0);
    expect(telegram.editMessageText).toHaveBeenLastCalledWith(
      actor.chatId,
      22,
      expect.stringContaining("已取消"),
      expect.anything(),
    );
  });

  it.each(["expired", "configuration_required", "quota_exceeded"])(
    "reports a safe %s error without provider diagnostics",
    async (code) => {
      const { handler, telegram, transcription } = setup();
      vi.mocked(transcription.confirm).mockRejectedValue(safeError(code));
      await handler(callback());
      const text = telegram.editMessageText.mock.calls[0]![2];
      expect(text).toContain("❌");
      expect(text).not.toContain("synthetic-secret");
      expect(text).not.toContain("provider.private");
    },
  );

  it("renders a persisted expired status instead of claiming the job was queued", async () => {
    const { handler, telegram, transcription } = setup();
    vi.mocked(transcription.confirm).mockResolvedValue({ ...pending, status: "expired" });
    await handler(callback());
    expect(telegram.editMessageText.mock.calls[0]![2]).toContain("已过期");
    expect(telegram.editMessageText.mock.calls[0]![2]).not.toContain("已入队");
  });

  it.each([
    { status: "failed" as const, error: "provider_cancellation_unavailable" },
    { status: "transcribing" as const, error: null },
  ])(
    "distinguishes stopping local waiting from cancelling a billable cloud task: %j",
    async (state) => {
      const { handler, telegram, transcription } = setup();
      vi.mocked(transcription.cancel).mockResolvedValue({
        ...pending,
        cancelRequested: true,
        ...state,
      });
      await handler(callback({ decision: "no" }));
      expect(telegram.editMessageText.mock.calls[0]![2]).toContain(
        "云端转录任务可能继续运行并计费",
      );
      expect(telegram.editMessageText.mock.calls[0]![2]).not.toContain("已取消");
    },
  );

  it.each(["downloading", "converting"] as const)(
    "reports cancellation still draining local %s work",
    async (status) => {
      const { handler, telegram, transcription } = setup();
      vi.mocked(transcription.cancel).mockResolvedValue({
        ...pending,
        status,
        cancelRequested: true,
      });
      await handler(callback({ decision: "no" }));
      const message = telegram.editMessageText.mock.calls[0]![2];
      expect(message).toContain("正在停止本地音频处理");
      expect(message).not.toContain("已入队");
      expect(message).not.toContain("已取消");
    },
  );

  it("hides unexpected exceptions and tolerates Telegram edit failures", async () => {
    const { handler, telegram, transcription } = setup();
    vi.mocked(transcription.confirm).mockRejectedValue(new Error("Bearer synthetic-secret"));
    telegram.editMessageText.mockRejectedValue(new Error("message edit failed"));
    await expect(handler(callback())).resolves.toBe(true);
    expect(telegram.editMessageText.mock.calls[0]![2]).toContain("无法处理转录请求");
    expect(telegram.editMessageText.mock.calls[0]![2]).not.toContain("synthetic-secret");
  });

  it("does not claim unrelated callbacks and rejects malformed ASR data", async () => {
    const { handler, transcription } = setup();
    const ctx = callback();
    ctx.callbackQuery.data = "cos:gh:another:yes";
    await expect(handler(ctx)).resolves.toBe(false);
    for (const data of [
      "cos:asr:arbitrary:yes",
      `cos:asr:${ID}:maybe`,
      `cos:asr:${ID}:yes:extra`,
    ]) {
      ctx.callbackQuery.data = data;
      await expect(handler(ctx)).resolves.toBe(true);
    }
    expect(transcription.confirm).not.toHaveBeenCalled();
  });

  it("requires an actual Telegram message, so inline callbacks cannot select a destination", async () => {
    const { handler, transcription } = setup();
    const { message: _message, ...query } = callback().callbackQuery;
    await handler({ callbackQuery: query });
    expect(transcription.confirm).not.toHaveBeenCalled();
  });
});

describe("audio transcription administrator confirmation card", () => {
  it("discloses transfer, provider, duration, possible cost, cap, free quota and expiry in the original topic", async () => {
    const telegram = api();
    await sendMediaConfirmationMessage(
      telegram as unknown as Api,
      actor.chatId,
      pending,
      actor.threadId,
    );
    const [chatId, text, options] = telegram.sendMessage.mock.calls[0]!;
    expect(chatId).toBe(actor.chatId);
    for (const expected of [
      pending.title,
      "P2",
      "75 秒",
      "1.25 分钟",
      "腾讯云 / 16k_zh",
      "0.03 CNY",
      "0.1 CNY",
      pending.confirmation!.freeQuota,
      pending.confirmation!.expiresAt,
      "优先使用可用免费额度",
      "视频音轨发送至 腾讯云",
    ])
      expect(text).toContain(expected);
    expect(options).toEqual({
      message_thread_id: 9,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "确认转录（可能付费）", callback_data: `cos:asr:${ID}:yes` },
            { text: "取消", callback_data: `cos:asr:${ID}:no` },
          ],
        ],
      },
    });
    expect(options).not.toHaveProperty("parse_mode");
  });

  it("cannot send a confirmation card lacking a pending cost disclosure", async () => {
    const telegram = api();
    for (const job of [
      { ...pending, confirmation: undefined },
      { ...pending, status: "queued" as const },
    ]) {
      await expect(
        sendMediaConfirmationMessage(telegram as unknown as Api, actor.chatId, job),
      ).rejects.toThrow("media_confirmation_unavailable");
    }
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });
});
