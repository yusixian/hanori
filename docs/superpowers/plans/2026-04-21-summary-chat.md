# Summary Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/summary` manual command + per-chat scheduled group chat summarization to cos-tool-bot, with Panel CRUD + history UI.

**Architecture:** Three new server services (`SummaryRunner` pure execution, `ChatSummaryService` cron + cooldown orchestration, `SummaryConfigService` CRUD) mirror the existing RSS service pattern. Two new Drizzle tables (`summary_configs` per-chat, `chat_summaries` append-only history). One new bot command delegates to `ChatSummaryService.triggerManual`. Panel adds `/summary` CRUD + history pages. Telegram HTML `<blockquote expandable>` wraps LLM markdown output reusing existing `format.ts` marked pipeline.

**Tech Stack:** pnpm monorepo, TypeScript ESM, Drizzle ORM + PostgreSQL, Hono RPC, grammy, OpenAI SDK (via `chat-model-store`), `ai` package (streamText), Marked → Telegram HTML, React 19 + Refine v4 + Tailwind v4, oxlint + oxfmt.

**Reference spec:** `docs/superpowers/specs/2026-04-21-summary-chat-design.md`

**Testing note:** Project has no test framework (CLAUDE.md). Steps use `pnpm typecheck` / `pnpm lint` / manual smoke tests instead of unit tests. Do NOT introduce vitest.

---

## File Structure

### Create

- `packages/server/src/services/summary-runner.ts` — pure execution, fetch/format/LLM/wrap
- `packages/server/src/services/summary-config-service.ts` — DB CRUD for `summary_configs`
- `packages/server/src/services/chat-summary-service.ts` — cron + triggerManual + fallback + optimistic lock
- `packages/server/src/services/summary-prompts.ts` — `DEFAULT_SUMMARY_SYSTEM_PROMPT` + message/link helpers
- `packages/server/src/routes/summary.ts` — 9 Hono endpoints, Zod validated
- `packages/bot/src/commands/summary.ts` — bot command + `parseSummaryArgs`
- `packages/panel/src/pages/summary/list.tsx`
- `packages/panel/src/pages/summary/form.tsx`
- `packages/panel/src/pages/summary/history.tsx`

### Modify

- `packages/database/src/schema.ts` — add 2 tables + `AiConfigJson.summaryConfig`
- `packages/database/drizzle/0023_<name>.sql` — migration (auto-generated)
- `packages/shared/src/types.ts` — add `SummaryMode` / `SummaryConfigRecord` / `ChatSummaryRecord` + `AiConfigStored.summaryConfig`
- `packages/shared/src/index.ts` — re-export new types if not wildcard
- `packages/bot/src/utils/format.ts` — export `renderMarkdownToTelegramHtml`
- `packages/bot/src/handlers/ai-reply.ts` — include `tgMessageId` in user-role save meta
- `packages/bot/src/index.ts` — accept `summaryService` in `BotConfig`, register summary command
- `packages/bot/src/commands/help.ts` — add `/summary` line
- `packages/server/src/app.ts` — chain `.route("/api/summary", …)` into `createApp`
- `packages/server/src/index.ts` — boot `ChatSummaryService`, wire into BotManager, shutdown hook
- `packages/server/src/services/bot-pool.ts` — pass `summaryService` into `createBot` config
- `packages/server/src/services/bot-manager.ts` — accept + propagate `summaryService`
- `packages/panel/src/main.tsx` — register Refine resource
- `packages/panel/src/pages/bots/show.tsx` (or equivalent bot detail) — add "总结" tab
- AI config form component — add "群聊总结" group (path identified during Task 14)

### One-file-one-responsibility

- `summary-runner.ts`: no cron, no DB writes beyond history + token_usage, no side effect on `summary_configs`
- `summary-config-service.ts`: no runner calls, no cron — only CRUD
- `chat-summary-service.ts`: orchestrator only, delegates fetch/LLM to Runner

---

## Task 1: Precheck + tgMessageId meta on user-role saves

**Files:**

- Modify: `packages/bot/src/handlers/ai-reply.ts:1411-1417` (user role save)
- Read-only: `packages/bot/src/services/continue-chat.ts:443-459` (assistant save — confirm no change needed)
- Read-only: `packages/server/src/services/bot-pool.ts:194-198` (addMessage/addMessages wiring)

**Why:** Summary output links messages using `t.me/c/<chatId>/<messageId>`. `meta.tgMessageId` must be populated for user-role rows so LLM can cite them. Context-role rows bundle multiple messages and are out of scope (`dispatchContent` tolerates missing tgMessageId gracefully).

- [ ] **Step 1: Read the user save site**

Open `packages/bot/src/handlers/ai-reply.ts` around line 1411. Confirm the `toSave.push({ chatId, role: "user", ... })` block exists without `meta.tgMessageId`.

- [ ] **Step 2: Add tgMessageId to user save meta**

Replace the user save block (lines ~1411-1417) with:

```ts
toSave.push({
  chatId,
  role: "user",
  content: rawContent || messageText,
  userId,
  userName,
  meta: { tgMessageId: ctx.message?.message_id },
});
```

(If `ctx.message` is named differently in that scope, use the same reference the surrounding code uses for the inbound message — check a few lines above. The Telegram update message is always accessible.)

- [ ] **Step 3: typecheck**

Run: `pnpm --filter @cos-tool-bot/bot typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/bot/src/handlers/ai-reply.ts
git commit -m "feat(conversation): store tgMessageId in user-role meta for summary linking"
```

---

## Task 2: Shared types

**Files:**

- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/index.ts` (if re-export list is explicit)

- [ ] **Step 1: Add SummaryMode and record types**

Append to `packages/shared/src/types.ts`:

```ts
// ─── Summary ───

export type SummaryMode =
  | { kind: "default" }
  | { kind: "recent"; count: number }
  | { kind: "hours"; hours: number }
  | { kind: "date"; day: "today" | "yesterday" };

export type SummaryTrigger = "manual" | "scheduled";
export type SummaryAccessMode = "all" | "admin";

