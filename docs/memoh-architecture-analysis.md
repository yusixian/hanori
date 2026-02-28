# Memoh Agent 架构深度分析

> 来源：[github.com/memohai/Memoh](https://github.com/memohai/Memoh)
> 分析时间：2026-03-01

## 概览

Memoh 是一个**三层多语言 Agent 系统**：

- **Go 后端**（`:8080`）— 编排 + 状态管理
- **TypeScript/Bun Agent Gateway**（`:8081`）— LLM 推理 + 工具执行
- **Vue 3 前端**（`:8082`）— 管理 UI

Agent 逻辑分为两个 TypeScript 层：

- `agent/` — 轻量 Elysia HTTP 网关（路由 + 认证）
- `packages/agent/` — `@memoh/agent` 库（核心 agent 逻辑，可复用）

---

## 1. Agent 核心：闭包工厂模式

核心是 `createAgent()` 工厂函数（`packages/agent/src/agent.ts`），**非类而是函数式闭包**，返回一组方法：

```typescript
{
  (stream, ask, askAsSubagent, triggerSchedule, triggerHeartbeat);
}
```

关键设计：**Agent 本身无状态**，所有对话状态外化到 Go 服务端的 PostgreSQL。每次请求创建新 agent 实例。

### AgentParams 参数

```typescript
interface AgentParams {
  model: ModelConfig; // LLM 配置（provider, model ID, API key）
  activeContextTime?: number; // 加载多少分钟的历史（默认 24*60）
  allowedActions?: AgentAction[]; // 允许的工具类别白名单
  mcpConnections?: MCPConnection[]; // 外部 MCP 服务器连接
  channels?: string[]; // bot 所在的所有平台频道
  currentChannel?: string; // 当前活跃频道
  identity?: IdentityContext; // bot ID, container ID, display name
  auth: AgentAuthContext; // bearer token + base URL
  skills?: AgentSkill[]; // 技能定义（name + content）
  inbox?: InboxItem[]; // 未读的跨频道 inbox 项
}
```

### 多模式调用

| 方法                 | 入口                           | 说明                                  |
| -------------------- | ------------------------------ | ------------------------------------- |
| `ask()`              | `POST /chat/`                  | 同步，返回完整响应                    |
| `stream()`           | `POST /chat/stream`            | SSE 流式，产出 `AgentStreamAction` 块 |
| `triggerSchedule()`  | `POST /chat/trigger-schedule`  | Cron 触发的定时任务                   |
| `triggerHeartbeat()` | `POST /chat/trigger-heartbeat` | 主动式周期性后台检查                  |

---

## 2. LLM 集成：Vercel AI SDK

通过 `createModel()` 工厂（`packages/agent/src/model.ts`）统一适配四家 LLM：

```typescript
export const createModel = (model: ModelConfig) => {
  switch (model.clientType) {
    case ClientType.OpenAIResponses:
      return createOpenAI({ apiKey, baseURL })(modelId);
    case ClientType.OpenAICompletions:
      return createOpenAI({ apiKey, baseURL }).chat(modelId);
    case ClientType.AnthropicMessages:
      return createAnthropic({ apiKey, baseURL })(modelId);
    case ClientType.GoogleGenerativeAI:
      return createGoogleGenerativeAI({ apiKey, baseURL })(modelId);
  }
};
```

### Reasoning 支持

Extended thinking 按 provider 分别处理：

```typescript
// Anthropic: { anthropic: { thinking: { type: 'enabled', budgetTokens: N } } }
// OpenAI:    { openai: { reasoningEffort: 'low' | 'medium' | 'high' } }
// Google:    { google: { thinkingConfig: { thinkingBudget: N } } }
```

Budget 映射：`{ low: 5000, medium: 16000, high: 50000 }` tokens。

### 无限工具调用循环

```typescript
const { response } = await generateText({
  model,
  messages,
  system: systemPrompt,
  stopWhen: stepCountIs(Infinity), // 无步数限制
  prepareStep: () => ({ system: systemPrompt }),
  tools,
});
```

Agent 持续执行工具直到模型自己决定停止生成工具调用并产出最终文本响应。**无人为步数上限**。

---

## 3. 工具架构

### 工具分类（7 大类）

```typescript
export enum AgentAction {
  Web = "web", // 网页抓取
  Message = "message", // 消息发送
  Contact = "contact", // 联系人管理
  Subagent = "subagent", // 子 agent
  Schedule = "schedule", // 定时任务
  Skill = "skill", // 技能激活
  Memory = "memory", // 记忆搜索
}
```

通过 `allowedActions` 白名单控制每个 bot 的能力边界。

### 工具装配

```typescript
export const getTools = (actions, { fetch, model, identity, auth, enableSkill }) => {
  const tools: ToolSet = {}
  if (actions.includes(AgentAction.Web))      Object.assign(tools, getWebTools())
  if (actions.includes(AgentAction.Subagent)) Object.assign(tools, getSubagentTools(...))
  if (actions.includes(AgentAction.Skill))    Object.assign(tools, getSkillTools(...))
  return tools
}
```

内置工具与 MCP 工具合并为一个扁平 `ToolSet` 传给 AI SDK。

### 内置工具

| 工具                                 | 功能                                          |
| ------------------------------------ | --------------------------------------------- |
| `web_fetch`                          | URL 抓取，自动转换为 markdown/JSON/XML/纯文本 |
| `use_skill`                          | 运行时激活技能，动态注入 prompt 片段          |
| `query_subagent`                     | 递归创建子 agent，有独立持久化上下文          |
| `list_subagents` / `delete_subagent` | 子 agent 管理                                 |

### MCP 工具集成

使用 `@ai-sdk/mcp` 的 `createMCPClient` 连接外部 MCP 服务器，支持三种传输：

- **HTTP / SSE** — 直接 HTTP/SSE 连接
- **stdio** — 通过 Go 服务端代理：agent POST 到 `/bots/:botId/mcp-stdio`，Go 在容器内启动 stdio 进程并返回 HTTP MCP URL

**内置 MCP 服务器**（`cmd/mcp/main.go`）提供容器级工具：文件读写、列表、编辑、命令执行。每个 bot 容器内都有一个本地 MCP 服务器。

启动时自动注入内置 HTTP MCP 连接：

```typescript
const builtins: MCPConnection[] = [
  {
    type: "http",
    name: "builtin",
    url: `${baseUrl}/bots/${botId}/tools`,
    headers,
  },
];
```

提供核心工具：`read`, `write`, `list`, `edit`, `exec`, `send`, `react`, `get_contacts`, `search_memory`, `search_inbox`, `schedule` 等。

---

## 4. 系统提示与上下文管理

### 系统提示结构

```
--- (YAML: 静态头部 — 语言) ---

You are just woke up.
[静态模板指令：工具、记忆、联系人、附件、心跳、调度、子agent、技能...]

## IDENTITY.md     ← 从容器 /data/IDENTITY.md 加载
## SOUL.md         ← 从容器 /data/SOUL.md 加载
## TOOLS.md        ← 从容器 /data/TOOLS.md 加载
[已启用技能 prompts...]
[inbox 项...]

<context>          ← 动态部分（末尾）
--- (YAML: available-channels, current-session-channel,
          max-context-load-time, time-now) ---
</context>
```

**静态/动态分段**是有意设计：静态大块身份/灵魂/工具内容在前，利用 LLM 的 prompt cache 降低成本。

### 身份文件从容器实时读取

每轮对话实时读取三个文件：

- `/data/IDENTITY.md` — bot 身份
- `/data/SOUL.md` — 性格/角色
- `/data/TOOLS.md` — 自定义工具使用指令

**bot 可以在对话中编辑自己的身份文件来改变行为**。

### 历史加载流程（Go 服务端）

`Resolver.resolve()` 组装消息历史：

1. 加载 bot 设置（最大上下文时间、模型、reasoning 配置、inbox 限制）
2. 选择聊天模型（优先级：请求覆盖 > 聊天级覆盖 > bot 设置）
3. Token 预算计算：`historyBudget = maxTokens - overhead`
4. 加载 DB 消息（`now - maxContextTime` 分钟内）
5. 按 token 修剪旧消息，确保不留孤立 `tool` 消息
6. 注入记忆上下文（合成 user 消息）
7. 加载技能
8. 拉取未读 inbox
9. 为用户查询添加元数据头部（消息 ID、发送者、频道、附件路径等）

---

## 5. 记忆架构：mem0 启发的长期记忆

完整的 **Extract → Decide → Apply** 三段式流水线：

### 添加流程（LLM 驱动的事实管理）

1. **Extract**（`LLM.Extract`）— LLM 从对话中提取结构化事实：个人偏好、计划、健康信息、职业细节等
2. **collectCandidates** — 对每个提取的事实在 Qdrant 中搜索相似的已有记忆
3. **Decide**（`LLM.Decide`）— LLM 对比新旧记忆，返回 `ADD/UPDATE/DELETE/NONE` 决策
4. **Apply** — 执行决策：
   - `ADD` → 嵌入 + upsert 到 Qdrant
   - `UPDATE` → 更新已有 Qdrant 点
   - `DELETE` → 从 Qdrant 移除

记忆 prompt 直接改编自 [mem0ai/memory](https://github.com/mem0ai/mem0) 开源项目（Apache-2.0）。

### 混合搜索

- **Dense Vector 搜索** — 文本嵌入 → Qdrant ANN 搜索
- **BM25 关键词搜索** — 精确关键词匹配
- **多模态嵌入** — 图像/视频的独立向量空间
- **RRF 排序融合** — Reciprocal Rank Fusion 合并结果

### 记忆压缩

`Compact` 操作可将多条记忆条目合并为更小集合，带时间衰减感知（旧记忆在合并时优先级降低）。

### 记忆上下文注入

在历史消息前注入合成消息：

```
"Relevant memory context (use when helpful):
- [bot] <fact 1>
- [bot] <fact 2>
..."
```

基于用户查询的 Qdrant 向量搜索结果（top 4 per scope，最多 8 条，每条截断至 220 字符）。

---

## 6. 流式架构

### SSE 分块传输

Gateway 使用自定义 SSE 序列化器将大载荷**分块**为 16KB 片段：

```typescript
export function sseChunked(data: string, chunkSize = 16 * 1024) {
  // 跨多行 "data:" 拆分 > 16KB 的内容
  // 处理 chunk 边界处的 Unicode 代理对
}
```

解决 Go 端 `bufio.Scanner` 的 `ErrTooLong` 问题。

### 流事件类型

```typescript
type AgentStreamAction =
  | { type: "agent_start"; input: AgentInput }
  | { type: "reasoning_start" | "reasoning_delta" | "reasoning_end" }
  | { type: "text_start" | "text_delta"; delta: string }
  | { type: "text_end" }
  | { type: "attachment_delta"; attachments: AgentAttachment[] }
  | { type: "tool_call_start"; toolName; toolCallId; input }
  | { type: "tool_call_end"; toolName; toolCallId; input; result }
  | { type: "agent_end"; messages; usages; reasoning; usage; skills };
```

### 附件流式提取

Agent 文本输出中的 `<attachments>...</attachments>` XML 块被 `AttachmentsStreamExtractor` 流式状态机实时拦截解析，无需额外 API 调用即可将工具生成的文件作为附件呈现。

---

## 7. Heartbeat 心跳：主动式 Agent

定时 cron 触发 agent "醒来"，读取自己维护的 `/data/HEARTBEAT.md` 检查清单。

**Go 端**：cron 调度器按配置间隔（如每 30 分钟）触发 `TriggerHeartbeat`。

**Agent 端**：

1. 读取 `/data/HEARTBEAT.md`
2. 注入为用户消息：`"** This is a heartbeat check automatically triggered by the system **"`
3. 带完整工具 + 系统提示调用 LLM

Agent 要么：

- 回复 `HEARTBEAT_OK`（无事发生）— 系统抑制，用户不可见
- 使用 `send` 工具主动给用户发消息（有重要事项提醒）

**Agent 自己编辑 HEARTBEAT.md** — 这是自修改行为模式。

---

## 8. Skills 运行时注入

Skills 是**可热加载的 prompt 片段**：`{ name, description, content }`。

- 可用技能在系统提示中列出
- Agent 调用 `use_skill("python-expert")` 后，`enableSkill(name)` 将技能加入 `enabledSkills`
- 在每次 `prepareStep()` 时（多步工具链中每步 LLM 调用前），更新后的系统提示会包含已启用的技能内容

Bot 可以在对话中途激活技能。

---

## 9. 多 Agent 编排：双层设计

### Layer 1: Multi-Bot Teams（Go 服务端层）

多 bot 各自在独立容器中运行，通过 `send` 工具互发消息。统一频道路由系统，跨平台身份绑定（Telegram、Discord、Lark、Web 映射同一个人）。

### Layer 2: Subagent（TypeScript 进程内层）

父 agent 通过 `query_subagent` 工具递归创建子 agent：

1. 调用 `client.getOrCreate({ name, description })` 查找或创建子 agent 记录
2. 加载持久化对话上下文
3. 创建**嵌套** `createAgent()` 实例（`allowedActions: [AgentAction.Web]` — 能力受限）
4. 调用 `askAsSubagent()` 执行查询
5. 持久化更新后的消息 + 累计用量

子 agent 特点：

- 有名称和描述（专属系统提示）
- 独立持久化上下文（存储在 PostgreSQL）
- 仅限 Web 工具（不能创建子 agent 的子 agent）
- 独立累计使用统计
- 同步调用（`generateText` 非 `streamText`）

---

## 10. 容器隔离

每个 bot 运行在独立的 **containerd 容器**（Linux）或 Apple Virtualization VM（macOS）。

Agent 通过以下方式访问容器：

1. **MCP Tool Gateway** — `GET /bots/:id/tools` 返回 HTTP MCP 服务器，代理 `exec`, `read`, `write` 等到容器
2. **FS API** — `createFS()` 调用 `/bots/:botId/container/fs/*` 端点读写文件
3. **stdio MCP 桥接** — Go 在容器内启动 stdio 进程，桥接到 HTTP MCP 端点

Agent 的 `/data` 目录是其"家目录"，可自由读写文件、执行命令、安装软件。

---

## 11. 认证流程

Go 服务端在分发请求到 Gateway 时生成 **JWT**。Gateway 使用 Bearer token 中间件。

`createAuthFetcher` 实现**主动 token 刷新**：如果 JWT 在 2 分钟内过期，先调用 `POST /auth/refresh` 再发起 API 请求。确保长时间运行的工具链不会因认证过期而中断。

---

## 关键设计模式总结

| 模式                     | 位置                              | 价值                         |
| ------------------------ | --------------------------------- | ---------------------------- |
| 无状态 per-request agent | `createAgent()` 工厂              | 水平扩展、容错               |
| 无限工具循环             | `stopWhen: stepCountIs(Infinity)` | Agent 自主决定何时完成       |
| Prompt 静态/动态分段     | `system.ts`                       | 利用 LLM prompt cache 降成本 |
| MCP 标准协议             | 工具系统                          | 高度可扩展性                 |
| LLM 驱动的记忆管理       | mem0 三段式                       | 结构化长期记忆               |
| 心跳自修改               | HEARTBEAT.md                      | 主动式 agent 行为            |
| 递归子 agent + 能力限制  | Subagent 系统                     | 安全的多 agent 编排          |
| SSE 分块传输             | 16KB chunking                     | 解决大载荷流式传输问题       |
| 容器隔离                 | containerd / Apple VM             | Agent 独立执行环境           |
| JWT 主动刷新             | Auth                              | 长任务不中断                 |

---

## 对 cos-tool-bot 的参考价值

1. **闭包工厂模式** vs 当前的 `createBot()` — Memoh 的无状态设计可参考
2. **Vercel AI SDK 的 `stopWhen: stepCountIs(Infinity)`** — 实现自主 agent 循环
3. **MCP 工具扩展** — 标准化工具协议，比硬编码工具更灵活
4. **记忆系统** — mem0 的 Extract→Decide→Apply 流水线可借鉴
5. **Prompt 缓存优化** — 静态/动态分段降低 API 成本
6. **Skills 热加载** — 运行时动态注入 prompt 片段
