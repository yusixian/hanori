import type { CommandMiddleware, Context } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { ActiveCommandRegistry } from "./registry.js";

describe("ActiveCommandRegistry", () => {
  it("records exactly the commands accepted by the registration helper", () => {
    const command = vi.fn();
    const registry = new ActiveCommandRegistry<Context>({ command });
    const middleware: CommandMiddleware<Context> = () => {};

    registry.register("start", middleware);
    registry.registerConfigurable("model", "admin", middleware);

    expect(command.mock.calls.map(([name]) => name)).toEqual(["start", "model"]);
    expect(registry.getActiveCommands().map(({ command }) => command)).toEqual(["start", "model"]);
    expect(registry.getTelegramCommands()).toEqual([
      { command: "start", description: "显示欢迎信息" },
      { command: "model", description: "(admin) 查看或切换 AI 模型" },
    ]);
  });

  it("rejects duplicate registrations before they can drift", () => {
    const command = vi.fn();
    const registry = new ActiveCommandRegistry<Context>({ command });
    const middleware: CommandMiddleware<Context> = () => {};

    registry.register("help", middleware);

    expect(() => registry.register("help", middleware)).toThrow(
      "Telegram command already registered: help",
    );
    expect(command).toHaveBeenCalledTimes(1);
  });
});
