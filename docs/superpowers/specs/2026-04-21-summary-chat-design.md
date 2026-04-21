# 群聊总结功能设计

**分支**: `feat/summary-chat`
**日期**: 2026-04-21
**参考**: `/Users/example/Documents/Programming/worktree/pixai/app/ref2v/telegram-summary-bot-analysis.md`（`asukaminato0721/telegram-summary-bot` 扒皮）

## 目标

为 `cos-tool-bot` 增加：

1. 手动 `/summary` 命令，按参数总结最近消息。
2. 按群定时自动总结群聊（可配置）。
3. Panel 管理面板 CRUD + 历史查看。

## 复用的项目基础设施

已存在，无需重建：

| 组件 | 路径 | 用途 |
|------|------|------|
| `conversationMessages` 表 | `packages/database/src/schema.ts` | 已存全量群消息（role + content + userName + meta + embedding） |
| `ConversationStore.getHistory` | `packages/server/src/services/conversation-store.ts` | 取历史消息的接口，直接复用/扩展 |
| `aiConfig` 存储结构 | `packages/database/src/schema.ts` bots 表 `ai_config` JSON | 挂 `summaryConfig` 子字段 |
| `chat-model-store` | `packages/server/src/services/chat-model-store.ts` | 按 botId/chatId 取 OpenAI 兼容 client |
| RSS 定时范式 | `packages/server/src/services/rss-feed-service.ts` | per-row + 每分钟 cron + 回调触发 模板 |
| `markdown → telegram HTML` | `packages/bot/src/utils/format.ts` 的 `escapeHtml` + `telegramRenderer`（Marked） | 总结输出渲染 |
| `token_usage` 表 | `packages/database/src/schema.ts` | 记账 |

## 架构

```
┌────────────────────┐   cron 每分钟   ┌─────────────────────┐
│  ChatSummaryService│───checkScheduled──→│  summary_configs 表 │
│  (server/services) │                 │  (per-chat)         │
└──────┬─────────────┘                 └─────────────────────┘
       │ trigger(botId,chatId,mode)
       ▼
┌────────────────────┐   取消息        ┌─────────────────────┐
│ SummaryRunner      │──查 filter──→   │ conversationMessages│
│ (server/services)  │                 │ (已有)              │
└──────┬─────────────┘                 └─────────────────────┘
       │ format→LLM→HTML
       ▼
┌────────────────────┐   写入          ┌─────────────────────┐
│  BotManager.sendMsg│                 │ chat_summaries 表   │
│  (已有)            │◄─────insert─────│ (新，历史记录)       │
└────────────────────┘                 └─────────────────────┘

Bot 命令 /summary ──→ triggerManual(...)——→ SummaryRunner
Panel CRUD ──── REST ──→ SummaryConfigService ─→ summary_configs 表
```

### 组件职责

- **`SummaryRunner`**（`packages/server/src/services/summary-runner.ts`）：纯执行。取消息 → 格式化 → 调 LLM → 渲染 HTML → 写 history。无 cron/冷却逻辑。
- **`ChatSummaryService`**（`packages/server/src/services/chat-summary-service.ts`）：cron 扫调度、全局 fallback、冷却检查、并发乐观锁、调用 Runner、发消息。
- **`SummaryConfigService`**（`packages/server/src/services/summary-config-service.ts`）：per-chat 配置表 CRUD。Panel 层依赖。
- **Bot 命令**（`packages/bot/src/commands/summary.ts`）：参数解析 + ack message + 调 `triggerManual` + 发送。

## 数据模型

### 新表 `summary_configs`

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

    // 定时（UTC）
    scheduleHour: integer("schedule_hour"),       // null = 仅手动
    scheduleMinute: integer("schedule_minute"),
    windowHours: integer("window_hours").notNull().default(24),

    // 可选覆盖
    customPrompt: text("custom_prompt"),
    modelId: text("model_id"),
    maxMessages: integer("max_messages"),
    cooldownSeconds: integer("cooldown_seconds"),

    // 权限
    accessMode: text("access_mode").notNull().default("all"),  // 'all' | 'admin'

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