export interface SummaryConfigRecord {
  id: number;
  botId: string;
  chatId: number;
  isActive: boolean;
  scheduleHour: number | null;
  scheduleMinute: number | null;
  windowHours: number;
  customPrompt: string | null;
  modelId: string | null;
  maxMessages: number | null;
  cooldownSeconds: number | null;
  accessMode: SummaryAccessMode;
  lastScheduledAt: string | null;
  lastManualAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatSummaryRecord {
  id: number;
  botId: string;
  chatId: number;
  trigger: SummaryTrigger;
  triggeredBy: number | null;
  windowStart: string;
  windowEnd: string;
  messageCount: number;
  modelId: string;
  content: string;
  promptTokens: number | null;
  completionTokens: number | null;
  durationMs: number | null;
  errorMessage: string | null;
  createdAt: string;
}
```

- [ ] **Step 2: Extend AiConfigStored with summaryConfig**

Find `AiConfigStored` in `packages/shared/src/types.ts`. Add a new optional field:

```ts
summaryConfig?: {
  enabled: boolean;
  defaultWindowHours: number;
  defaultMaxMessages: number;
  defaultCooldownSeconds: number;
  globalScheduleHour?: number;
  globalScheduleMinute?: number;
  modelId?: string;
  systemPrompt?: string;
  roleFilter?: Array<"user" | "context" | "assistant">;
  timezone?: string;
};
```

Keep the SYNC comment convention: if there is a `// SYNC:` line near `AiConfigStored` pointing to `packages/database/src/schema.ts`, leave it (we update schema next task).

- [ ] **Step 3: Re-export if needed**

Open `packages/shared/src/index.ts`. If it uses explicit re-exports (not wildcard), add `SummaryMode, SummaryTrigger, SummaryAccessMode, SummaryConfigRecord, ChatSummaryRecord` to the list.

- [ ] **Step 4: typecheck**

Run: `pnpm --filter @cos-tool-bot/shared typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/index.ts
git commit -m "feat(shared): add Summary* types and AiConfigStored.summaryConfig"
```

---

## Task 3: DB schema — two new tables + AiConfigJson extension

**Files:**

- Modify: `packages/database/src/schema.ts`

- [ ] **Step 1: Extend AiConfigJson**

In `packages/database/src/schema.ts`, find the `AiConfigJson` interface (near top of file). Add the matching `summaryConfig` field (mirror the `AiConfigStored` shape from Task 2):

```ts
summaryConfig?: {
  enabled: boolean;
  defaultWindowHours: number;
  defaultMaxMessages: number;
  defaultCooldownSeconds: number;
  globalScheduleHour?: number;
  globalScheduleMinute?: number;
  modelId?: string;
  systemPrompt?: string;
  roleFilter?: Array<"user" | "context" | "assistant">;
  timezone?: string;
};
```

- [ ] **Step 2: Add summaryConfigs table**

Append after the existing `rssItems` or similar table near the bottom of `packages/database/src/schema.ts`:

```ts
export const summaryConfigs = pgTable(
  "summary_configs",
  {
    id: serial("id").primaryKey(),
    botId: uuid("bot_id")
      .references(() => bots.id, { onDelete: "cascade" })
      .notNull(),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    scheduleHour: integer("schedule_hour"),
    scheduleMinute: integer("schedule_minute"),
    windowHours: integer("window_hours").notNull().default(24),
    customPrompt: text("custom_prompt"),
    modelId: text("model_id"),
    maxMessages: integer("max_messages"),
    cooldownSeconds: integer("cooldown_seconds"),
    accessMode: text("access_mode").notNull().default("all"),
    lastScheduledAt: timestamp("last_scheduled_at"),
    lastManualAt: timestamp("last_manual_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("summary_configs_bot_chat_uniq").on(t.botId, t.chatId)],
);
```

- [ ] **Step 3: Add chatSummaries table**

Append immediately below:

```ts
export const chatSummaries = pgTable(
  "chat_summaries",
  {
    id: serial("id").primaryKey(),
    botId: uuid("bot_id")
      .references(() => bots.id, { onDelete: "cascade" })
      .notNull(),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    trigger: text("trigger").notNull(),
    triggeredBy: bigint("triggered_by", { mode: "number" }),
    windowStart: timestamp("window_start").notNull(),
    windowEnd: timestamp("window_end").notNull(),
    messageCount: integer("message_count").notNull(),
    modelId: text("model_id").notNull(),
    content: text("content").notNull(),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    durationMs: integer("duration_ms"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("chat_summaries_bot_chat_idx").on(t.botId, t.chatId),
    index("chat_summaries_created_idx").on(t.createdAt),
  ],
);
```

- [ ] **Step 4: typecheck database package**

Run: `pnpm --filter @cos-tool-bot/database typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/database/src/schema.ts
git commit -m "feat(db): add summary_configs and chat_summaries tables"
```

---

## Task 4: Drizzle migration — generate + verify

**Files:**

- Create (auto): `packages/database/drizzle/0023_<name>.sql`
- Update: `packages/database/drizzle/meta/_journal.json`, `packages/database/drizzle/meta/0023_snapshot.json`

- [ ] **Step 1: Generate migration**

Run: `pnpm db:generate`
Expected: new file `packages/database/drizzle/0023_*.sql` + updated `meta/_journal.json` + new `meta/0023_snapshot.json`.

- [ ] **Step 2: Inspect migration SQL**

Open the new `0023_*.sql`. Verify it contains:

- `CREATE TABLE "summary_configs"` with all columns + cascade FK
- `CREATE UNIQUE INDEX "summary_configs_bot_chat_uniq"`
- `CREATE TABLE "chat_summaries"` with cascade FK
- `CREATE INDEX "chat_summaries_bot_chat_idx"` + `chat_summaries_created_idx`

If columns or indexes missing, schema mismatch — fix `packages/database/src/schema.ts` and re-run `pnpm db:generate`.

- [ ] **Step 3: Apply migration to dev DB**

Ensure dev DB running: `docker compose -f docker-compose.dev.yml up -d` (if not already up).
Run: `pnpm db:migrate`
Expected: migration applied without error.

- [ ] **Step 4: Spot check via psql or db UI**

Confirm tables exist. Optional: `psql $DATABASE_URL -c "\d summary_configs" -c "\d chat_summaries"`

- [ ] **Step 5: Commit**

```bash
git add packages/database/drizzle/
git commit -m "feat(db): migration for summary_configs and chat_summaries"
```

---

## Task 5: Export renderMarkdownToTelegramHtml from format.ts

**Files:**

- Modify: `packages/bot/src/utils/format.ts`

- [ ] **Step 1: Identify current exports**

Open `packages/bot/src/utils/format.ts`. The file uses `marked + telegramRenderer`. Find the function that takes a markdown string and returns Telegram HTML. It may already be exported under a different name (`mdToTgHtml`, `formatToTelegram`, etc.).

- [ ] **Step 2: Add re-export alias if needed**

If existing function already has a name like `renderToTgHtml`, add an exported alias at the bottom:

```ts
export { renderToTgHtml as renderMarkdownToTelegramHtml };
```

If no such function exists, add:

```ts
const marked = new Marked(telegramRenderer);
export function renderMarkdownToTelegramHtml(md: string): string {
  return marked.parse(md, { async: false }) as string;
}
```

Pick whichever matches actual file state. Do not duplicate logic.

- [ ] **Step 3: Verify escapeHtml also exported** (needed by runner for usernames)

Confirm `export function escapeHtml(text: string): string {` already exported. It is at line 3 per inspection. Done.

- [ ] **Step 4: typecheck**

Run: `pnpm --filter @cos-tool-bot/bot typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/bot/src/utils/format.ts
git commit -m "feat(bot): export renderMarkdownToTelegramHtml for summary runner"
```

---

## Task 6: Summary prompts + helpers module

**Files:**

- Create: `packages/server/src/services/summary-prompts.ts`

- [ ] **Step 1: Create module**

Write `packages/server/src/services/summary-prompts.ts`:

```ts
import { escapeHtml, renderMarkdownToTelegramHtml } from "@cos-tool-bot/bot/utils/format";

export const DEFAULT_SUMMARY_SYSTEM_PROMPT = `你是群聊概括助手。以符合群聊风格的语气概括对话内容。

对话按以下格式提供：
====================
用户名:
发言内容
[图片] / [文件:文件名] / 消息链接
====================

指南：
1. 多个主题分条概括（用 markdown 列表或编号）
2. 提到图片/文件用占位描述，不编造内容
3. 引用具体消息用 markdown 链接：[引用1](消息链接)、[关键词](消息链接)
4. 开头固定："**本次群聊总结如下：**"
5. 不要使用 markdown 引用块（>），保持纯段落/列表/链接`;

export const DEFAULT_WINDOW_HOURS = 24;
export const DEFAULT_MAX_MESSAGES = 2000;
export const DEFAULT_COOLDOWN_SECONDS = 300;
export const DEFAULT_TIMEZONE = "Asia/Shanghai";
export const DEFAULT_ROLE_FILTER = ["user", "context", "assistant"] as const;
export const MIN_MESSAGES_FOR_SUMMARY = 5;
export const MAX_COUNT = 2000;
export const MAX_HOURS = 72;

export function messageLink(chatId: number, tgMessageId?: number | null): string {
  if (!tgMessageId) return "";
  const s = String(chatId);
  const short = s.startsWith("-100") ? s.slice(4) : String(Math.abs(chatId));
  return `https://t.me/c/${short}/${tgMessageId}`;
}

export interface FormattableMessage {
  userName: string | null;
  content: string;
  meta: unknown;
}

export function dispatchContent(content: string, meta: unknown): string {
  const m = meta as {
    photoFileId?: string;
    documentFileName?: string;
    replyToMessageId?: number;
  } | null;
  if (m?.photoFileId) return "[图片]" + (content ? ` ${content}` : "");
  if (m?.documentFileName) return `[文件:${m.documentFileName}]`;
  if (m?.replyToMessageId) return `（回复消息 id ${m.replyToMessageId}）${content}`;
  return content.length > 2000 ? content.slice(0, 2000) + "…" : content;
}

export function formatMessages(msgs: FormattableMessage[], chatId: number): string {
  return msgs
    .map((m) => {
      const tgId = (m.meta as { tgMessageId?: number } | null)?.tgMessageId;
      const link = messageLink(chatId, tgId);
      const body = dispatchContent(m.content, m.meta);
      const name = m.userName ?? "未知";
      return `====================\n${name}:\n${body}${link ? "\n" + link : ""}`;
    })
    .join("\n");
}

export function wrapSummaryHtml(llmMarkdown: string): string {
  const inner = renderMarkdownToTelegramHtml(llmMarkdown).trim();
  return `<blockquote expandable>${inner}</blockquote>`;
}

export { escapeHtml };
```

Note the `@cos-tool-bot/bot/utils/format` import path: verify `packages/bot/package.json` exports this subpath. If package `exports` map does NOT expose `./utils/format`, either:

- Add subpath export in `packages/bot/package.json` `exports`, OR
- Move `renderMarkdownToTelegramHtml` + `escapeHtml` into `packages/shared/src/format.ts` (preferred — pure functions, belongs in shared), import from shared here.

Check Task 5 result and pick once. If moving to shared, update Task 5's changes to live in shared and re-export from bot for backward compat.

- [ ] **Step 2: Decide import path and finalize**

Run: `cat packages/bot/package.json | grep -A 5 '"exports"'`
If no `./utils/format` subpath, move the exports to `packages/shared/src/format.ts` and adjust this module's import. Commit the move separately.

- [ ] **Step 3: typecheck**

Run: `pnpm --filter @cos-tool-bot/server typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/services/summary-prompts.ts
git commit -m "feat(server): add summary prompt constants and message formatters"
```

---

## Task 7: SummaryRunner

**Files:**

- Create: `packages/server/src/services/summary-runner.ts`

- [ ] **Step 1: Write module**

```ts
import type { Database } from "@cos-tool-bot/database";
import { chatSummaries, conversationMessages, tokenUsage } from "@cos-tool-bot/database";
import type { SummaryMode, SummaryTrigger } from "@cos-tool-bot/shared";
import { and, asc, between, eq, inArray } from "drizzle-orm";
import type { Logger } from "pino";
import {
  DEFAULT_MAX_MESSAGES,
  DEFAULT_ROLE_FILTER,
  DEFAULT_SUMMARY_SYSTEM_PROMPT,
  DEFAULT_TIMEZONE,
  DEFAULT_WINDOW_HOURS,
  MAX_COUNT,
  MAX_HOURS,
  MIN_MESSAGES_FOR_SUMMARY,
  formatMessages,
  wrapSummaryHtml,
} from "./summary-prompts.js";
import type { ChatModelStore } from "./chat-model-store.js";

export interface RunOptions {
  botId: string;
  chatId: number;
  mode: SummaryMode;
  trigger: SummaryTrigger;
  triggeredBy?: number;
  configOverrides?: {
    customPrompt?: string | null;
    modelId?: string | null;
    maxMessages?: number | null;
  };
}

export type RunError = "too_few_messages" | "llm_failed" | "disabled" | "no_context";

export interface RunResult {
  ok: boolean;
  summaryId?: number;
  contentHtml?: string;
  contentRaw?: string;
  messageCount: number;
  error?: RunError;
  errorDetail?: string;
}

interface AiCfg {
  enabled: boolean;
  model: string;
  summaryConfig?: {
    enabled?: boolean;
    defaultWindowHours?: number;
    defaultMaxMessages?: number;
    modelId?: string;
    systemPrompt?: string;
    roleFilter?: Array<"user" | "context" | "assistant">;
    timezone?: string;
  };
  conversationConfig?: {
    saveGroupContext?: "all" | "random_only" | "none";
  };
}

export class SummaryRunner {
  constructor(
    private db: Database,
    private logger: Logger,
    private chatModelStore: ChatModelStore,
    private getAiConfig: (botId: string) => Promise<AiCfg | null>,
  ) {}

