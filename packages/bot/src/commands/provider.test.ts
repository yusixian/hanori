import { describe, expect, it, vi } from "vitest";
import type { WrapperContext } from "../context.js";
import { createProviderCommand } from "./provider.js";

function commandContext(match: string) {
  return {
    chat: { id: -100 },
    match,
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as WrapperContext;
}

function commandFunction(command: ReturnType<typeof createProviderCommand>) {
  if (typeof command !== "function") {
    throw new Error("Expected provider command middleware function");
  }
  return command;
}

const providers = [
  { id: "provider-a", label: "Provider A", defaultModel: "model-a" },
  { id: "provider-b", label: "Provider B", defaultModel: "model-b" },
];

describe("createProviderCommand", () => {
  it("keeps the no-argument provider listing read-only", async () => {
    const setProviderForChat = vi.fn(async () => {});
    const resetProviderForChat = vi.fn(async () => {});
    const ctx = commandContext("");
    const command = commandFunction(
      createProviderCommand({
        getProviderForChat: () => "provider-a",
        setProviderForChat,
        resetProviderForChat,
        providers,
        defaultProviderId: "provider-a",
      }),
    );

    await command(ctx as never, vi.fn());

    expect(setProviderForChat).not.toHaveBeenCalled();
    expect(resetProviderForChat).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("当前 Provider: `Provider A`"), {
      parse_mode: "Markdown",
    });
  });

  it("awaits persistence before reporting a successful provider change", async () => {
    let resolveMutation!: () => void;
    const mutation = new Promise<void>((resolve) => {
      resolveMutation = resolve;
    });
    const setProviderForChat = vi.fn(() => mutation);
    const ctx = commandContext("2");
    const command = commandFunction(
      createProviderCommand({
        getProviderForChat: () => "provider-a",
        setProviderForChat,
        resetProviderForChat: vi.fn(async () => {}),
        providers,
        defaultProviderId: "provider-a",
      }),
    );

    const execution = command(ctx as never, vi.fn());
    await Promise.resolve();
    expect(ctx.reply).not.toHaveBeenCalled();

    resolveMutation();
    await execution;
    expect(setProviderForChat).toHaveBeenCalledWith(-100, "provider-b");
    expect(ctx.reply).toHaveBeenCalledWith("已切换到 Provider: `Provider B`", {
      parse_mode: "Markdown",
    });
  });

  it("reports only a fixed safe error when provider persistence fails", async () => {
    const ctx = commandContext("provider-b");
    const command = commandFunction(
      createProviderCommand({
        getProviderForChat: () => "provider-a",
        setProviderForChat: vi.fn().mockRejectedValue(new Error("private database failure")),
        resetProviderForChat: vi.fn(async () => {}),
        providers,
        defaultProviderId: "provider-a",
      }),
    );

    await command(ctx as never, vi.fn());

    expect(ctx.reply).toHaveBeenCalledOnce();
    expect(ctx.reply).toHaveBeenCalledWith("设置保存失败，请稍后重试。");
    expect(ctx.reply).not.toHaveBeenCalledWith(
      expect.stringContaining("已切换"),
      expect.anything(),
    );
    expect(ctx.reply).not.toHaveBeenCalledWith(expect.stringContaining("database"));
  });

  it("awaits reset persistence and does not claim success when reset fails", async () => {
    const ctx = commandContext("reset");
    const command = commandFunction(
      createProviderCommand({
        getProviderForChat: () => "provider-b",
        setProviderForChat: vi.fn(async () => {}),
        resetProviderForChat: vi.fn().mockRejectedValue(new Error("private persistence failure")),
        providers,
        defaultProviderId: "provider-a",
      }),
    );

    await command(ctx as never, vi.fn());

    expect(ctx.reply).toHaveBeenCalledOnce();
    expect(ctx.reply).toHaveBeenCalledWith("设置保存失败，请稍后重试。");
    expect(ctx.reply).not.toHaveBeenCalledWith(
      expect.stringContaining("已恢复"),
      expect.anything(),
    );
  });
});
