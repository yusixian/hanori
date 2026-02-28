import { MAX_FILE_SIZE, resolveAndValidate } from "@cos-tool-bot/shared";
import type { CoreTool } from "ai";
import { tool } from "ai";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { zodToAiSchema } from "./utils.js";

export function createFileTools(opts: { dataDir: string }): Record<string, CoreTool> {
  const { dataDir } = opts;

  return {
    read_file: tool({
      description:
        "读取你的 data 目录中的文件内容。可以用来查看你自己的身份定义、笔记等文件。仅 .md 文件会被自动注入到你的 system prompt 中。",
      parameters: zodToAiSchema(
        z.object({
          path: z.string().describe("文件路径（相对于 data 目录），如 NOTES.md"),
        }),
      ),
      execute: async ({ path: filePath }) => {
        const resolved = resolveAndValidate(dataDir, filePath);
        if (!resolved) return { error: "Invalid path (only .md/.txt/.json allowed)" };
        try {
          const stat = await fs.stat(resolved);
          if (stat.size > MAX_FILE_SIZE) return { error: "File too large" };
          const content = await fs.readFile(resolved, "utf-8");
          return { ok: true, content };
        } catch {
          return { error: "File not found" };
        }
      },
    }),
    write_file: tool({
      description:
        "写入文件到你的 data 目录。可以创建新文件或覆盖已有文件。用于记录笔记、更新自己的设定等。仅支持 .md/.txt/.json 文件。",
      parameters: zodToAiSchema(
        z.object({
          path: z.string().describe("文件路径（相对于 data 目录），如 NOTES.md"),
          content: z.string().describe("要写入的文件内容"),
        }),
      ),
      execute: async ({ path: filePath, content }) => {
        const resolved = resolveAndValidate(dataDir, filePath);
        if (!resolved) return { error: "Invalid path (only .md/.txt/.json allowed)" };
        if (Buffer.byteLength(content, "utf-8") > MAX_FILE_SIZE) {
          return { error: "Content too large" };
        }
        try {
          await fs.mkdir(path.dirname(resolved), { recursive: true });
          await fs.writeFile(resolved, content, "utf-8");
          return { ok: true };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),
  };
}
