import { createHash } from "node:crypto";
import { bots, promptVersions, type Database } from "@cos-tool-bot/database";
import {
  assemblePromptPreview,
  resolveBotSkills,
  resolveBuiltInSkills,
  listBotSkills,
  snapshotDataFiles,
} from "@cos-tool-bot/bot";
import {
  DEFAULT_INJECTABLE_FILES,
  DEFAULT_MAX_INJECTION_SIZE,
  MAX_FILE_SIZE,
  type AiConfigStored,
  type PromptSnapshot,
  type PromptVersion,
} from "@cos-tool-bot/shared";
import { readFileBounded } from "@cos-tool-bot/shared/file-reader";
import { and, desc, eq, sql } from "drizzle-orm";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { getDataDir } from "../utils/file-validation.js";

const skillSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  displayName: z.string(),
  description: z.string(),
  summary: z.string(),
  source: z.string(),
  digest: z.string(),
  instructions: z.string(),
  resources: z.record(z.string(), z.string()),
  enabled: z.boolean(),
});
export const promptSnapshotSchema = z
  .object({
    systemPrompt: z.string(),
    behavioralPrompt: z.string(),
    groupBehavioralPrompt: z.string(),
    files: z.array(
      z.object({
        name: z.string().regex(/^[^/\\]+\.md$/),
        content: z
          .string()
          .refine((value) => Buffer.byteLength(value) <= MAX_FILE_SIZE, "File too large"),
        enabled: z.boolean(),
      }),
    ),
    maxInjectionBytes: z.number().int().min(0).max(1048576),
    skills: z.array(skillSchema),
  })
  .superRefine((value, ctx) => {
    for (const [key, names] of [
      ["files", value.files.map((file) => file.name)],
      ["skills", value.skills.map((skill) => skill.name)],
    ] as const)
      if (new Set(names).size !== names.length)
        ctx.addIssue({ code: "custom", path: [key], message: "Duplicate names" });
  });