### 新表 `chat_summaries`

```ts
export const chatSummaries = pgTable(
  "chat_summaries",
  {
    id: serial("id").primaryKey(),
    botId: uuid("bot_id")
      .references(() => bots.id, { onDelete: "cascade" })
      .notNull(),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    trigger: text("trigger").notNull(),                  // 'scheduled' | 'manual'
    triggeredBy: bigint("triggered_by", { mode: "number" }),  // userId; scheduled = null
    windowStart: timestamp("window_start").notNull(),
    windowEnd: timestamp("window_end").notNull(),
    messageCount: integer("message_count").notNull(),
    modelId: text("model_id").notNull(),
    content: text("content").notNull(),                   // LLM 原始 markdown 输出
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    durationMs: integer("duration_ms"),
    errorMessage: text("error_message"),                  // 失败时 content 为空
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("chat_summaries_bot_chat_idx").on(t.botId, t.chatId),
    index("chat_summaries_created_idx").on(t.createdAt),
  ],
);
```

### `aiConfig.summaryConfig`（扩展 JSON 子字段）

```ts
summaryConfig?: {
  enabled: boolean;                                      // 主开关
  defaultWindowHours: number;                            // 默认 24
  defaultMaxMessages: number;                            // 默认 2000
  defaultCooldownSeconds: number;                        // 默认 300
  globalScheduleHour?: number;                           // 无 per-chat 配置的 chat 的 fallback 定时
  globalScheduleMinute?: number;
  modelId?: string;                                      // 专用模型；fallback 主 model
  systemPrompt?: string;                                 // 覆盖硬编码默认 prompt
  roleFilter?: Array<"user" | "context" | "assistant">;  // 默认 3 项全选
  timezone?: string;                                     // IANA tz；默认 "Asia/Shanghai"。用于 /summary today|yesterday
}
```

同步更新 `packages/database/src/schema.ts` 的 `AiConfigJson` 接口和 `packages/shared/src/types.ts` 的 `AiConfigStored` 类型（两处双写，已有 SYNC 注释约定）。

### 设计理由

- **两表拆**：配置生命周期长且行数少；历史只增不改且每 chat 多行。RSS 已证明合并会别扭。
- **`lastScheduledAt` / `lastManualAt` 分字段**：定时总结冷却不锁死手动触发。
- **错误也写 history**：Panel 可诊断；不混进 `bot_logs`（后者是 bot 运行日志，不是用户可见 artifact）。
- **UTC 存储**：与现有 RSS 调度一致；Panel 展示层转本地。

## 手动命令

`packages/bot/src/commands/summary.ts`（新）。

### 参数语法

| 输入 | Mode |
|------|------|
| `/summary` | `{kind:"default"}` → 24h（按 config） |
| `/summary 200` | `{kind:"recent", count:200}` |
| `/summary 6h` | `{kind:"hours", hours:6}` |
| `/summary today` | `{kind:"date", day:"today"}` |
| `/summary yesterday` | `{kind:"date", day:"yesterday"}` |

上限：count ≤ 2000（或 config 的 `maxMessages`），hours ≤ 72。非法 → 回使用说明。

### 执行流程

1. 解析参数。
2. 立即发占位 "📝 正在总结群聊，稍等…"。
3. 调 `summaryService.triggerManual({...})`。
4. 失败 → editMessageText 为错误原因（cooldown/disabled/no_access/too_few_messages/llm_error）。
5. 成功 → deleteMessage 占位 → sendMessage HTML 正文 + reply 原命令。

### 权限

`config.accessMode`：
- `"all"`（默认）：任何群成员可触发。
- `"admin"`：仅 `bot.adminChatIds` 里的 userId。

无 per-chat config 时，走 `aiConfig.summaryConfig.enabled`；若关则提示。

### 命令菜单