  async run(opts: RunOptions): Promise<RunResult> {
    const cfg = await this.getAiConfig(opts.botId);
    if (!cfg || cfg.summaryConfig?.enabled === false) {
      return { ok: false, error: "disabled", messageCount: 0 };
    }

    const { windowStart, windowEnd, limit } = this.resolveWindow(opts, cfg);
    const roleFilter = cfg.summaryConfig?.roleFilter ?? [...DEFAULT_ROLE_FILTER];

    const msgs = await this.fetchMessages(
      opts.botId,
      opts.chatId,
      windowStart,
      windowEnd,
      limit,
      roleFilter,
    );

    if (msgs.length < MIN_MESSAGES_FOR_SUMMARY) {
      const sumRow = await this.writeHistory({
        opts,
        windowStart,
        windowEnd,
        messageCount: msgs.length,
        modelId: this.pickModel(opts, cfg),
        content: "",
        errorMessage: "too_few_messages",
        durationMs: 0,
      });
      return {
        ok: false,
        error: "too_few_messages",
        messageCount: msgs.length,
        summaryId: sumRow.id,
      };
    }

    const formatted = formatMessages(
      msgs.map((m) => ({ userName: m.userName, content: m.content, meta: m.meta })),
      opts.chatId,
    );
    const systemPrompt =
      opts.configOverrides?.customPrompt ??
      cfg.summaryConfig?.systemPrompt ??
      DEFAULT_SUMMARY_SYSTEM_PROMPT;
    const modelId = this.pickModel(opts, cfg);

    const startedAt = Date.now();
    try {
      const client = await this.chatModelStore.createClient(opts.botId, opts.chatId);
      const completion = await client.chat.completions.create({
        model: modelId,
        temperature: 0.4,
        max_tokens: 4096,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: formatted },
        ],
      });
      const raw = completion.choices[0]?.message.content ?? "";
      const durationMs = Date.now() - startedAt;
      const usage = completion.usage;

      if (!raw.trim()) {
        const sumRow = await this.writeHistory({
          opts,
          windowStart,
          windowEnd,
          messageCount: msgs.length,
          modelId,
          content: "",
          errorMessage: "empty_response",
          durationMs,
          promptTokens: usage?.prompt_tokens,
          completionTokens: usage?.completion_tokens,
        });
        return {
          ok: false,
          error: "llm_failed",
          errorDetail: "empty_response",
          messageCount: msgs.length,
          summaryId: sumRow.id,
        };
      }

      const contentHtml = wrapSummaryHtml(raw);
      const sumRow = await this.writeHistory({
        opts,
        windowStart,
        windowEnd,
        messageCount: msgs.length,
        modelId,
        content: raw,
        durationMs,
        promptTokens: usage?.prompt_tokens,
        completionTokens: usage?.completion_tokens,
      });
      await this.writeTokenUsage(opts, modelId, usage, durationMs);

      return {
        ok: true,
        summaryId: sumRow.id,
        contentHtml,
        contentRaw: raw,
        messageCount: msgs.length,
      };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn({ err, botId: opts.botId, chatId: opts.chatId }, "Summary LLM call failed");
      const sumRow = await this.writeHistory({
        opts,
        windowStart,
        windowEnd,
        messageCount: msgs.length,
        modelId,
        content: "",
        errorMessage: detail.slice(0, 500),
        durationMs,
      });
      return {
        ok: false,
        error: "llm_failed",
        errorDetail: detail,
        messageCount: msgs.length,
        summaryId: sumRow.id,
      };
    }
  }

  private pickModel(opts: RunOptions, cfg: AiCfg): string {
    return opts.configOverrides?.modelId || cfg.summaryConfig?.modelId || cfg.model;
  }

  private resolveWindow(
    opts: RunOptions,
    cfg: AiCfg,
  ): { windowStart: Date; windowEnd: Date; limit: number } {
    const limit = Math.min(
      opts.configOverrides?.maxMessages ??
        cfg.summaryConfig?.defaultMaxMessages ??
        DEFAULT_MAX_MESSAGES,
      MAX_COUNT,
    );
    const now = new Date();
    const defaultHours = cfg.summaryConfig?.defaultWindowHours ?? DEFAULT_WINDOW_HOURS;
    const tz = cfg.summaryConfig?.timezone ?? DEFAULT_TIMEZONE;

    switch (opts.mode.kind) {
      case "default":
        return {
          windowStart: new Date(now.getTime() - defaultHours * 3600_000),
          windowEnd: now,
          limit,
        };
      case "hours": {
        const h = Math.min(opts.mode.hours, MAX_HOURS);
        return { windowStart: new Date(now.getTime() - h * 3600_000), windowEnd: now, limit };
      }
      case "recent":
        return {
          windowStart: new Date(now.getTime() - MAX_HOURS * 3600_000),
          windowEnd: now,
          limit: Math.min(opts.mode.count, limit),
        };
      case "date": {
        const target = opts.mode.day === "today" ? 0 : -1;
        const { start, end } = dayRangeInTz(now, target, tz);
        return { windowStart: start, windowEnd: end, limit };
      }
    }
  }

  private async fetchMessages(
    botId: string,
    chatId: number,
    windowStart: Date,
    windowEnd: Date,
    limit: number,
    roleFilter: string[],
  ) {
    return this.db
      .select({
        id: conversationMessages.id,
        role: conversationMessages.role,
        content: conversationMessages.content,
        userName: conversationMessages.userName,
        meta: conversationMessages.meta,
        createdAt: conversationMessages.createdAt,
      })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.botId, botId),
          eq(conversationMessages.chatId, chatId),
          inArray(conversationMessages.role, roleFilter),
          between(conversationMessages.createdAt, windowStart, windowEnd),
        ),
      )
      .orderBy(asc(conversationMessages.id))
      .limit(limit);
  }

  private async writeHistory(params: {
    opts: RunOptions;
    windowStart: Date;
    windowEnd: Date;
    messageCount: number;
    modelId: string;
    content: string;
    errorMessage?: string;
    durationMs: number;
    promptTokens?: number | null;
    completionTokens?: number | null;
  }) {
    const [row] = await this.db
      .insert(chatSummaries)
      .values({
        botId: params.opts.botId,
        chatId: params.opts.chatId,
        trigger: params.opts.trigger,
        triggeredBy: params.opts.triggeredBy ?? null,
        windowStart: params.windowStart,
        windowEnd: params.windowEnd,
        messageCount: params.messageCount,
        modelId: params.modelId,
        content: params.content,
        errorMessage: params.errorMessage ?? null,
        durationMs: params.durationMs,
        promptTokens: params.promptTokens ?? null,
        completionTokens: params.completionTokens ?? null,
      })
      .returning({ id: chatSummaries.id });
    return row!;
  }

  private async writeTokenUsage(
    opts: RunOptions,
    modelId: string,
    usage:
      | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
      | undefined,
    durationMs: number,
  ) {
    if (!usage) return;
    await this.db.insert(tokenUsage).values({
      botId: opts.botId,
      chatId: opts.chatId,
      userId: opts.triggeredBy ?? null,
      model: modelId,
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      totalTokens: usage.total_tokens ?? 0,
      durationMs,
      trigger: "summary",
    });
  }
}

function dayRangeInTz(now: Date, offsetDays: number, tz: string): { start: Date; end: Date } {
  // Compute local-midnight in tz for (today + offsetDays), convert to UTC Date.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const local = new Date(now.getTime() + offsetDays * 86400_000);
  const parts = fmt.formatToParts(local);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  const startIso = `${y}-${m}-${d}T00:00:00`;
  const endIso = `${y}-${m}-${d}T23:59:59.999`;
  // Interpret the local-time ISO string as being in tz: use a probe to compute offset.
  const startUtc = zonedToUtc(startIso, tz);
  const endUtc = zonedToUtc(endIso, tz);
  return { start: startUtc, end: endUtc };
}

function zonedToUtc(isoLocal: string, tz: string): Date {
  // Approximate: parse as UTC, then correct by the tz offset at that instant.
  const naive = new Date(isoLocal + "Z");
  const probe = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = probe.formatToParts(naive).reduce<Record<string, string>>((acc, p) => {
    if (p.type !== "literal") acc[p.type] = p.value;
    return acc;
  }, {});
  const asTz = Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    +parts.hour,
    +parts.minute,
    +parts.second,
  );
  const offsetMs = asTz - naive.getTime();
  return new Date(naive.getTime() - offsetMs);
}
```

- [ ] **Step 2: typecheck**

Run: `pnpm --filter @cos-tool-bot/server typecheck`
Expected: no errors.

If `ChatModelStore` type differs (check `packages/server/src/services/chat-model-store.ts` for actual class name and method signature), adjust the runner's import and the `createClient` call signature.

- [ ] **Step 3: Spot-check tz math**

Manual: add a throwaway `console.log(dayRangeInTz(new Date(), 0, "Asia/Shanghai"))` in a REPL (or a temporary script), confirm start is local 00:00 and end is local 23:59:59.999. Remove after check.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/services/summary-runner.ts
git commit -m "feat(server): add SummaryRunner for fetching, formatting, and LLM summarization"
```

---

## Task 8: SummaryConfigService (CRUD)

**Files:**

- Create: `packages/server/src/services/summary-config-service.ts`

- [ ] **Step 1: Write module**

