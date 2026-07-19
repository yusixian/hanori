import { describe, expect, test, vi } from "vitest";
import type { WrapperContext } from "../context.js";
import { createApiKeyCommand } from "./api-key.js";

type CommandRunner = (ctx: WrapperContext, next: () => Promise<void>) => Promise<void>;

function createCommand(
  updateApiKey: (target: "image" | "search", apiKey: string) => Promise<boolean>,
  onError?: (target: "image" | "search") => void | Promise<void>,
) {
  return createApiKeyCommand({ updateApiKey, onError }) as unknown as CommandRunner;
}

function createContext(match: string, chatType: "private" | "group" = "private") {
  return {
    chat: { type: chatType },
    match,
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

describe("createApiKeyCommand", () => {
  test("updates an image key without echoing it", async () => {
    const updateApiKey = vi.fn().mockResolvedValue(true);
    const ctx = createContext("image secret-value");

    await createCommand(updateApiKey)(ctx as unknown as WrapperContext, async () => {});

    expect(ctx.deleteMessage).toHaveBeenCalledOnce();
    expect(updateApiKey).toHaveBeenCalledWith("image", "secret-value");
    expect(ctx.reply).toHaveBeenCalledWith(
      "图片生成 API Key 已更新，超时的待处理任务将在后台自动恢复。",
    );
    expect(JSON.stringify(ctx.reply.mock.calls)).not.toContain("secret-value");
  });

  test("rejects group usage before reading the key", async () => {
    const updateApiKey = vi.fn();
    const ctx = createContext("search secret-value", "group");

    await createCommand(updateApiKey)(ctx as unknown as WrapperContext, async () => {});

    expect(updateApiKey).not.toHaveBeenCalled();
    expect(ctx.deleteMessage).toHaveBeenCalledOnce();
    expect(ctx.reply).toHaveBeenCalledWith(
      "请在与 Bot 的私聊中使用此命令。配置内容不会在群聊中处理。",
    );
  });

  test("shows usage for unsupported targets", async () => {
    const updateApiKey = vi.fn();
    const ctx = createContext("pixai secret-value");

    await createCommand(updateApiKey)(ctx as unknown as WrapperContext, async () => {});

    expect(updateApiKey).not.toHaveBeenCalled();
    expect(ctx.deleteMessage).toHaveBeenCalledOnce();
    expect(ctx.reply).toHaveBeenCalledWith("用法：/apikey image <key> 或 /apikey search <key>");
  });

  test("reports update failures without exposing the key", async () => {
    const updateApiKey = vi.fn().mockRejectedValue(new Error("database rejected secret-value"));
    const onError = vi.fn().mockResolvedValue(undefined);
    const ctx = createContext("search secret-value");

    await createCommand(updateApiKey, onError)(ctx as unknown as WrapperContext, async () => {});

    expect(onError).toHaveBeenCalledWith("search");
    expect(JSON.stringify(onError.mock.calls)).not.toContain("secret-value");
    expect(ctx.reply).toHaveBeenCalledWith("API Key 更新失败，请查看服务日志后重试。");
    expect(onError.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.reply.mock.invocationCallOrder[0]!,
    );
  });
});