`bot.api.setMyCommands` 追加 `summary` 项（短描述："群聊总结"）。

## 定时调度

复用 RSS 模板：

- **cron 周期**：每 60s（与 RSS 一致）。
- **选中条件**：`isActive=true AND scheduleHour=currentUtcHour AND scheduleMinute=currentUtcMinute AND (lastScheduledAt IS NULL OR lastScheduledAt < now() - 23h)`。
- **并发乐观锁**：`UPDATE summary_configs SET lastScheduledAt=NOW() WHERE id=? AND (lastScheduledAt IS NULL OR lastScheduledAt < now() - 23h) RETURNING id`，拿到行才 enqueue。
- **执行**：runner 跑完 → 调 `BotManager.sendMessage`（走与手动同一个 HTML 渲染路径）。

### 全局 fallback

若 `aiConfig.summaryConfig.globalScheduleHour/Minute` 配置，且到点：
- 扫该 bot 下 `conversationMessages` 在过去 24h 有 ≥5 条 user/context 消息的 chatId；
- 排除已有 `summary_configs` 行的 chat；
- 对每个 chatId 用默认窗口/默认 prompt 触发。
- 结果落 history 时 config_id=null；冷却靠 `chat_summaries` 查 "过去 23h 有无同 chatId 的 scheduled 行"。

## SummaryRunner 细节

```ts
type SummaryMode =
  | { kind: "recent"; count: number }
  | { kind: "hours"; hours: number }
  | { kind: "date"; day: "today" | "yesterday" }
  | { kind: "default" };

interface RunOptions {
  botId: string;
  chatId: number;
  mode: SummaryMode;
  trigger: "scheduled" | "manual";
  triggeredBy?: number;
  configOverrides?: {
    customPrompt?: string | null;
    modelId?: string | null;
    maxMessages?: number | null;
  };
}

interface RunResult {
  ok: boolean;
  summaryId?: number;
  contentHtml?: string;
  messageCount: number;
  error?: "too_few_messages" | "llm_failed" | "disabled";
}
```

### 步骤

1. 解析 mode → `{windowStart, windowEnd, maxMessages}`。`recent` 不看时间只 limit count。`date` 按 `aiConfig.summaryConfig.timezone`（默认 `Asia/Shanghai`）计算当天 00:00 到 23:59:59，转 UTC 用于 DB 查询。
2. 查 `conversationMessages`：`botId + chatId + role IN roleFilter + createdAt BETWEEN windowStart AND windowEnd`，按 id 升序 limit maxMessages。
3. 若 <5 条 → 返回 `{ok:false, error:"too_few_messages", messageCount:N}`，并写 history 行（content=""，errorMessage="too_few_messages"）。
4. 格式化消息块（见下）。
5. 组装 prompt：system 取 override/default；user = 所有消息块 concat。
6. 调 `chat-model-store.createClient(botId, chatId)`；模型优先级：`configOverrides.modelId` → `aiConfig.summaryConfig.modelId` → `aiConfig.model`。temperature=0.4, max_tokens=4096。
7. 捕获 token usage → 写 `token_usage`（trigger="summary"）。
8. 渲染 HTML：`wrapSummaryHtml(llmOutput)`。
9. 写 `chat_summaries` 行。
10. 返回 `{ok:true, summaryId, contentHtml, messageCount}`。

### 消息格式化

