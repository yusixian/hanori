import {
  getTelegramCommandMetadata,
  type TelegramCommandAccess,
  type TelegramCommandLocale,
  type TelegramCommandMetadata,
  type TelegramCommandName,
} from "@cos-tool-bot/shared";
import type { CommandMiddleware, Context } from "grammy";

interface CommandTarget<C extends Context> {
  command(command: string, ...middleware: Array<CommandMiddleware<C>>): unknown;
}

export interface ActiveTelegramCommand extends TelegramCommandMetadata {
  effectiveAccess: TelegramCommandAccess;
}

const registries = new WeakMap<object, ActiveCommandRegistry<Context>>();

export class ActiveCommandRegistry<C extends Context> {
  readonly #active = new Map<TelegramCommandName, ActiveTelegramCommand>();

  constructor(private readonly target: CommandTarget<C>) {
    registries.set(target as object, this as unknown as ActiveCommandRegistry<Context>);
  }

  register(command: TelegramCommandName, ...middleware: Array<CommandMiddleware<C>>): void {
    this.#register(command, getTelegramCommandMetadata(command).access, middleware);
  }

  registerConfigurable(
    command: TelegramCommandName,
    effectiveAccess: "public" | "admin",
    ...middleware: Array<CommandMiddleware<C>>
  ): void {
    this.#register(command, effectiveAccess, middleware);
  }

  getActiveCommands(): ActiveTelegramCommand[] {
    return [...this.#active.values()];
  }

  getTelegramCommands(locale: TelegramCommandLocale = "zh-CN") {
    return this.getActiveCommands().map((metadata) => ({
      command: metadata.command,
      description: formatCommandDescription(metadata, locale),
    }));
  }

  #register(
    command: TelegramCommandName,
    effectiveAccess: TelegramCommandAccess,
    middleware: Array<CommandMiddleware<C>>,
  ): void {
    if (this.#active.has(command))
      throw new Error(`Telegram command already registered: ${command}`);
    if (middleware.length === 0) throw new Error(`Telegram command has no middleware: ${command}`);

    this.target.command(command, ...middleware);
    this.#active.set(command, {
      ...getTelegramCommandMetadata(command),
      effectiveAccess,
    });
  }
}

export function getActiveBotCommands(bot: object): ActiveTelegramCommand[] {
  return registries.get(bot)?.getActiveCommands() ?? [];
}

export function formatCommandDescription(
  metadata: ActiveTelegramCommand,
  locale: TelegramCommandLocale,
): string {
  const description = metadata.description[locale];
  return metadata.effectiveAccess === "admin" ? `(admin) ${description}` : description;
}