```ts
import type { Database } from "@cos-tool-bot/database";
import { summaryConfigs } from "@cos-tool-bot/database";
import type { SummaryAccessMode, SummaryConfigRecord } from "@cos-tool-bot/shared";
import { and, eq } from "drizzle-orm";

function toRecord(r: typeof summaryConfigs.$inferSelect): SummaryConfigRecord {
  return {
    id: r.id,
    botId: r.botId,
    chatId: r.chatId,
    isActive: r.isActive,
    scheduleHour: r.scheduleHour,
    scheduleMinute: r.scheduleMinute,
    windowHours: r.windowHours,
    customPrompt: r.customPrompt,
    modelId: r.modelId,
    maxMessages: r.maxMessages,
    cooldownSeconds: r.cooldownSeconds,
    accessMode: r.accessMode as SummaryAccessMode,
    lastScheduledAt: r.lastScheduledAt?.toISOString() ?? null,
    lastManualAt: r.lastManualAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt?.toISOString() ?? r.createdAt.toISOString(),
  };
}

export class SummaryConfigService {
  constructor(private db: Database) {}

  async list(botId: string): Promise<SummaryConfigRecord[]> {
    const rows = await this.db.select().from(summaryConfigs).where(eq(summaryConfigs.botId, botId));
    return rows.map(toRecord);
  }

  async get(id: number): Promise<SummaryConfigRecord | null> {
    const [row] = await this.db.select().from(summaryConfigs).where(eq(summaryConfigs.id, id));
    return row ? toRecord(row) : null;
  }

  async getByChat(botId: string, chatId: number): Promise<SummaryConfigRecord | null> {
    const [row] = await this.db
      .select()
      .from(summaryConfigs)
      .where(and(eq(summaryConfigs.botId, botId), eq(summaryConfigs.chatId, chatId)));
    return row ? toRecord(row) : null;
  }

  async create(params: {
    botId: string;
    chatId: number;
    isActive?: boolean;
    scheduleHour?: number | null;
    scheduleMinute?: number | null;
    windowHours?: number;
    customPrompt?: string | null;
    modelId?: string | null;
    maxMessages?: number | null;
    cooldownSeconds?: number | null;
    accessMode?: SummaryAccessMode;
  }): Promise<SummaryConfigRecord> {
    const [row] = await this.db
      .insert(summaryConfigs)
      .values({
        botId: params.botId,
        chatId: params.chatId,
        isActive: params.isActive ?? true,
        scheduleHour: params.scheduleHour ?? null,
        scheduleMinute: params.scheduleMinute ?? null,
        windowHours: params.windowHours ?? 24,
        customPrompt: params.customPrompt ?? null,
        modelId: params.modelId ?? null,
        maxMessages: params.maxMessages ?? null,
        cooldownSeconds: params.cooldownSeconds ?? null,
        accessMode: params.accessMode ?? "all",
      })
      .returning();
    return toRecord(row!);
  }

  async update(
    id: number,
    updates: Partial<{
      isActive: boolean;
      scheduleHour: number | null;
      scheduleMinute: number | null;
      windowHours: number;
      customPrompt: string | null;
      modelId: string | null;
      maxMessages: number | null;
      cooldownSeconds: number | null;
      accessMode: SummaryAccessMode;
    }>,
  ): Promise<SummaryConfigRecord | null> {
    const [row] = await this.db
      .update(summaryConfigs)
      .set(updates)
      .where(eq(summaryConfigs.id, id))
      .returning();
    return row ? toRecord(row) : null;
  }

  async delete(id: number): Promise<boolean> {
    const deleted = await this.db
      .delete(summaryConfigs)
      .where(eq(summaryConfigs.id, id))
      .returning({ id: summaryConfigs.id });
    return deleted.length > 0;
  }
}
```

- [ ] **Step 2: typecheck**

Run: `pnpm --filter @cos-tool-bot/server typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/services/summary-config-service.ts
git commit -m "feat(server): add SummaryConfigService CRUD"
```

---

## Task 9: ChatSummaryService (cron + triggerManual + fallback)

**Files:**

- Create: `packages/server/src/services/chat-summary-service.ts`

- [ ] **Step 1: Write module**

```ts
import type { Database } from "@cos-tool-bot/database";
import { chatSummaries, conversationMessages, summaryConfigs } from "@cos-tool-bot/database";
import type { SummaryMode } from "@cos-tool-bot/shared";
import { and, count, eq, gte, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { Logger } from "pino";
import {
  DEFAULT_COOLDOWN_SECONDS,
  DEFAULT_WINDOW_HOURS,
  MIN_MESSAGES_FOR_SUMMARY,
} from "./summary-prompts.js";
import type { SummaryRunner } from "./summary-runner.js";

const CHECK_INTERVAL_MS = 60_000;

export type SendSummaryFn = (botId: string, chatId: number, html: string) => Promise<void>;

export type IsBotRunningFn = (botId: string) => boolean;

interface GlobalSummaryCfg {
  enabled: boolean;
  globalScheduleHour?: number;
  globalScheduleMinute?: number;
}

interface BotCfgAccessor {
  (botId: string): Promise<GlobalSummaryCfg | null>;
}

export type ManualReason =
  | "cooldown"
  | "disabled"
  | "no_access"
  | "too_few_messages"
  | "llm_failed";

export class ChatSummaryService {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private db: Database,
    private logger: Logger,
    private runner: SummaryRunner,
    private send: SendSummaryFn,
    private isBotRunning: IsBotRunningFn,
    private getBotSummaryCfg: BotCfgAccessor,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, CHECK_INTERVAL_MS);
    this.timer.unref();
    this.logger.info("ChatSummaryService started");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.logger.info("ChatSummaryService stopped");
  }

  async triggerManual(opts: {
    botId: string;
    chatId: number;
    userId: number;
    mode: SummaryMode;
    bypassCooldown?: boolean;
  }): Promise<{ ok: boolean; reason?: ManualReason; summaryId?: number; contentHtml?: string }> {
    if (!this.isBotRunning(opts.botId)) {
      return { ok: false, reason: "disabled" };
    }
    const cfg = await this.getBotSummaryCfg(opts.botId);
    if (!cfg?.enabled) {
      return { ok: false, reason: "disabled" };
    }

    const [row] = await this.db
      .select()
      .from(summaryConfigs)
      .where(and(eq(summaryConfigs.botId, opts.botId), eq(summaryConfigs.chatId, opts.chatId)));

    // Access check
    if (row && row.accessMode === "admin") {
      // Real admin check is done in command layer (needs bot adminChatIds);
      // here we trust caller (command verified already). Callers MUST check.
    }

    // Cooldown check (bypass for panel admin button)
    if (!opts.bypassCooldown && row) {
      const cooldownSeconds = row.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS;
      if (row.lastManualAt) {
        const elapsed = Date.now() - row.lastManualAt.getTime();
        if (elapsed < cooldownSeconds * 1000) {
          return { ok: false, reason: "cooldown" };
        }
      }
    }

    // Optimistic update for lastManualAt before running (race protection)
    if (row) {
      await this.db
        .update(summaryConfigs)
        .set({ lastManualAt: new Date() })
        .where(eq(summaryConfigs.id, row.id));
    }

    const result = await this.runner.run({
      botId: opts.botId,
      chatId: opts.chatId,
      mode: opts.mode,
      trigger: "manual",
      triggeredBy: opts.userId,
      configOverrides: row
        ? {
            customPrompt: row.customPrompt,
            modelId: row.modelId,
            maxMessages: row.maxMessages,
          }
        : undefined,
    });

    if (!result.ok) {
      return {
        ok: false,
        reason: (result.error as ManualReason) ?? "llm_failed",
        summaryId: result.summaryId,
      };
    }

    await this.send(opts.botId, opts.chatId, result.contentHtml!);
    return { ok: true, summaryId: result.summaryId, contentHtml: result.contentHtml };
  }

  private async tick(): Promise<void> {
    try {
      await this.processScheduledConfigs();
      await this.processGlobalFallbacks();
    } catch (err) {
      this.logger.error({ err }, "ChatSummaryService tick failed");
    }
  }

  private async processScheduledConfigs(): Promise<void> {
    const now = new Date();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    const twentyThreeHoursAgo = new Date(now.getTime() - 23 * 3600_000);

    const candidates = await this.db
      .select()
      .from(summaryConfigs)
      .where(
        and(
          eq(summaryConfigs.isActive, true),
          eq(summaryConfigs.scheduleHour, hour),
          eq(summaryConfigs.scheduleMinute, minute),
          or(
            isNull(summaryConfigs.lastScheduledAt),
            lt(summaryConfigs.lastScheduledAt, twentyThreeHoursAgo),
          ),
        ),
      );

    for (const cfg of candidates) {
      if (!this.isBotRunning(cfg.botId)) continue;

      // Optimistic lock: only proceed if the row is still stale
      const updated = await this.db
        .update(summaryConfigs)
        .set({ lastScheduledAt: now })
        .where(
          and(
            eq(summaryConfigs.id, cfg.id),
            or(
              isNull(summaryConfigs.lastScheduledAt),
              lt(summaryConfigs.lastScheduledAt, twentyThreeHoursAgo),
            ),
          ),
        )
        .returning({ id: summaryConfigs.id });

      if (updated.length === 0) continue; // another instance already took it

      const result = await this.runner.run({
        botId: cfg.botId,
        chatId: cfg.chatId,
        mode: { kind: "hours", hours: cfg.windowHours },
        trigger: "scheduled",
        configOverrides: {
          customPrompt: cfg.customPrompt,
          modelId: cfg.modelId,
          maxMessages: cfg.maxMessages,
        },
      });

      if (result.ok && result.contentHtml) {
        try {
          await this.send(cfg.botId, cfg.chatId, result.contentHtml);
        } catch (err) {
          this.logger.warn(
            { err, botId: cfg.botId, chatId: cfg.chatId },
            "Failed to send scheduled summary",
          );
        }
      } else {
        this.logger.info(
          { botId: cfg.botId, chatId: cfg.chatId, error: result.error },
          "Scheduled summary skipped",
        );
      }
    }
  }

  private async processGlobalFallbacks(): Promise<void> {
    const now = new Date();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();

    // Find bots with global schedule matching current minute
    // Requires access to bot list + aiConfig — fetched via BotCfgAccessor extended with getAllBots.
    // For simplicity, this path is skipped in v1 and left as a hook for future iteration.
    // v1 scope: per-chat configs only (processScheduledConfigs).
    // To enable: iterate bots, check globalScheduleHour/Minute, select chats with ≥5 msgs in last 24h
    // that have NO summary_configs row, and trigger with default settings.
    //
    // Intentional placeholder in v1 per spec "YAGNI" — implement in Task 9b if needed.
    void hour;
    void minute;
  }
}
```

- [ ] **Step 2: typecheck**

Run: `pnpm --filter @cos-tool-bot/server typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/services/chat-summary-service.ts
git commit -m "feat(server): add ChatSummaryService cron + triggerManual with optimistic lock"
```

---

## Task 9b: Global fallback scheduler (optional — only if spec calls for it)

**Files:**

