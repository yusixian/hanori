import { expect, it, vi } from "vitest";
import { createSummaryCommand, type SummaryCallbacks } from "./summary.js";

function fixture(triggerManual: SummaryCallbacks["triggerManual"]) {
  const api = {
    deleteMessage: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 9 }),
    editMessageText: vi.fn().mockResolvedValue(true),
  };
  const ctx = {
    match: "",
    chat: { id: -1001 },
    from: { id: 42 },
    message: { message_id: 7 },
    reply: vi.fn().mockResolvedValue({ message_id: 8 }),
    api,
  };
  const handler = createSummaryCommand({
    botId: "bot",
    triggerManual,
    getAccessMode: async () => "all",
    adminChatIds: [42],
  });
  if (typeof handler !== "function") throw new Error("Expected a middleware function");
  return {
    ctx,
    api,
    run: () => handler(ctx as unknown as Parameters<typeof handler>[0], async () => {}),
  };
}

it("delivers through the service hook with the original HTML reply and status cleanup", async () => {
  const triggerManual = vi.fn<SummaryCallbacks["triggerManual"]>(async (opts) => {
    await opts.deliver!("<b>Summary</b>");
    return { ok: true, contentHtml: "<b>Summary</b>" };
  });
  const { api, run } = fixture(triggerManual);
  api.deleteMessage.mockRejectedValueOnce(new Error("already deleted"));
  await run();
  expect(triggerManual).toHaveBeenCalledWith(
    expect.objectContaining({
      skipSend: true,
      bypassCooldown: true,
      deliver: expect.any(Function),
    }),
  );
  expect(api.deleteMessage).toHaveBeenCalledExactlyOnceWith(-1001, 8);
  expect(api.sendMessage).toHaveBeenCalledExactlyOnceWith(-1001, "<b>Summary</b>", {
    parse_mode: "HTML",
    reply_parameters: { message_id: 7 },
  });
});

it("keeps delivery errors propagated to the Bot error handler", async () => {
  const { api, run } = fixture(async (opts) => {
    await opts.deliver!("summary");
    return { ok: true };
  });
  const failure = new Error("Telegram unavailable");
  api.sendMessage.mockRejectedValue(failure);
  await expect(run()).rejects.toBe(failure);
  expect(api.editMessageText).not.toHaveBeenCalled();
});

it("keeps generation failures on the status message", async () => {
  const { api, run } = fixture(async () => {
    throw new Error("database unavailable");
  });
  await run();
  expect(api.editMessageText).toHaveBeenCalledExactlyOnceWith(
    -1001,
    8,
    "总结失败：database unavailable",
  );
  expect(api.sendMessage).not.toHaveBeenCalled();
});