```ts
function formatMessages(msgs: ConvMessageRow[], chatId: number): string {
  return msgs.map(m => {
    const link = messageLink(chatId, m.meta?.tgMessageId as number | undefined);
    const body = dispatchContent(m.content, m.meta);
    return `====================\n${m.userName ?? "未知"}:\n${body}${link ? "\n" + link : ""}`;
  }).join("\n");
}

function dispatchContent(content: string, meta: unknown): string {
  const m = meta as { photoFileId?: string; documentFileName?: string; replyToMessageId?: number } | null;
  if (m?.photoFileId) return "[图片]" + (content ? ` ${content}` : "");
  if (m?.documentFileName) return `[文件:${m.documentFileName}]`;
  if (m?.replyToMessageId) return `（回复消息 id ${m.replyToMessageId}）${content}`;
  return content.length > 2000 ? content.slice(0, 2000) + "…" : content;
}

function messageLink(chatId: number, tgMessageId?: number): string {
  if (!tgMessageId) return "";
  const s = String(chatId);
  const short = s.startsWith("-100") ? s.slice(4) : String(Math.abs(chatId));
  return `https://t.me/c/${short}/${tgMessageId}`;
}
```

**预检 TODO**：核对 `ConversationStore.addMessage` 调用点，确认 `meta.tgMessageId` 已采集。若缺失 → 写 plan 时加为前置任务。

## Prompt + HTML 格式化

### 默认 System Prompt

```ts
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
```

第 5 条约束原因：Telegram `<blockquote>` 不能嵌套，LLM 自产 `>` 引用会撞外层 expandable 壳。

### Prompt 优先级

```
summary_configs.customPrompt
 ?? aiConfig.summaryConfig.systemPrompt
 ?? DEFAULT_SUMMARY_SYSTEM_PROMPT