- Modify: `packages/server/src/services/chat-summary-service.ts`

Skip this task if the current bot only uses per-chat configs (the 95% path). If you need the global-fallback feature from spec section "Global fallback":

- [ ] **Step 1: Extend BotCfgAccessor**

Change `BotCfgAccessor` signature to also expose: `listActiveBots(): Promise<{ botId: string; summaryCfg: GlobalSummaryCfg }[]>`.

- [ ] **Step 2: Implement processGlobalFallbacks**

Replace the placeholder with:

```ts
private async processGlobalFallbacks(): Promise<void> {
  const now = new Date();
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 3600_000);
  const twentyThreeHoursAgo = new Date(now.getTime() - 23 * 3600_000);

  const bots = await this.listActiveBots();
  for (const bot of bots) {
    const { summaryCfg, botId } = bot;
    if (!summaryCfg.enabled) continue;
    if (summaryCfg.globalScheduleHour !== hour || summaryCfg.globalScheduleMinute !== minute) continue;
    if (!this.isBotRunning(botId)) continue;

    // chats with ≥5 messages in last 24h
    const chats = await this.db
      .select({
        chatId: conversationMessages.chatId,
        c: sql<number>`count(*)::int`,
      })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.botId, botId),
          gte(conversationMessages.createdAt, twentyFourHoursAgo),
        ),
      )
      .groupBy(conversationMessages.chatId);

    for (const { chatId, c } of chats) {
      if (c < MIN_MESSAGES_FOR_SUMMARY) continue;

      // skip chats with a per-chat config row
      const [existing] = await this.db
        .select({ id: summaryConfigs.id })
        .from(summaryConfigs)
        .where(and(eq(summaryConfigs.botId, botId), eq(summaryConfigs.chatId, chatId)));
      if (existing) continue;

      // cooldown: skip if a scheduled row within last 23h
      const [recent] = await this.db
        .select({ id: chatSummaries.id })
        .from(chatSummaries)
        .where(
          and(
            eq(chatSummaries.botId, botId),
            eq(chatSummaries.chatId, chatId),
            eq(chatSummaries.trigger, "scheduled"),
            gte(chatSummaries.createdAt, twentyThreeHoursAgo),
          ),
        )
        .limit(1);
      if (recent) continue;

      const result = await this.runner.run({
        botId,
        chatId,
        mode: { kind: "default" },
        trigger: "scheduled",
      });
      if (result.ok && result.contentHtml) {
        try {
          await this.send(botId, chatId, result.contentHtml);
        } catch (err) {
          this.logger.warn({ err, botId, chatId }, "Failed to send global-fallback summary");
        }
      }
    }
  }
}
```

- [ ] **Step 3: Inject listActiveBots accessor**

Update the constructor and the bootstrap wiring in Task 11 accordingly. `listActiveBots` reads from the `bots` table for `isActive=true`.

- [ ] **Step 4: typecheck + commit**

```bash
pnpm --filter @cos-tool-bot/server typecheck
git add packages/server/src/services/chat-summary-service.ts
git commit -m "feat(server): implement global fallback scheduler for summaries"
```

---

## Task 10: Server routes /api/summary/\*

**Files:**

- Create: `packages/server/src/routes/summary.ts`

- [ ] **Step 1: Write module**

```ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@cos-tool-bot/database";
import { chatSummaries } from "@cos-tool-bot/database";
import type { SummaryMode } from "@cos-tool-bot/shared";
import type { ChatSummaryService } from "../services/chat-summary-service.js";
import type { SummaryConfigService } from "../services/summary-config-service.js";

const accessModeSchema = z.enum(["all", "admin"]);
const createBodySchema = z.object({
  botId: z.string().uuid(),
  chatId: z.number().int(),
  isActive: z.boolean().optional(),
  scheduleHour: z.number().int().min(0).max(23).nullable().optional(),
  scheduleMinute: z.number().int().min(0).max(59).nullable().optional(),
  windowHours: z.number().int().min(1).max(72).optional(),
  customPrompt: z.string().nullable().optional(),
  modelId: z.string().nullable().optional(),
  maxMessages: z.number().int().min(10).max(2000).nullable().optional(),
  cooldownSeconds: z.number().int().min(0).max(86400).nullable().optional(),
  accessMode: accessModeSchema.optional(),
});
const patchBodySchema = createBodySchema.partial().omit({ botId: true, chatId: true });
const triggerBodySchema = z.object({
  mode: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("default") }),
      z.object({ kind: z.literal("recent"), count: z.number().int().min(1).max(2000) }),
      z.object({ kind: z.literal("hours"), hours: z.number().int().min(1).max(72) }),
      z.object({ kind: z.literal("date"), day: z.enum(["today", "yesterday"]) }),
    ])
    .default({ kind: "default" }),
});

export function createSummaryRoutes(deps: {
  db: Database;
  summaryService: ChatSummaryService;
  configService: SummaryConfigService;
}) {
  return new Hono()
    .get("/configs", zValidator("query", z.object({ botId: z.string().uuid() })), async (c) => {
      const { botId } = c.req.valid("query");
      const rows = await deps.configService.list(botId);
      return c.json({ data: rows });
    })
    .get(
      "/configs/:id",
      zValidator("param", z.object({ id: z.coerce.number().int() })),
      async (c) => {
        const { id } = c.req.valid("param");
        const row = await deps.configService.get(id);
        if (!row) return c.json({ error: "not_found" }, 404);
        return c.json({ data: row });
      },
    )
    .post("/configs", zValidator("json", createBodySchema), async (c) => {
      const body = c.req.valid("json");
      const row = await deps.configService.create(body);
      return c.json({ data: row }, 201);
    })
    .patch(
      "/configs/:id",
      zValidator("param", z.object({ id: z.coerce.number().int() })),
      zValidator("json", patchBodySchema),
      async (c) => {
        const { id } = c.req.valid("param");
        const body = c.req.valid("json");
        const row = await deps.configService.update(id, body);
        if (!row) return c.json({ error: "not_found" }, 404);
        return c.json({ data: row });
      },
    )
    .delete(
      "/configs/:id",
      zValidator("param", z.object({ id: z.coerce.number().int() })),
      async (c) => {
        const { id } = c.req.valid("param");
        const ok = await deps.configService.delete(id);
        if (!ok) return c.json({ error: "not_found" }, 404);
        return c.json({ data: { deleted: true } });
      },
    )
    .post(
      "/configs/:id/trigger",
      zValidator("param", z.object({ id: z.coerce.number().int() })),
      zValidator("json", triggerBodySchema),
      async (c) => {
        const { id } = c.req.valid("param");
        const { mode } = c.req.valid("json");
        const cfg = await deps.configService.get(id);
        if (!cfg) return c.json({ error: "not_found" }, 404);
        const result = await deps.summaryService.triggerManual({
          botId: cfg.botId,
          chatId: cfg.chatId,
          userId: 0,
          mode: mode as SummaryMode,
          bypassCooldown: true,
        });
        return c.json({ data: result });
      },
    )
    .get(
      "/history",
      zValidator(
        "query",
        z.object({
          botId: z.string().uuid(),
          chatId: z.coerce.number().int().optional(),
          page: z.coerce.number().int().min(1).default(1),
          limit: z.coerce.number().int().min(1).max(100).default(20),
        }),
      ),
      async (c) => {
        const { botId, chatId, page, limit } = c.req.valid("query");
        const conditions = [eq(chatSummaries.botId, botId)];
        if (chatId !== undefined) conditions.push(eq(chatSummaries.chatId, chatId));
        const [countRow] = await deps.db
          .select({ total: sql<number>`count(*)::int` })
          .from(chatSummaries)
          .where(and(...conditions));
        const rows = await deps.db
          .select()
          .from(chatSummaries)
          .where(and(...conditions))
          .orderBy(desc(chatSummaries.createdAt))
          .limit(limit)
          .offset((page - 1) * limit);
        return c.json({
          data: rows.map((r) => ({
            ...r,
            windowStart: r.windowStart.toISOString(),
            windowEnd: r.windowEnd.toISOString(),
            createdAt: r.createdAt.toISOString(),
          })),
          total: countRow?.total ?? 0,
          page,
          limit,
        });
      },
    )
    .get(
      "/history/:id",
      zValidator("param", z.object({ id: z.coerce.number().int() })),
      async (c) => {
        const { id } = c.req.valid("param");
        const [row] = await deps.db.select().from(chatSummaries).where(eq(chatSummaries.id, id));
        if (!row) return c.json({ error: "not_found" }, 404);
        return c.json({
          data: {
            ...row,
            windowStart: row.windowStart.toISOString(),
            windowEnd: row.windowEnd.toISOString(),
            createdAt: row.createdAt.toISOString(),
          },
        });
      },
    )
    .delete(
      "/history/:id",
      zValidator("param", z.object({ id: z.coerce.number().int() })),
      async (c) => {
        const { id } = c.req.valid("param");
        const deleted = await deps.db
          .delete(chatSummaries)
          .where(eq(chatSummaries.id, id))
          .returning({ id: chatSummaries.id });
        if (deleted.length === 0) return c.json({ error: "not_found" }, 404);
        return c.json({ data: { deleted: true } });
      },
    )
    .get("/defaults", (c) => {
      return c.json({
        data: {
          systemPrompt: DEFAULT_SUMMARY_SYSTEM_PROMPT,
          windowHours: DEFAULT_WINDOW_HOURS,
          maxMessages: DEFAULT_MAX_MESSAGES,
          cooldownSeconds: DEFAULT_COOLDOWN_SECONDS,
          timezone: DEFAULT_TIMEZONE,
        },
      });
    });
}
```

Add to the imports at the top of the file:

```ts
import {
  DEFAULT_COOLDOWN_SECONDS,
  DEFAULT_MAX_MESSAGES,
  DEFAULT_SUMMARY_SYSTEM_PROMPT,
  DEFAULT_TIMEZONE,
  DEFAULT_WINDOW_HOURS,
} from "../services/summary-prompts.js";
```

- [ ] **Step 2: typecheck**

