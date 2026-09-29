import type { CommandEntity } from "./bots.js";

export function parseParams(command: string): CommandEntity {
  if (!command)
    return {
      name: "",
      args: [],
      original_msg: "",
    };
  const cmd = command.trim();
  if (!cmd.match(/[\s\n]/))
    return {
      name: cmd.slice(1),
      args: [],
      original_msg: "",
    };

  const parts = cmd.split(/[\s\n]+/);
  const firstPart = parts[0] || "";
  const name = firstPart.slice(1);

  const commandEndIndex = cmd.indexOf(firstPart) + firstPart.length;
  const original_msg = cmd.slice(commandEndIndex).trim();
  const validArgsArr = parts.filter((v) => Boolean(v));
  if (!validArgsArr?.length || validArgsArr?.length === 1)
    return { name: command, args: [], original_msg };
  return {
    name,
    args: validArgsArr.slice(1),
    original_msg,
  };
}