```

### 输出包装

项目 `packages/bot/src/utils/format.ts` 已有 `marked + telegramRenderer`（markdown → tg HTML），自带 `<blockquote>` 映射。Summary 整段包 `<blockquote expandable>`：

```ts
// 从 format.ts 导出 renderMarkdownToTelegramHtml（若未导出）
function wrapSummaryHtml(llmMarkdown: string): string {
  const inner = renderMarkdownToTelegramHtml(llmMarkdown).trim();
  return `<blockquote expandable>${inner}</blockquote>`;
}
```

发送走 `parse_mode: "HTML"`，与现有 AI 回复主管线一致。

### 分段

- Summary 一般 <2000 字符，expandable 折叠后显示「点击展开」更紧凑。
- HTML >4000 字符：按顶层 markdown 段落切，每段独立包 `<blockquote expandable>` 分条发送。走现有 `aiConfig.messageConfig.autoSplitThreshold` / `splitDelayMs`。

## Panel API + UI

### API 路由

`packages/server/src/routes/summary.ts`（新）。链式注册进 `createApp()`：

```ts
.route("/api/summary", createSummaryRoutes({ db, summaryService, configService }))
```

端点：

| Method | Path | 功能 |
|--------|------|------|
| GET | `/api/summary/configs?botId=` | 列表 |
| GET | `/api/summary/configs/:id` | 详情 |
| POST | `/api/summary/configs` | 创建 |
| PATCH | `/api/summary/configs/:id` | 更新 |
| DELETE | `/api/summary/configs/:id` | 删除 |
| POST | `/api/summary/configs/:id/trigger` | 立即手动触发（忽略冷却） |
| GET | `/api/summary/history?botId=&chatId=&page=&limit=` | 历史分页 |
| GET | `/api/summary/history/:id` | 单条详情（带 content） |
| DELETE | `/api/summary/history/:id` | 删历史 |

Zod schema 入参校验，风格对齐现有 rss routes。

### Panel 前端

`packages/panel/src/pages/summary/`（新）：

- `list.tsx`：配置列表。列：chat（显示名/id）、定时、窗口、最近触发时间、历史数、启用开关、操作（编辑/立即触发/删）。
- `form.tsx`：create/edit 复用。字段 chatId（数字 + 下拉「活跃 chat」来自 `/api/conversations`）、isActive、scheduleHour/Minute（可空 → 仅手动）、windowHours、maxMessages、cooldownSeconds、accessMode、modelId（下拉 aiConfig.models）、customPrompt（textarea 带「显示默认 prompt」按钮）。
- `history.tsx`：历史分页，点开查看 content（渲染 markdown 预览 + 原文切换）。按 chat 筛选。

Refine resources 注册进 `packages/panel/src/main.tsx`。

### Bot 详情页集成

现有 `/bots/:id` tabs 加「总结」tab，嵌入 list + history。样式与 RSS tab 对齐。

### aiConfig 面板表单

现有 AI 配置页新增「群聊总结」分组：enabled + 全局默认参数 + 可选全局定时 + 可选 summaryModel + 可选 systemPrompt。

## 错误矩阵

| 情况 | 行为 |
|------|------|
| `aiConfig.summaryConfig.enabled=false` | `/summary` 回「群主未启用群聊总结」；cron 跳过 |
| `saveGroupContext="none"` 且目标群 | 命令层前置校验 → 提示「请先开启群聊上下文采集」 |
| 窗口内 <5 条消息 | 不调 LLM；回「消息太少，无需总结」；写 history（errorMessage="too_few_messages"） |
| 冷却未到 | 回「⏱ 还需 Xs，稍后再试」 |
| `accessMode="admin"` 且非 admin | 回「仅管理员可用」 |
| LLM 调用失败 | 捕获 → 写 history 带 errorMessage → 回「总结失败：{短 reason}」 |
| 模型超 token 限制 | 按 char 估算，截断最早消息至 ~80% ctx |
| HTML 渲染失败 | 回退 plain text 发送 |
| `meta.tgMessageId` 缺失 | 不带链接正常总结；启动时 warn 一次 |
| 多实例/双触发 | 乐观锁 UPDATE RETURNING |
| bot 停止中 | `botPool.isRunning(botId)` 前置过滤 |

## 边界决策（首版 YAGNI）

- **不做图像多模态**：`meta.photoFileId` → 文本 `[图片]` 占位。
- **不做 RAG/向量检索**：全量喂窗口消息；未来 `/ask` 复用时再接。
- **不做跨天分批**：>72h 窗口拒绝。
- **不引入 vitest**：无测试框架先用手测。

## 测试策略

项目当前无测试框架。首版不引入。替代：

1. **纯函数手测**：`parseSummaryArgs`、`formatMessages`、`wrapSummaryHtml`、`messageLink` — 提供输入/期望输出作 PR self-review。
2. **集成冒烟**：
   - dev 启服务 → 给测试群发几条消息 → `/summary 10` → 肉眼检 HTML/折叠/链接
   - Panel 建 per-chat config + 手动触发 → 查 DB history
   - 调 scheduleHour/Minute 到近几分钟后 → 等 cron → 检自动触发
3. **错误路径**：手动造失败（错 apiKey、关 saveGroupContext）验文案

## 实施顺序

1. Schema + drizzle migration：`summary_configs` + `chat_summaries` + `AiConfigJson.summaryConfig` + `AiConfigStored.summaryConfig`
2. Shared 类型：`SummaryMode`、`SummaryConfigRecord`、`ChatSummaryRecord`
3. 预检：核对 `ConversationStore.addMessage` 调用点补 `meta.tgMessageId` 采集
4. `SummaryRunner`
5. `SummaryConfigService`
6. `ChatSummaryService`（cron + triggerManual + 冷却 + 全局 fallback）
7. Server 路由 `/api/summary/*`，链式注册 `createApp()`
8. Bootstrap 连线：`server/src/index.ts` 起 service + shutdown；注入 BotManager → createBot
9. Bot 命令：`summary.ts` + `parseSummaryArgs` + 注册 + help + setMyCommands
10. Panel CRUD：configs list/form + history + bot 详情 tab
11. aiConfig 面板表单：总结分组
12. 冒烟测试 + `pnpm lint / typecheck / fmt:check` + commit

## 验收标准

- `pnpm lint / typecheck / fmt:check` 全绿
- dev 环境手动 `/summary`、`/summary N`、`/summary Nh`、`/summary today|yesterday` 全部成功
- per-chat 定时触发成功（靠调近时间 + 等待 cron）
- Panel CRUD 建/编/删/触发历史查看无报错
- 错误矩阵每条文案可复现