Run: `pnpm --filter @cos-tool-bot/server typecheck`

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/routes/summary.ts
git commit -m "feat(server): add /api/summary routes (configs CRUD + trigger + history)"
```

---

## Task 11: Bootstrap — wire routes + service into app + index

**Files:**

- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Chain route into createApp**

Open `packages/server/src/app.ts`. Find the `createApp(...)` function. It returns chained `.route(...)` calls. Add to the chain (before the closing return) — parallel to existing routes:

```ts
.route("/api/summary", createSummaryRoutes({ db, summaryService, configService }))
```

Adjust the `createApp` signature to accept the two new deps: `summaryService: ChatSummaryService`, `configService: SummaryConfigService`. Also import `createSummaryRoutes` at top.

Critical: maintain the chain pattern. Do NOT break it with a stored variable, or `AppType` loses inference.

- [ ] **Step 2: Bootstrap service in index.ts**

Open `packages/server/src/index.ts`. Find where RSS service is instantiated (pattern reference). Add analogous wiring:

```ts
import { SummaryRunner } from "./services/summary-runner.js";
import { SummaryConfigService } from "./services/summary-config-service.js";
import { ChatSummaryService } from "./services/chat-summary-service.js";

// after db + logger + chatModelStore + botPool are ready:
const summaryRunner = new SummaryRunner(db, logger, chatModelStore, async (botId) => {
  const [row] = await db
    .select({ aiConfig: bots.aiConfig, isActive: bots.isActive })
    .from(bots)
    .where(eq(bots.id, botId));
  if (!row?.isActive) return null;
  const cfg = row.aiConfig;
  if (!cfg) return null;
  return {
    enabled: cfg.enabled,
    model: cfg.model,
    summaryConfig: cfg.summaryConfig,
    conversationConfig: cfg.conversationConfig,
  };
});

const configService = new SummaryConfigService(db);

const summaryService = new ChatSummaryService(
  db,
  logger,
  summaryRunner,
  async (botId, chatId, html) => {
    const bot = botPool.get(botId);
    if (!bot) return;
    await bot.api.sendMessage(chatId, html, { parse_mode: "HTML" });
  },
  (botId) => botPool.isRunning(botId),
  async (botId) => {
    const [row] = await db.select({ aiConfig: bots.aiConfig }).from(bots).where(eq(bots.id, botId));
    const sc = row?.aiConfig?.summaryConfig;
    if (!sc) return null;
    return {
      enabled: sc.enabled,
      globalScheduleHour: sc.globalScheduleHour,
      globalScheduleMinute: sc.globalScheduleMinute,
    };
  },
);
summaryService.start();

// Graceful shutdown
process.on("SIGTERM", () => summaryService.stop());
process.on("SIGINT", () => summaryService.stop());
```

Imports `bots`, `eq`, etc. from `@cos-tool-bot/database` and `drizzle-orm`. Exact accessor APIs (`botPool.get`, `botPool.isRunning`) — check current `bot-pool.ts` for the real method names and adapt.

- [ ] **Step 3: Pass to createApp**

Update the `createApp({ ... })` call to include `summaryService` and `configService`.

- [ ] **Step 4: typecheck**

Run: `pnpm --filter @cos-tool-bot/server typecheck`

- [ ] **Step 5: Smoke — start dev server**

Run: `pnpm dev`
Expected: log line "ChatSummaryService started"; no startup errors.
Kill with Ctrl-C.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/app.ts packages/server/src/index.ts
git commit -m "feat(server): wire SummaryRunner + ChatSummaryService + routes into bootstrap"
```

---

## Task 12: Inject summaryService into BotPool / BotConfig / createBot

**Files:**

- Modify: `packages/server/src/services/bot-pool.ts`
- Modify: `packages/server/src/services/bot-manager.ts` (if it wraps bot-pool)
- Modify: `packages/bot/src/index.ts`

- [ ] **Step 1: Add summaryService to BotConfig**

Open `packages/bot/src/index.ts`. Find the `BotConfig` interface (or inline object type) used by `createBot`. Add:

```ts
summaryService?: {
  triggerManual(opts: {
    botId: string;
    chatId: number;
    userId: number;
    mode: import("@cos-tool-bot/shared").SummaryMode;
    bypassCooldown?: boolean;
  }): Promise<{
    ok: boolean;
    reason?: "cooldown" | "disabled" | "no_access" | "too_few_messages" | "llm_failed";
    summaryId?: number;
    contentHtml?: string;
  }>;
};
summaryBotId?: string;
```

(Use a structural type so bot package has no runtime dep on server.)

- [ ] **Step 2: Propagate from bot-pool**

Open `packages/server/src/services/bot-pool.ts` near line 194 where other services (conversation, etc.) are injected into createBot. Add:

```ts
summaryService: opts.summaryService,
summaryBotId: botId,
```

Update `BotPool` constructor/options to accept `summaryService`.

- [ ] **Step 3: Propagate from bot-manager**

If `bot-manager.ts` wraps bot-pool construction, forward `summaryService` through its options.

- [ ] **Step 4: Update server index.ts**

Wire `summaryService` into `new BotPool({ ..., summaryService })` (or `BotManager`). Order matters: service must be constructed before pool.

- [ ] **Step 5: typecheck**

Run: `pnpm typecheck`

- [ ] **Step 6: Commit**

```bash
git add packages/bot/src/index.ts packages/server/src/services/bot-pool.ts packages/server/src/services/bot-manager.ts packages/server/src/index.ts
git commit -m "feat(bot,server): inject summaryService into bot lifecycle"
```

---

## Task 13: Bot /summary command + arg parser

**Files:**

- Create: `packages/bot/src/commands/summary.ts`
- Modify: `packages/bot/src/index.ts` (register command)

- [ ] **Step 1: Write command module**

```ts
import type { Bot, Context } from "grammy";
import type { SummaryMode } from "@cos-tool-bot/shared";

const MAX_COUNT = 2000;
const MAX_HOURS = 72;

interface ParseOk {
  ok: true;
  value: SummaryMode;
}
interface ParseErr {
  ok: false;
  usage: string;
}
export type ParseResult = ParseOk | ParseErr;

const USAGE = `/summary 使用说明：
  /summary         总结最近 24 小时
  /summary 200     总结最近 200 条
  /summary 6h      总结最近 6 小时
  /summary today   总结今天
  /summary yesterday 总结昨日

限制：最多 ${MAX_COUNT} 条 / ${MAX_HOURS} 小时`;

export function parseSummaryArgs(raw: string): ParseResult {
  const arg = raw.trim();
  if (!arg) return { ok: true, value: { kind: "default" } };

  if (/^(today|yesterday)$/i.test(arg)) {
    return { ok: true, value: { kind: "date", day: arg.toLowerCase() as "today" | "yesterday" } };
  }
  const hoursMatch = /^(\d+)h$/i.exec(arg);
  if (hoursMatch) {
    const hours = Number(hoursMatch[1]);
    if (hours <= 0 || hours > MAX_HOURS) return { ok: false, usage: USAGE };
    return { ok: true, value: { kind: "hours", hours } };
  }
  if (/^\d+$/.test(arg)) {
    const count = Number(arg);
    if (count <= 0 || count > MAX_COUNT) return { ok: false, usage: USAGE };
    return { ok: true, value: { kind: "recent", count } };
  }
  return { ok: false, usage: USAGE };
}

interface Deps {
  summaryService: {
    triggerManual(opts: {
      botId: string;
      chatId: number;
      userId: number;
      mode: SummaryMode;
    }): Promise<{
      ok: boolean;
      reason?: "cooldown" | "disabled" | "no_access" | "too_few_messages" | "llm_failed";
      contentHtml?: string;
    }>;
  };
  botId: string;
}

function reasonMessage(reason?: string): string {
  switch (reason) {
    case "cooldown":
      return "⏱ 冷却中，稍后再试";
    case "disabled":
      return "群聊总结未启用，请联系管理员";
    case "no_access":
      return "仅管理员可用";
    case "too_few_messages":
      return "消息太少，无需总结";
    case "llm_failed":
      return "总结失败：LLM 调用异常";
    default:
      return "总结失败";
  }
}

export function registerSummaryCommand(bot: Bot<Context>, deps: Deps) {
  bot.command("summary", async (ctx) => {
    const match = (ctx.match ?? "") as string;
    const parsed = parseSummaryArgs(match);
    if (!parsed.ok) {
      await ctx.reply(parsed.usage);
      return;
    }

    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    if (chatId === undefined || userId === undefined) return;

    const statusMsg = await ctx.reply("📝 正在总结群聊，稍等…", {
      reply_parameters: ctx.message ? { message_id: ctx.message.message_id } : undefined,
    });

    const result = await deps.summaryService.triggerManual({
      botId: deps.botId,
      chatId,
      userId,
      mode: parsed.value,
    });

    if (!result.ok) {
      await ctx.api
        .editMessageText(chatId, statusMsg.message_id, reasonMessage(result.reason))
        .catch(() => {});
      return;
    }

    await ctx.api.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    await ctx.api.sendMessage(chatId, result.contentHtml!, {
      parse_mode: "HTML",
      reply_parameters: ctx.message ? { message_id: ctx.message.message_id } : undefined,
    });
  });
}
```

- [ ] **Step 2: Register in createBot**

Open `packages/bot/src/index.ts`. In `createBot(config)`, after other `registerXxxCommand(bot, ...)` calls, add:

```ts
if (config.summaryService && config.summaryBotId) {
  registerSummaryCommand(bot, {
    summaryService: config.summaryService,
    botId: config.summaryBotId,
  });
}
```

Import at top: `import { registerSummaryCommand } from "./commands/summary.js";`

- [ ] **Step 3: Update setMyCommands**

In the same file, find where `bot.api.setMyCommands([...])` is called. Append:

```ts
{ command: "summary", description: "群聊总结（/summary help 查看用法）" },
```

- [ ] **Step 4: Admin access check (command-side)**

The access-mode check runs in the command, not in the service, to avoid coupling service to admin identity. Extend `Deps`:

```ts
interface Deps {
  summaryService: {
    /* as above */
  };
  botId: string;
  adminUserIds: number[];
  /** returns accessMode for a given chat, or null if no config row */
  getAccessMode(chatId: number): Promise<"all" | "admin" | null>;
}
```

