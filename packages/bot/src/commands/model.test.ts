import { describe, expect, it, vi } from "vitest";
import type { WrapperContext } from "../context.js";
import { createModelCommand } from "./model.js";

function commandContext(match: string) {
  return {
    chat: { id: -100 },
    match,
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as WrapperContext;
}

function commandFunction(command: ReturnType<typeof createModelCommand>) {
  if (typeof command !== "function") throw new Error("Expected model command middleware function");
  return command;
}

describe("createModelCommand", () => {
  it("keeps the no-argument model listing read-only", async () => {
    const setModelForChat = vi.fn(async () => {});
    const resetModelForChat = vi.fn(async () => {});
    const ctx = commandContext("");
    const command = commandFunction(
      createModelCommand({
        getModelForChat: () => "model-a",
        setModelForChat,
        resetModelForChat,
        models: [{ id: "model-a", label: "Model A" }],
        defaultModel: "model-a",
      }),
    );

    await command(ctx as never, vi.fn());

    expect(setModelForChat).not.toHaveBeenCalled();
    expect(resetModelForChat).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("当前模型: `model-a`"), {
      parse_mode: "Markdown",
    });
  });

  it("awaits persistence before reporting a successful model change", async () => {
    let resolveMutation!: () => void;
    const mutation = new Promise<void>((resolve) => {
      resolveMutation = resolve;
    });
    const setModelForChat = vi.fn(() => mutation);
    const ctx = commandContext("2");
    const command = commandFunction(
      createModelCommand({
        getModelForChat: () => "model-a",
        setModelForChat,
        resetModelForChat: vi.fn(async () => {}),
        models: [
          { id: "model-a", label: "Model A" },
          { id: "model-b", label: "Model B" },
        ],
        defaultModel: "model-a",
      }),
    );

    const execution = command(ctx as never, vi.fn());
    await Promise.resolve();
    expect(ctx.reply).not.toHaveBeenCalled();

    resolveMutation();
    await execution;
    expect(setModelForChat).toHaveBeenCalledWith(-100, "model-b");
    expect(ctx.reply).toHaveBeenCalledWith("已切换到模型: `model-b`", {
      parse_mode: "Markdown",
    });
  });

  it("reports only a fixed safe error when model persistence fails", async () => {
    const ctx = commandContext("model-b");
    const command = commandFunction(
      createModelCommand({
        getModelForChat: () => "model-a",
        setModelForChat: vi.fn().mockRejectedValue(new Error("database host and token")),
        resetModelForChat: vi.fn(async () => {}),
        models: [
          { id: "model-a", label: "Model A" },
          { id: "model-b", label: "Model B" },
        ],
        defaultModel: "model-a",
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
      createModelCommand({
        getModelForChat: () => "model-b",
        setModelForChat: vi.fn(async () => {}),
        resetModelForChat: vi.fn().mockRejectedValue(new Error("private persistence failure")),
        models: [{ id: "model-a", label: "Model A" }],
        defaultModel: "model-a",
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

  it("rejects arbitrary model strings that are absent from the current provider list", async () => {
    const setModelForChat = vi.fn(async () => {});
    const ctx = commandContext("unlisted-model");
    const command = commandFunction(
      createModelCommand({
        getModelForChat: () => "model-a",
        setModelForChat,
        resetModelForChat: vi.fn(async () => {}),
        models: [{ id: "model-a", label: "Model A" }],
        defaultModel: "model-a",
      }),
    );

    await command(ctx as never, vi.fn());

    expect(setModelForChat).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      "未找到模型: `unlisted-model`\n使用 /model 查看可用列表",
      { parse_mode: "Markdown" },
    );
  });
});