export class PromptVersionError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409 = 409,
  ) {
    super(message);
  }
}
const view = (row: typeof promptVersions.$inferSelect): PromptVersion => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
});
export async function readActivePromptSnapshot(db: Database, botId: string) {
  const [row] = await db
    .select({ id: promptVersions.id, snapshot: promptVersions.snapshot })
    .from(bots)
    .leftJoin(
      promptVersions,
      and(eq(promptVersions.id, bots.activePromptVersionId), eq(promptVersions.botId, bots.id)),
    )
    .where(eq(bots.id, botId));
  return row?.id && row.snapshot ? { id: row.id, snapshot: row.snapshot } : null;
}
export async function captureWorkingPrompt(
  botId: string,
  config: AiConfigStored | null,
): Promise<PromptSnapshot> {
  const enabled = new Set(config?.dataFilesConfig?.injectableFiles ?? DEFAULT_INJECTABLE_FILES);
  const directory = getDataDir(botId);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    entries = [];
  }
  const included = new Set([...DEFAULT_INJECTABLE_FILES, ...enabled]);
  const names = entries
    .filter((name) => name.endsWith(".md") && included.has(name))
    .sort((a, b) => {
      const rank = (name: string) => (name === "IDENTITY.md" ? 0 : name === "SOUL.md" ? 1 : 2);
      return rank(a) - rank(b) || a.localeCompare(b);
    });
  const files = await Promise.all(
    names.map(async (name) => ({
      name,
      content: (await readFileBounded(join(directory, name), MAX_FILE_SIZE)).toString("utf8"),
      enabled: enabled.has(name),
    })),
  );
  const enabledSkills = new Set(resolveBotSkills(config?.skillConfig).map((skill) => skill.id));
  const builtins = resolveBuiltInSkills();
  const custom = listBotSkills(config?.skillConfig).customSkills;
  const all = [
    ...builtins,
    ...resolveBotSkills({
      enabledBuiltInIds: [],
      customSkills: custom.map((skill) => ({ ...skill, enabled: true })),
    }),
  ];
  return {
    systemPrompt: config?.systemPrompt ?? "",
    behavioralPrompt: config?.behavioralPrompt ?? "",
    groupBehavioralPrompt: config?.groupBehavioralPrompt ?? "",
    files,
    maxInjectionBytes: config?.dataFilesConfig?.maxTotalSize ?? DEFAULT_MAX_INJECTION_SIZE,
    skills: all.map((skill) => ({
      ...skill,
      resources: { ...skill.resources },
      enabled: enabledSkills.has(skill.id),
    })),
  };
}
export async function previewPromptSnapshot(
  snapshot: PromptSnapshot,
  config: AiConfigStored | null,
  botId: string,
) {
  const render = async (isPrivate: boolean) => {
    const result = await assemblePromptPreview({
      systemPrompt: snapshot.systemPrompt,
      behavioralPrompt: snapshot.behavioralPrompt,
      groupBehavioralPrompt: snapshot.groupBehavioralPrompt,
      isPrivate,
      memoryEnabled: config?.memoryConfig?.enabled ?? false,
      botMemoryEnabled: config?.botMemoryConfig?.enabled ?? false,
      stickerPacks: config?.stickerPacks,
      webToolsConfig: config?.webToolsConfig,
      unifiedSearchEnabled: config?.unifiedSearchEnabled !== false,
      agentToolsConfig: config?.agentToolsConfig,
      artworkToolsEnabled: config?.artworkToolsConfig?.enabled,
      hasFileTools: true,
      dataFiles: snapshotDataFiles(snapshot, getDataDir(botId)),
      messageConfig: config?.messageConfig,
      hasImageGeneration: true,
      skills: snapshot.skills.filter((skill) => skill.enabled),
      timerMaxSeconds: config?.executionConfig?.timerMaxSeconds,
    });
    return {
      fullPrompt: result.fullPrompt,
      estimatedTokens: result.estimatedTokens,
      sections: result.trace.sections.map((section) => ({
        id: section.id,
        estimatedTokens: section.estimatedTokens,
      })),
    };
  };
  return { private: await render(true), group: await render(false) };
}
export class PromptVersionService {
  constructor(
    private db: Database,
    private applicationVersion: string,
  ) {}
  async bot(botId: string) {
    const [bot] = await this.db.select().from(bots).where(eq(bots.id, botId));
    if (!bot) throw new PromptVersionError("Bot not found", 404);
    return bot;
  }
  async list(botId: string) {
    const bot = await this.bot(botId);
    const rows = await this.db
      .select({
        id: promptVersions.id,
        botId: promptVersions.botId,
        name: promptVersions.name,
        description: promptVersions.description,
        applicationVersion: promptVersions.applicationVersion,
        createdAt: promptVersions.createdAt,
        privateTokens: sql<number>`(${promptVersions.previews}->'private'->>'estimatedTokens')::integer`,
        groupTokens: sql<number>`(${promptVersions.previews}->'group'->>'estimatedTokens')::integer`,
      })
      .from(promptVersions)
      .where(eq(promptVersions.botId, botId))
      .orderBy(desc(promptVersions.createdAt));
    return {
      activeId: bot.activePromptVersionId,
      versions: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
    };
  }
  async get(botId: string, id: string) {
    await this.bot(botId);
    const [row] = await this.db
      .select()
      .from(promptVersions)
      .where(and(eq(promptVersions.botId, botId), eq(promptVersions.id, id)));
    if (!row) throw new PromptVersionError("Prompt version not found", 404);
    return view(row);
  }
  async working(botId: string) {
    const bot = await this.bot(botId);
    return {
      snapshot: await captureWorkingPrompt(botId, bot.aiConfig),
      activeId: bot.activePromptVersionId,
    };
  }
  async preview(botId: string, snapshot: PromptSnapshot) {
    const bot = await this.bot(botId);
    return previewPromptSnapshot(promptSnapshotSchema.parse(snapshot), bot.aiConfig, botId);
  }
  async create(
    botId: string,
    input: { name: string; description: string; snapshot: PromptSnapshot },
  ) {
    const bot = await this.bot(botId);
    const snapshot = promptSnapshotSchema.parse(input.snapshot);
    for (const skill of snapshot.skills) {
      const hash = createHash("sha256");
      hash.update(skill.instructions);
      for (const [name, content] of Object.entries(skill.resources).sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        hash.update("\0");
        hash.update(name);
        hash.update("\0");
        hash.update(content);
      }
      skill.digest = hash.digest("hex").slice(0, 12);
    }
    const previews = await previewPromptSnapshot(snapshot, bot.aiConfig, botId);
    const [row] = await this.db
      .insert(promptVersions)
      .values({
        botId,
        name: input.name,
        description: input.description,
        snapshot,
        previews,
        applicationVersion: this.applicationVersion,
      })
      .returning();
    return view(row!);
  }
  async activate(botId: string, id: string | null) {
    return this.db.transaction(async (tx) => {
      const [bot] = await tx.select().from(bots).where(eq(bots.id, botId)).for("update");
      if (!bot) throw new PromptVersionError("Bot not found", 404);
      if (id) {
        const [version] = await tx
          .select()
          .from(promptVersions)
          .where(and(eq(promptVersions.id, id), eq(promptVersions.botId, botId)));
        if (!version) throw new PromptVersionError("Prompt version not found", 404);
      }
      await tx.update(bots).set({ activePromptVersionId: id }).where(eq(bots.id, botId));
      return { activeId: id };
    });
  }
  async remove(botId: string, id: string) {
    await this.db.transaction(async (tx) => {
      const [bot] = await tx.select().from(bots).where(eq(bots.id, botId)).for("update");
      if (!bot) throw new PromptVersionError("Bot not found", 404);
      if (bot.activePromptVersionId === id)
        throw new PromptVersionError(
          "Switch to another version before deleting the active version",
        );
      const rows = await tx
        .delete(promptVersions)
        .where(and(eq(promptVersions.id, id), eq(promptVersions.botId, botId)))
        .returning({ id: promptVersions.id });
      if (!rows.length) throw new PromptVersionError("Prompt version not found", 404);
    });
  }
}