In the command handler, before calling `triggerManual`:

```ts
const access = await deps.getAccessMode(chatId);
if (access === "admin" && !deps.adminUserIds.includes(userId)) {
  await ctx.api.editMessageText(chatId, statusMsg.message_id, "仅管理员可用").catch(() => {});
  return;
}
```

Wire this in `createBot` (Task 13 Step 2):

```ts
if (config.summaryService && config.summaryBotId) {
  registerSummaryCommand(bot, {
    summaryService: config.summaryService,
    botId: config.summaryBotId,
    adminUserIds: config.adminChatIds ?? [],
    getAccessMode: async (chatId) => {
      if (!config.summaryConfigLookup) return null;
      const cfg = await config.summaryConfigLookup(chatId);
      return cfg?.accessMode ?? null;
    },
  });
}
```

Add `summaryConfigLookup?: (chatId: number) => Promise<{ accessMode: "all" | "admin" } | null>` to `BotConfig`. Wire it in `bot-pool.ts` (Task 12 Step 2) using the existing `SummaryConfigService`:

```ts
summaryConfigLookup: (chatId: number) => opts.configService.getByChat(botId, chatId),
```

Pass `configService` into `BotPool` options alongside `summaryService`.

- [ ] **Step 5: typecheck**

Run: `pnpm typecheck`

- [ ] **Step 6: Commit**

```bash
git add packages/bot/src/commands/summary.ts packages/bot/src/index.ts
git commit -m "feat(bot): add /summary command with arg parser and status-message flow"
```

---

## Task 14: Update help.ts

**Files:**

- Modify: `packages/bot/src/commands/help.ts`

- [ ] **Step 1: Add summary line**

Open `packages/bot/src/commands/help.ts`. Find the help text. Append a line before the closing of the command list:

```
/summary - 群聊总结（/summary help 查看用法）
```

Match the exact formatting convention used (HTML vs plain, bullets, etc.). If the help text is an array joined with `\n`, push a new string.

- [ ] **Step 2: typecheck + commit**

```bash
pnpm --filter @cos-tool-bot/bot typecheck
git add packages/bot/src/commands/help.ts
git commit -m "feat(bot): mention /summary in help text"
```

---

## Task 15: Panel — summary list page

**Files:**

- Create: `packages/panel/src/pages/summary/list.tsx`
- Modify: `packages/panel/src/main.tsx` (register Refine resource)

- [ ] **Step 1: Inspect existing RSS list for pattern**

Read `packages/panel/src/pages/rss/` (or equivalent) to mirror: Refine `useList` hook, table, buttons for "编辑" / "触发" / "删除".

- [ ] **Step 2: Write list page**

```tsx
import { useList, useNavigation, useInvalidate } from "@refinedev/core";
import { client } from "../../lib/client";
import type { SummaryConfigRecord } from "@cos-tool-bot/shared";
import { Button } from "../../components/button"; // or whatever button component exists

interface Props {
  botId: string;
}

export function SummaryConfigList({ botId }: Props) {
  const { data, isLoading, refetch } = useList<SummaryConfigRecord>({
    resource: "summary-configs",
    filters: [{ field: "botId", operator: "eq", value: botId }],
  });
  const { edit, create } = useNavigation();
  const invalidate = useInvalidate();

  const onTrigger = async (id: number) => {
    const res = await client.api.summary.configs[":id"].trigger.$post({
      param: { id: String(id) },
      json: { mode: { kind: "default" } },
    });
    const body = await res.json();
    alert(body.data?.ok ? "已触发" : `失败：${body.data?.reason ?? "unknown"}`);
  };

  const onDelete = async (id: number) => {
    if (!confirm("确认删除？")) return;
    await client.api.summary.configs[":id"].$delete({ param: { id: String(id) } });
    await refetch();
    invalidate({ resource: "summary-configs", invalidates: ["list"] });
  };

  if (isLoading) return <div>加载中…</div>;

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-bold">群聊总结配置</h2>
        <Button onClick={() => create("summary-configs")}>新增配置</Button>
      </div>
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b text-left">
            <th>Chat ID</th>
            <th>启用</th>
            <th>定时 (UTC)</th>
            <th>窗口 (h)</th>
            <th>权限</th>
            <th>最近手动</th>
            <th>最近定时</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {data?.data?.map((r) => (
            <tr key={r.id} className="border-b">
              <td>{r.chatId}</td>
              <td>{r.isActive ? "是" : "否"}</td>
              <td>
                {r.scheduleHour !== null && r.scheduleMinute !== null
                  ? `${String(r.scheduleHour).padStart(2, "0")}:${String(r.scheduleMinute).padStart(2, "0")}`
                  : "—"}
              </td>
              <td>{r.windowHours}</td>
              <td>{r.accessMode}</td>
              <td>{r.lastManualAt ?? "—"}</td>
              <td>{r.lastScheduledAt ?? "—"}</td>
              <td className="space-x-2">
                <Button onClick={() => edit("summary-configs", r.id)}>编辑</Button>
                <Button onClick={() => onTrigger(r.id)}>立即触发</Button>
                <Button variant="danger" onClick={() => onDelete(r.id)}>
                  删除
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

Adjust paths, imports, and Button API to match actual codebase components (check `packages/panel/src/components/`).

- [ ] **Step 3: Register Refine resource**

Open `packages/panel/src/main.tsx`. Locate the Refine `resources={[...]}` array. Add:

```ts
{
  name: "summary-configs",
  list: "/summary-configs",
  create: "/summary-configs/create",
  edit: "/summary-configs/edit/:id",
  meta: { label: "群聊总结", parent: "bots" },
},
```

Mount route with `<Route path="/summary-configs" element={<SummaryConfigList botId={...} />} />` — or embed inside bot detail tabs (Task 19).

- [ ] **Step 4: typecheck**

Run: `pnpm --filter @cos-tool-bot/panel typecheck`

- [ ] **Step 5: Commit**

```bash
git add packages/panel/src/pages/summary/list.tsx packages/panel/src/main.tsx
git commit -m "feat(panel): add summary config list page and Refine resource"
```

---

## Task 16: Panel — summary form page (create/edit)

**Files:**

- Create: `packages/panel/src/pages/summary/form.tsx`

- [ ] **Step 1: Write form**

```tsx
import { useForm } from "@refinedev/react-hook-form";
import { Controller } from "react-hook-form";
import { useList } from "@refinedev/core";
import type { SummaryConfigRecord } from "@cos-tool-bot/shared";

interface Props {
  botId: string;
  mode: "create" | "edit";
  id?: number;
}

const DEFAULT_PROMPT = `（显示默认 prompt 占位，表单中可读显示）`;

export function SummaryConfigForm({ botId, mode, id }: Props) {
  const {
    refineCore: { onFinish, formLoading },
    register,
    control,
    handleSubmit,
  } = useForm<SummaryConfigRecord>({
    refineCoreProps: {
      resource: "summary-configs",
      id: mode === "edit" ? id : undefined,
      action: mode,
    },
  });

  // Optional: active-chat dropdown for create mode
  const { data: chats } = useList({
    resource: "conversations",
    filters: [{ field: "botId", operator: "eq", value: botId }],
    pagination: { pageSize: 50 },
  });

  return (
    <form onSubmit={handleSubmit((values) => onFinish({ ...values, botId }))} className="space-y-3">
      <label className="block">
        <span className="block text-sm">Chat ID</span>
        <input
          {...register("chatId", { valueAsNumber: true, required: true })}
          type="number"
          className="w-full border rounded p-2"
        />
        {chats?.data && (
          <select
            className="mt-1 w-full border rounded p-2"
            onChange={(e) => {
              // helper to populate chatId
            }}
          >
            <option value="">— 从活跃对话中选 —</option>
            {chats.data.map((c: any) => (
              <option key={c.chatId} value={c.chatId}>
                {c.chatId} ({c.messageCount} 条)
              </option>
            ))}
          </select>
        )}
      </label>

      <label className="block">
        <input {...register("isActive")} type="checkbox" /> 启用
      </label>

      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="block text-sm">定时 Hour (UTC, 留空=仅手动)</span>
          <input
            {...register("scheduleHour", { valueAsNumber: true })}
            type="number"
            min={0}
            max={23}
            className="w-full border rounded p-2"
          />
        </label>
        <label className="block">
          <span className="block text-sm">定时 Minute</span>
          <input
            {...register("scheduleMinute", { valueAsNumber: true })}
            type="number"
            min={0}
            max={59}
            className="w-full border rounded p-2"
          />
        </label>
      </div>

      <label className="block">
        <span className="block text-sm">窗口小时</span>
        <input
          {...register("windowHours", { valueAsNumber: true })}
          type="number"
          min={1}
          max={72}
          defaultValue={24}
          className="w-full border rounded p-2"
        />
      </label>

      <label className="block">
        <span className="block text-sm">最多消息数（留空=默认 2000）</span>
        <input
          {...register("maxMessages", { valueAsNumber: true })}
          type="number"
          min={10}
          max={2000}
          className="w-full border rounded p-2"
        />
      </label>

      <label className="block">
        <span className="block text-sm">冷却秒（留空=默认 300）</span>
        <input
          {...register("cooldownSeconds", { valueAsNumber: true })}
          type="number"
          min={0}
          className="w-full border rounded p-2"
        />
      </label>

      <label className="block">
        <span className="block text-sm">权限</span>
        <select {...register("accessMode")} className="w-full border rounded p-2">
          <option value="all">所有人</option>
          <option value="admin">仅管理员</option>
        </select>
      </label>

      <label className="block">
        <span className="block text-sm">模型 ID（留空 fallback 主模型）</span>
        <input {...register("modelId")} type="text" className="w-full border rounded p-2" />
      </label>

      <label className="block">
        <span className="block text-sm">自定义 Prompt（留空=默认）</span>
        <textarea {...register("customPrompt")} rows={8} className="w-full border rounded p-2" />
        <details className="text-xs mt-1">
          <summary>查看默认 prompt</summary>
          <pre className="bg-gray-100 p-2 whitespace-pre-wrap">{DEFAULT_PROMPT}</pre>
        </details>
      </label>

      <button
        type="submit"
        disabled={formLoading}
        className="px-4 py-2 bg-blue-600 text-white rounded"
      >
        保存
      </button>
    </form>
  );
}
```

Replace the `DEFAULT_PROMPT` placeholder with an API fetch. Add a new endpoint `GET /api/summary/defaults` in Task 10 that returns `{ systemPrompt, windowHours, maxMessages, cooldownSeconds, timezone }`. Load via `client.api.summary.defaults.$get()` inside a `useEffect` and store in component state. If you prefer to skip the API, inline the `DEFAULT_SUMMARY_SYSTEM_PROMPT` string literal directly in this form (sync with `packages/server/src/services/summary-prompts.ts`).

- [ ] **Step 2: typecheck + commit**

```bash
pnpm --filter @cos-tool-bot/panel typecheck
git add packages/panel/src/pages/summary/form.tsx
git commit -m "feat(panel): add summary config create/edit form"
```

---

## Task 17: Panel — summary history page

**Files:**

- Create: `packages/panel/src/pages/summary/history.tsx`

- [ ] **Step 1: Write page**

```tsx
import { useState } from "react";
import { client } from "../../lib/client";
import type { ChatSummaryRecord } from "@cos-tool-bot/shared";

