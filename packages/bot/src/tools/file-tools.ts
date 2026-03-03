import { MAX_FILE_SIZE, TEXT_EXTENSIONS, resolveAndValidate } from "@cos-tool-bot/shared";
import type { Tool } from "ai";
import { tool } from "ai";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { zodToAiSchema } from "./utils.js";

export function createFileTools(opts: {
  dataDir: string;
  protectedFiles?: ReadonlySet<string>;
}): Record<string, Tool> {
  const { dataDir, protectedFiles } = opts;

  return {
    read_file: tool({
      description:
        "读取你的 data 目录中的文件内容。可以用来查看你自己的身份定义、笔记等文件。仅 .md 文件会被自动注入到你的 system prompt 中。",
      inputSchema: zodToAiSchema(
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
        "写入文件到你的 data 目录。可以创建新文件或覆盖已有文件。用于记录笔记、更新自己的设定等。",
      inputSchema: zodToAiSchema(
        z.object({
          path: z.string().describe("文件路径（相对于 data 目录），如 NOTES.md"),
          content: z.string().describe("要写入的文件内容"),
        }),
      ),
      execute: async ({ path: filePath, content }) => {
        const resolved = resolveAndValidate(dataDir, filePath);
        if (!resolved) return { error: "Invalid path" };
        const ext = path.extname(filePath).toLowerCase();
        if (!TEXT_EXTENSIONS.has(ext))
          return { error: "Only text files can be written (.md/.txt/.json/.csv/.xml/.html/.css)" };
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
    delete_file: tool({
      description: "删除你的 data 目录中的文件。用于清理不再需要的临时文件。",
      inputSchema: zodToAiSchema(
        z.object({
          path: z.string().describe("文件路径（相对于 data 目录）"),
        }),
      ),
      execute: async ({ path: filePath }) => {
        const resolved = resolveAndValidate(dataDir, filePath);
        if (!resolved) return { error: "Invalid path" };
        // Prevent deletion of files marked as injectable (system prompt files)
        const baseName = path.basename(filePath);
        if (protectedFiles?.has(baseName)) {
          return { error: "This file is protected (injectable) and cannot be deleted" };
        }
        try {
          await fs.unlink(resolved);
          // Recursively clean up empty parent directories (up to dataDir)
          let dir = path.dirname(resolved);
          while (dir !== dataDir && dir.startsWith(dataDir)) {
            const entries = await fs.readdir(dir);
            if (entries.length > 0) break;
            await fs.rmdir(dir);
            dir = path.dirname(dir);
          }
          return { ok: true };
        } catch (err: unknown) {
          const code = (err as NodeJS.ErrnoException).code;
          return { error: code === "ENOENT" ? "File not found" : "Failed to delete file" };
        }
      },
    }),
  };
}