interface Props {
  botId: string;
}

export function SummaryHistory({ botId }: Props) {
  const [page, setPage] = useState(1);
  const [chatFilter, setChatFilter] = useState<string>("");
  const [selected, setSelected] = useState<ChatSummaryRecord | null>(null);
  const [rows, setRows] = useState<ChatSummaryRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    const res = await client.api.summary.history.$get({
      query: {
        botId,
        chatId: chatFilter || undefined,
        page: String(page),
        limit: "20",
      },
    });
    const body = await res.json();
    setRows(body.data);
    setTotal(body.total);
    setLoading(false);
  };

  // Call load on mount + deps change:
  // use useEffect for real impl.

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          placeholder="chat id 过滤（留空=全部）"
          value={chatFilter}
          onChange={(e) => setChatFilter(e.target.value)}
          className="border rounded p-2 flex-1"
        />
        <button onClick={load} className="px-4 py-2 bg-blue-600 text-white rounded">
          查询
        </button>
      </div>
      {loading && <div>加载中…</div>}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left">
            <th>时间</th>
            <th>Chat</th>
            <th>触发</th>
            <th>消息数</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b">
              <td>{new Date(r.createdAt).toLocaleString()}</td>
              <td>{r.chatId}</td>
              <td>{r.trigger}</td>
              <td>{r.messageCount}</td>
              <td>{r.errorMessage ? `❌ ${r.errorMessage}` : "✅"}</td>
              <td>
                <button onClick={() => setSelected(r)} className="text-blue-600 underline">
                  查看
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex gap-2 items-center">
        <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
          上页
        </button>
        <span>
          第 {page} 页 / 共 {Math.ceil(total / 20)} 页
        </span>
        <button disabled={page * 20 >= total} onClick={() => setPage((p) => p + 1)}>
          下页
        </button>
      </div>
      {selected && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center">
          <div className="bg-white max-w-2xl w-full max-h-[80vh] overflow-auto p-4 rounded">
            <div className="flex justify-between items-center">
              <h3 className="font-bold">Summary #{selected.id}</h3>
              <button onClick={() => setSelected(null)}>关闭</button>
            </div>
            <pre className="whitespace-pre-wrap mt-2">{selected.content}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
```

Add the effect hook at the top of the component body:

```tsx
import { useEffect } from "react";
// ...
useEffect(() => {
  void load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [page, botId]);
```

`load` captures `chatFilter` via closure; the 查询 button triggers a re-call without changing `page`. If you want filter changes to reset pagination, call `setPage(1)` in the button onClick and let the effect handle reload.

- [ ] **Step 2: typecheck + commit**

```bash
pnpm --filter @cos-tool-bot/panel typecheck
git add packages/panel/src/pages/summary/history.tsx
git commit -m "feat(panel): add summary history page with pagination and preview modal"
```

---

## Task 18: Panel — bot detail "总结" tab + aiConfig summaryConfig group

**Files:**

- Modify: `packages/panel/src/pages/bots/show.tsx` (exact filename — check the actual bot detail page)
- Modify: AI config form component (path identified by inspection)

- [ ] **Step 1: Find bot detail tabs**

Run: `rg -n "Tabs|TabList|TabTrigger|TabsContent" packages/panel/src/pages/bots`
Identify the tabs component. Mirror the pattern used for RSS tab (search: `rg -n "RSS\|rss" packages/panel/src/pages/bots`).

- [ ] **Step 2: Add 总结 tab**

In the tabs definition, append:

```tsx
<TabTrigger value="summary">群聊总结</TabTrigger>
<TabsContent value="summary">
  <SummaryConfigList botId={id} />
  <hr className="my-4" />
  <SummaryHistory botId={id} />
</TabsContent>
```

Import the two components. Use the actual Tabs primitive (Radix/headless/etc.) the project uses.

- [ ] **Step 3: Add summaryConfig group to AI config form**

Find the AI config form component (likely `packages/panel/src/pages/bots/ai-config-form.tsx` or similar). In its field list, add a collapsible section "群聊总结设置" with:

- `enabled` checkbox
- `defaultWindowHours` (number, default 24)
- `defaultMaxMessages` (number, default 2000)
- `defaultCooldownSeconds` (number, default 300)
- `globalScheduleHour` / `globalScheduleMinute` (optional number pair)
- `modelId` (text)
- `systemPrompt` (textarea)
- `timezone` (text, default `Asia/Shanghai`)

Bind via `register("summaryConfig.enabled")`, etc. Confirm RHF nested path format matches existing form conventions.

- [ ] **Step 4: typecheck**

Run: `pnpm --filter @cos-tool-bot/panel typecheck`

- [ ] **Step 5: Commit**

```bash
git add packages/panel/src/pages/bots/
git commit -m "feat(panel): add 总结 tab on bot detail + summaryConfig group in AI config form"
```

---

## Task 19: Smoke test end-to-end + final quality gates

**Files:** none (verification only)

- [ ] **Step 1: Start dev stack**

```bash
pnpm docker:up-dev  # or whatever starts dev db
pnpm dev
```

Open the panel URL. Log in.

- [ ] **Step 2: Enable summaryConfig on test bot**

In bot detail → AI 配置：

- Tick `summaryConfig.enabled`
- Save

- [ ] **Step 3: Create per-chat config**

Panel → 总结 tab → 新增：

- chatId: your test group id
- scheduleHour/Minute: 2 minutes from now (UTC!)
- windowHours: 1
- accessMode: all
- Save

- [ ] **Step 4: Manual /summary**

In Telegram test group, send a few messages then `/summary 5`.
Expected:

- Bot replies "📝 正在总结…"
- After a few seconds, replies with expandable blockquote HTML summary linking messages.

Test all arg forms:

- `/summary` → 24h default
- `/summary 10` → 10 messages
- `/summary 2h` → 2 hours
- `/summary today`
- `/summary yesterday`

- [ ] **Step 5: Cooldown**

`/summary` again immediately → expect "⏱ 冷却中".

- [ ] **Step 6: Scheduled trigger**

Wait until the configured scheduleHour:scheduleMinute passes. Expect auto-posted summary in the group.

- [ ] **Step 7: Panel history**

Panel → 总结 → history tab → verify two rows (manual + scheduled) + click 查看 to see content.

- [ ] **Step 8: Panel trigger button**

Panel → 总结 → 立即触发 on the config row. Expect alert "已触发" + new history row.

- [ ] **Step 9: Error paths**

- In bot detail, uncheck `summaryConfig.enabled`, send `/summary` → expect "群聊总结未启用".
- Set `accessMode=admin` on config, send `/summary` from non-admin user → expect "仅管理员可用".
- Temporarily break the model API key → `/summary` → expect "总结失败：LLM 调用异常".

- [ ] **Step 10: Quality gates**

```bash
pnpm lint
pnpm fmt:check
pnpm typecheck
```

All three must pass with no errors. If fmt fails, run `pnpm fmt` and re-stage.

- [ ] **Step 11: Final commit (if any residual changes)**

```bash
git status
# if dirty:
git add -A
git commit -m "chore: smoke test fixes"
```

---

## Acceptance criteria

- `pnpm lint / typecheck / fmt:check` all green
- `/summary` with all 5 argument forms produces a valid HTML expandable blockquote in test group
- Scheduled cron fires within 60s of configured HH:MM (UTC)
- Panel CRUD (create / edit / delete / trigger) works without errors
- Panel history pagination + detail view works
- All 6 error paths in Task 19 Step 9 produce the correct user-facing message
- `chat_summaries` rows exist for all runs (including error cases)
- `token_usage` has matching rows with `trigger="summary"` for successful runs

---

## Known edge cases — deferred unless needed

These are mentioned in the spec's error matrix but are low-probability given expected usage. Punt until first real-world bug:

- **HTML > 4096 chars**: Telegram rejects. Workaround: catch the `sendMessage` error in the bootstrap `send` callback (Task 11), fall back to splitting the raw markdown by top-level paragraphs and sending each wrapped in its own `<blockquote expandable>`. Summaries typically stay under 2000 chars so this is rare.
- **HTML parse_mode error**: If Telegram rejects due to malformed tags (e.g. from pathological LLM output), catch and retry once with `parse_mode` omitted and raw text.
- **Token budget overflow**: Runner estimates chars and truncates oldest messages if prompt chars exceed ~80k (rough proxy for 80% of a 128k-ctx model). Add to `SummaryRunner.run` between `formatMessages` and the LLM call only if you observe 400-class errors from the model.

---

## Out of scope for v1 (explicitly deferred)

- Image multimodal (base64 photo → vision model)
- RAG / vector retrieval for summary context
- Cross-day batched summaries (> 72h windows)
- `/ask` command (user explicitly declined)
- Unit test framework setup
- Folding style other than blockquote expandable (e.g. per-topic sub-blockquotes)

These can be added in follow-up plans.
