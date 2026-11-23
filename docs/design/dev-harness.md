# Dev Harness：Telegram 话题群驱动的 AI 交付控制面设计

状态：草案，待确认后分阶段实现；讨论进度见 [dev-harness-progress.md](dev-harness-progress.md)

日期：2026-09-24

## 1. 目标

让 cos-tool-bot 成为个人项目的 AI 交付控制面：在 Telegram 话题群里提 bug 或需求，由 AI 规划、指挥较便宜的 worker 实现，自动验收、提 PR；在群里完成确认、反馈、合并、发版和回滚。

- 小 bug：一句话变成 PR，一键合并；网站合并后自动上线。
- 大需求：AI 先写 spec issue，并建议开独立话题讨论；确认后执行，产出单个 PR 或 stack PR。
- 发版：按变更类型计算版本号；preview 自动频繁发布，stable 需要 owner 确认。
- 回滚：可以指定回滚到某个版本或某个 commit。
- 执行在 owner 的 Mac 上完成（agent、浏览器验收、Electron 打包）；服务器只负责转发、状态和审批。

## 2. 边界

- 写代码的 agent 不在服务器上运行。服务器不 clone 业务仓库、不构建业务镜像。
- 首版只服务 owner 本人：单 owner、单话题群，不做多人协作权限。
- harness 不替代 GitHub：issue、PR、review、Release 仍以 GitHub 为准，bot 保存的是映射和审批状态。
- 不从 Telegram 执行任意 shell。节点只接受有类型的任务。
- 回滚 cos-tool-bot 自身的部署，不在 Telegram 内执行。

## 3. 总体架构

```text
Telegram 话题群 ──► cos-tool-bot server（控制面）◄── GitHub webhook
      ▲              │  配置、请求状态机、审批、卡片、发版、部署
      │              │
      │              ├── GitHub App：合并、打 tag、dispatch、评论
      │              ├── Dokploy API：部署、切镜像、回滚
      │              ├── Lody CLI + daemon：在指定机器上建会话、续聊、查状态
      │              └── Node Gateway（备选，出站 WSS）
      │                        ▲
      │                        │ 各机器主动连接，无需入站端口
      │              ┌─────────┴─────────┐
      │         MBP-64G              Desktop-5090（可选）
      │         Lody 会话 / 自建节点：claude / codex / orca
      │         本机验收：Playwright、Electron、单测
      └──────── 卡片、截图、证据、回报
```

- **GitHub 是任务的持久记录**：每个请求对应一个 issue，每次实现对应 PR。
- **server 是状态与审批的唯一来源**：请求状态、审批记录、节点任务队列都存在 PostgreSQL。
- **节点是执行面**：领取任务，在本机 worktree 中调用 agent，回传进度与证据。

## 4. 配置

配置分三层，都可以用 YAML 声明，也可以在 Telegram 或面板中修改。原则是能配置的都可以配置、每项都有合理默认值；完整字段、默认值与不开放配置的安全底线见 [dev-harness-config.md](dev-harness-config.md)。

| 层         | 位置                                                                                  | 内容                                                   | 谁能改                                                    |
| ---------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| 控制面配置 | server 挂载的 `harness.yaml`（路径由环境变量指定；仓库只提交 `harness.example.yaml`） | 话题群、owner、项目 ↔ 话题绑定、节点、全局默认         | owner；Telegram / 面板修改写入数据库覆盖层，可导出回 YAML |
| 仓库策略   | 各业务仓库的 `.cos/harness.yml`                                                       | 项目类型、验证命令、风险规则、发版与部署策略、角色分配 | 通过 PR 修改；**只读取默认分支上的版本**                  |
| 节点配置   | Mac 上的 `~/.config/cos-harness/node.yaml`                                            | 节点 token、仓库 → 本地路径、可用执行器、并发数        | 仅本机                                                    |

优先级：数据库覆盖层 > `harness.yaml` > 仓库策略中的默认值。

- 修改 `.cos/harness.yml` 的 PR 一律按 T3 处理，防止 agent 在 PR 中调低自己的风险等级。
- `/harness diff` 显示数据库覆盖层与 YAML 的差异，`/harness export` 导出当前生效的 YAML。

### 4.1 `harness.yaml` 示例

```yaml
version: 1
telegram:
  bot: example-dev # BotPool 中启用 harness 的 Bot
  chat_id: -1001234567890
  owners: [123456789]
  topics:
    overview: general
    alerts: existing:12 # 已有话题直接引用 thread id
defaults:
  notify:
    preview: digest # each | silent | digest
    digest_at: "21:00"
projects:
  koyori:
    repo: example-owner/koyori
    topic: auto # 首次应用时由 bot 创建话题并回写 thread id
    nodes: [mbp]
  example-gallery:
    repo: example-owner/example-gallery
    topic: auto
    nodes: [mbp]
nodes:
  mbp:
    label: MBP-64G
  desktop-5090:
    label: Desktop-5090
    enabled: false
```

### 4.2 `.cos/harness.yml` 示例

```yaml
version: 1
kind: electron # web | electron | service | library
verify:
  quick: pnpm lint && pnpm typecheck && pnpm test
  full: pnpm verify
  acceptance: pnpm test:desktop
risk:
  T0: ["docs/**", "**/*.md"]
  T3: [".github/workflows/release*.yml", "scripts/package-*", ".cos/**"]
roles:
  triage: { executor: claude, model: sonnet }
  planner: { executor: claude, model: opus }
  worker: { executor: codex }
  reviewer: { executor: claude, model: fable }
release:
  versioning: release-kit
  notes_dir: docs/releases
  changes_dir: .release/changes
  preview: { on: merge, workflow: release-preview.yml, channel: alpha }
  stable: { approval: owner, confirm: twice }
docs:
  paths: [apps/site/content/docs]
  required_for: [feat, breaking]
deploy:
  target: github-release
```

网站类项目的 `deploy` 示例：

```yaml
deploy:
  target: dokploy
  application: <applicationId>
  image: ghcr.io/example-owner/example-gallery
  on_merge: production
  health: https://gallery.example.com/api/health
```

## 5. Telegram 话题群

### 5.1 布局

- 专用私有超级群，只有 owner 和 bot；bot 是管理员，并拥有 `can_manage_topics`。
- General：跨项目汇总、节点状态、`/harness` 配置命令。
- 每个项目一个话题：项目由 `message_thread_id` 决定，命令里不写项目名。
- 大需求话题：由 bot 建议，owner 确认后创建；标题为 `项目 · #issue 标题`，完成后关闭。
- 告警话题：保留 Dokploy 现有通知。

### 5.2 路由与 AI 分诊

- harness 话题中关闭闲聊式 AI 回复和 JEV 主动参与；bot 只响应命令、回复卡片和分诊。
- 显式命令：`/bug`、`/feature`、`/release`、`/rollback`、`/status`、`/cancel`。
- 非命令消息交给 triage 角色分类，并给出建议按钮，不直接执行：
  - 「看起来是小 bug，直接修？」[修复] [转为需求] [忽略]
  - 「这个需求较大，建议开话题讨论」[开话题] [就在这里] [忽略]
- 回复某张卡片，就是对该请求的反馈（`reply_to_message.message_id` → 请求）。
- 每个请求只有一张卡片，状态推进时原地编辑；只有需要 owner 操作时才发新消息。

### 5.3 卡片

- Telegram 的图片组不能挂按钮，带图消息说明最多 1024 字：卡片 = 一张主截图 + 说明 + 按钮；更多截图通过 [截图] 按钮展开。
- 状态变化时编辑同一张卡片（`editMessageCaption` / `editMessageMedia`），不发新消息。
- 卡片类型：进行中、PR 就绪、spec 待确认、stack 进度、stable 候选、回滚预览、需要你看一下。
- 「打开会话」使用 Lody 会话分享链接，可在 Lody 中接手。

PR 就绪卡片示例：

```text
🟢 PR #124 可以合并 · T1
fix(settings): 保存时显示进度
改了什么：网络慢时保存按钮显示「保存中」，失败提示重试
验证：lint/typecheck/test ✅ · 桌面验收 3/3 ✅ · 截图 4 张
审查：2 条 → 已修 1、说明 1
发版：patch，进入下一个 alpha
上下文 43% · Opus 本周 52% · 5 小时 6%
[✅ 合并] [↩️ 打回] [🖼 截图] [🔍 详情] [🔗 PR]
```

## 6. 请求流程

### 6.1 状态机

| 类型     | 状态                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------ |
| bug      | `received → queued → running → pr_ready → (revising ↺) → merged → shipped`                                         |
| feature  | `received → drafting → spec_review → (revising ↺) → approved → running → stack_ready → merging → merged → shipped` |
| release  | `candidate → confirming → releasing → released → deployed`                                                         |
| rollback | `preview → confirming → deploying → pinned → reverted / unpinned`                                                  |

任意状态都可进入 `cancelled` 或 `failed`；失败时卡片给出原因，并提供 [重试] 按钮。

### 6.2 小 bug

1. `/bug …`（可附截图或语音）→ 建 issue，打 `harness:bug` label → 入队。
2. 节点领取任务后直接做，不限改动文件数，也可以改 T3 路径（T3 只是要求 owner 在 GitHub 合并）。只有需要 issue 没说清的产品决策时才转为 feature，并在卡片上说明原因。
3. 实现 → 验证（`verify.quick` + 按需 `acceptance`）→ 独立 reviewer 审查 → 修复 → 推送分支、开 PR，在 PR 中写入证据。
4. PR 卡片：摘要、风险等级、截图组、preview 链接、CI 状态；按钮 [合并] [打回] [详情]。
5. 合并：server 复核 head SHA 与 checks 后用 GitHub App squash merge，之后按项目策略上线或发 preview。

### 6.3 大需求

1. `/feature …` 或分诊建议 → planner 读代码，把 issue 改写成 spec：背景 / 目标 / 非目标 / 验收标准 / 设计要点 / 拆分计划 / 风险 / 待决问题。
2. 规模较大时建议开独立话题；spec 卡片按钮为 [开始执行] [我有意见] [放弃]。
3. [我有意见] → owner 回复 → planner 更新 issue 并附修订说明 → 新卡片，可多轮。
4. [开始执行] 生成审批记录，绑定 issue 正文的修订版本；此后 issue 再被修改，批准即失效。
5. planner 按拆分计划建 stack，每层交给 worker；stack 卡片按层显示状态。
6. 自底向上合并；每合并一层，下一层 rebase 到新 base 并重新跑 CI，全绿后才出现下一个合并按钮。

### 6.4 编排：服务器管关卡，lead 会话管过程

- 服务器只掌控关卡：spec 确认、PR 就绪、合并、发版、回滚。
- 两个关卡之间，每个请求由一个 lead 会话负责：拆任务、通过 Lody MCP 派较便宜的子会话、安排跨厂商审查、按反馈修改。
- lead 会话的产出由轻量的**交付合同**检查，达标后才推卡片：
  - PR 存在，CI 全绿（服务器直接查 GitHub checks）；
  - 带 release-kit 片段（CI 中 `release-kit check`）；
  - PR 描述有「验证」和「审查」两段；改到 UI 时附截图（形式不限，bot 从 PR 描述中提取图片）。
- 审查默认由 lead 会话自行安排；需要更严格时，可配置为服务器另起独立 reviewer 会话。
- 提示而不拦截：证据之后又有新提交、diff 中删了测试或加了 skip，只在卡片上标注。
- 未达标时，服务器把缺项作为新一轮输入发给 lead 会话；超过 `autoFixRounds` 仍未达标，卡片转为「需要你看一下」并附原因。

### 6.5 自主程度

| 场景                 | 默认                                 |
| -------------------- | ------------------------------------ |
| `/bug`               | 直接开工                             |
| 项目话题中的普通消息 | 分诊后给按钮，由 owner 确认          |
| 回复某张卡片         | 作为该请求的反馈，直接交给 lead 会话 |
| T0 自动合并          | 关闭，按项目开启                     |
| 大需求               | spec 确认后才执行                    |

### 6.6 护栏

护栏全部可配置，按「全局默认 → 项目 → 请求类型」逐层覆盖；也可以在 Telegram 中用 `/harness set <路径> <值>` 临时调整（写入数据库覆盖层，`/harness diff` 可见）。

```yaml
guardrails:
  concurrency:
    perMachine: 4 # 每台机器同时运行的会话数
    perProject: 3
    sameAreaWriters: 1 # 同一项目同一区域同时只允许一个会话写入
  time:
    idleRemindAfter: 45m # 无进展多久后提醒
    runRemindAfter: 6h # 总时长多久后提醒
    hardCancelAfter: null # 默认不自动取消
  autoFixRounds: 2 # CI 失败或审查未过时自动修复的轮数
  quota:
    pauseQueueBelow: 10% # Lody 额度可读取时生效
  autonomy:
    bugStartsImmediately: true
    autoMergeTiers: [] # 例如 [T0]
projects:
  koyori:
    guardrails:
      time: { idleRemindAfter: 90m } # Electron 打包与验收耗时更长
```

- 「区域」默认按仓库策略中的路径分组，lead 会话在 spec 或实现计划中声明将修改的区域；声明缺失时按整个仓库计算。
- 超时只提醒、不自动取消；提醒卡片提供 [继续等] [取消] [打开会话]。

## 7. 执行层

执行层分两级：首选通过 Lody 把任务交给 Mac；只有 Lody 覆盖不到的任务，才使用自建节点。

### 7.1 Lody 执行器（首选）

Lody 的 daemon 已经在各台机器上与 Lody 云端保持连接（当前在线：MBP-64G、Desktop-5090）。Lody CLI 0.100.0 提供的能力：

| 命令                                                                                                                              | 用途                                                |
| --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `lody login`（device flow 或 API key）+ `lody daemon start`                                                                       | server 容器加入 workspace，成为一台只负责调度的机器 |
| `lody session create --machine <id\|name> --local-project <项目> --worktree --agent <配置> --model <模型> --prompt-file - --json` | 在指定机器上建会话，每个任务一个独立 worktree       |
| `lody session chat <id> --prompt-file -`                                                                                          | 把 Telegram 里的反馈作为新一轮输入                  |
| `lody session status\|show\|history <id> --json`                                                                                  | 查询进度与结果，更新卡片                            |
| `lody session cancel <id>` / `archive <id>`                                                                                       | 取消，以及完成后归档                                |
| `lody machine list --online-only --json`                                                                                          | 显示节点在线状态                                    |

- 会话会出现在 Lody 桌面端和手机端，owner 可以随时接手；会话内的 agent 还能用 Lody MCP 再派子会话，即由便宜模型处理子任务。
- 同一套调用可以指定 Desktop-5090 等其他机器，无需额外开发。
- `session create` 需要调用方本机运行 Lody runtime。生产镜像（alpine）无法加载 Lody 的原生模块，因此 daemon 运行在 bookworm-slim 的 `lody-bridge` sidecar 中，server 经带密钥的内网 HTTP 调用白名单内的命令（见 `docs/DEV_HARNESS_LODY.md`）。owner 已实测跨机器创建会话可行。
- 没有事件推送：server 轮询 `session status`，间隔按状态调整。结构化证据仍由 agent 写进 PR（截图、验收报告），bot 从 PR 读取。

额度与上下文：

- `lody machine list --json` 的每台机器带 `raceLimits`（字段名疑似 `rateLimits` 的拼写，读取时两者都兼容），按 provider 给出套餐与时间窗口：`usedPercent`、`windowDurationSeconds`（18000 为 5 小时，604800 为一周）、`resetsAtEpochSeconds`，以及可选的 `label`（如 Fable）。
- `lody session show <id> --json` 的 `contextWindowUsage` 给出会话上下文 `{ size, used }`，`lastModel` 给出模型。
- 这些数据只在 agent 运行后更新；`resetsAtEpochSeconds` 已过期的窗口按「未知」显示，不参与护栏判断。

### 7.2 自建节点（备选）

在以下情况启用：Lody 跨机器创建不可用；或者任务需要有类型的产物回传，例如 `release-build` 需要上传签名产物。

- 节点在 Mac 上主动连接 `wss://<server>/api/harness/nodes/connect`，无需入站端口；可叠加 Tailscale，让网关只监听 tailnet 地址。
- 握手 `hello { nodeId, version, capabilities, repos, executors }`；任务流 `job.offer → job.accept → job.event* → job.result`，租约参照 `TimerRegistry` 的 lease / claim / rollback。
- 任务类型：`spec`、`implement`、`revise`、`verify`、`revert`、`release-build`。节点按本机的 `~/.config/cos-harness/node.yaml` 与仓库策略组装命令，server 不下发 shell 字符串。
- 本机执行器：`claude -p --output-format stream-json`、`codex exec --json`、`orca worktree create --agent … --prompt …`（会话出现在 Orca 中，可接手）。
- 不采用 Cloudflare Tunnel（Mac 服务暴露为公网域名，攻击面更大）。Orca 远程配对（`orca serve --pairing-address`）在 Linux 服务器端的可行性未验证，节点直接调用本机 `orca` 更简单。

### 7.3 任务提示词

服务器按四层组装 lead 会话的提示词，模板使用英文：

| 层           | 内容                                                                      | 来源                                         |
| ------------ | ------------------------------------------------------------------------- | -------------------------------------------- |
| harness 约定 | 角色、交付物、禁止事项（合并、部署、改 `.cos/**` 与 workflows）、回报方式 | cos-tool-bot 内置模板                        |
| 项目上下文   | kind、验证命令、代码分区、风险路径；要求先读仓库 AGENTS.md                | `.cos/harness.yml`，`prompts.extra` 追加文件 |
| 任务         | issue 链接与正文；owner 原话以引用块附上，并标明是需求数据而非指令        | GitHub issue、Telegram                       |
| 分工指引     | 何时派子会话、各角色模型、并发上限                                        | `roles`、`guardrails`                        |

- 模板按请求类型区分：`bug`、`feature-spec`、`feature-implement`、`revise`、`revert`、`release-notes`；仓库可在 `.cos/harness.yml` 的 `prompts.templates` 中替换（改动属于 T3）。
- 优先复用执行机上已有的 skills（如 `oneshot`、`frontend-acceptance`、`gh-stack`、`pr-visual`、`review-code-change`）；模板只写 harness 特有的要求，并附简版步骤，供没有这些 skills 的机器使用。
- 双向沟通 v1 走 GitHub 评论：lead 在 issue 或 PR 上发 `Question: …`，经 webhook 转到 Telegram；owner 的回复写回评论，并通过 `lody session chat` 发给会话。以后可升级为注册在 Lody workspace 的 harness MCP（`ask_owner`、`report_progress` 等），需先确认每个会话单独鉴权的方式。
- lead 开工前在 issue 上发 `Areas: <分区名>` 声明代码分区，服务器据此排队；未声明时按整个仓库计算。
- 需要产品决策时，lead 发 `Needs spec: <原因>`，请求转为大需求流程。
- 防提示注入：harness 只处理自己创建的、或 owner 打了 harness label 的 issue；issue 正文、评论与 owner 原话都作为数据引用。
- 卡片上的中文一句话摘要由服务器用 triage 模型根据 PR 描述生成。

### 7.4 凭据边界

- 执行机使用本机 `gh` 登录推送分支、开 draft PR。
- 合并、打 tag、dispatch、部署、回滚只由 server 执行（GitHub App、Dokploy API key）；执行机拿不到这些凭据。
- server 持有的 Lody 凭据能在 owner 的机器上启动 agent，属于最高敏感级别：加密存储、不进入日志和模型工具结果；harness 专用的 agent config 使用受限的 permission mode。
- 执行机只处理配置中列出的本地项目。

## 8. 审批与安全

- 只接受 `owners` 中的 `from.id`，且只在已配置的话题群内接受。
- `callback_data` 只携带审批记录 ID；记录绑定 PR + head SHA、issue 修订版本或版本号 + commit SHA，带 TTL，只能消费一次，执行前重新校验。
- 审批记录持久化，重启后仍然有效或明确提示过期；不复用只存在内存的 `PendingAdminActionRegistry`。
- 执行后立即编辑原消息、移除按钮，并写入审计事件。

风险等级：

| 等级                  | 例子                                    | Telegram 中的操作                   |
| --------------------- | --------------------------------------- | ----------------------------------- |
| T0                    | 文档、文案、仅新增测试                  | checks 全绿后自动合并，进入每日汇总 |
| T1                    | 样式、展示组件、小 fix                  | 一键合并                            |
| T2                    | 业务逻辑、数据请求                      | 需要先打开证据或 preview，才能合并  |
| T3                    | 鉴权、迁移、发布流水线、签名、`.cos/**` | 只通知，在 GitHub 网页上合并        |
| stable 发布、生产回滚 | —                                       | 二次确认                            |

## 9. 发版与文档

### 9.1 工具选型

采用自写的小型 CLI（暂名 `release-kit`），独立仓库发布为 npm 包，三个仓库及其他项目共用，设计见该仓库文档；不引入 Changesets、release-please 或 knope。

| 候选           | 不采用的原因                                                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Changesets     | frontmatter 只允许「包名: major/minor/patch/none」（`packages/parse/src/index.ts`），不能附带 `docs` 等字段；pnpm monorepo 中只跟踪根 `package.json` 的配置未验证 |
| release-please | 版本信息来自 commit 标题，承载不了多段落的发版说明；prerelease 只在 release PR 循环里递增，不适合按需出 preview                                                   |
| knope          | alpha 序号自增未确认；维护者少                                                                                                                                    |

共同点：三者都需要自写 `docs/releases/vX.Y.Z.md` 渲染层和 0.x 规则，引入后省下的只有「读取片段 + 计算版本」，这部分自写也不超过几百行，而且可以直接输出 bot 需要的结构化结果。若以后维护成本过高，knope 是备选。

### 9.2 片段格式

每个面向用户的 PR 新增一个 `.release/changes/<slug>.md`，并行 PR 之间不会冲突：

```md
---
type: fix # fix | feat | breaking | internal
docs: updated # updated | not-needed
---

设置页在网络较慢时保存没有反馈，现在会显示保存中状态。
```

### 9.3 版本规则

- 版本号由片段的最高级别决定：`fix` → patch，`feat` → minor，`breaking` → major；0.x 阶段 `breaking` 按 minor 处理并在说明中标出；升到 1.0 只能显式传参。
- `internal` 不触发发版。

### 9.4 CLI

| 命令                                  | 输出                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `release-kit plan --json`             | 当前版本、下一个版本、级别、包含的片段与 PR；供 CI 与 bot 读取                              |
| `release-kit preview --channel alpha` | 由已有 tag 计算下一个 `X.Y.Z-alpha.N`；只写入构建工作区，不提交                             |
| `release-kit apply`                   | 更新根 `package.json`，按仓库现有的三段式模板写 `docs/releases/vX.Y.Z.md`，删除已消费的片段 |

### 9.5 CI 检查

- PR 标题符合 Conventional Commits（`amannn/action-semantic-pull-request`），并且与片段 `type` 一致。
- 改动产品代码、标题又不是 `docs` / `chore` / `test` / `ci` 时，必须有片段。
- `feat` 或 `breaking` 片段的 `docs` 为 `updated` 时，必须改到 `docs.paths`；为 `not-needed` 时，卡片上提示 owner。

### 9.6 发布流程

- **preview**（Electron）：合并或 dispatch 后，`release-kit preview` 计算版本 → 在该 commit 上打 `vX.Y.Z-alpha.N` tag → 构建 → GitHub prerelease，说明来自尚未消费的片段。main 上不产生版本 commit。
- **stable**：bot 读取 `plan` 推送候选卡片 → 二次确认 → dispatch `release.yml`，由 GitHub App 开 release PR（`release-kit apply` 的结果）→ checks 通过后 bot 合并 → 打 tag → `gh release create --notes-file docs/releases/vX.Y.Z.md` → 文档站同步（cos-tool-bot 沿用现有 `packages/docs/scripts/sync-release.mjs`）→「Release 已发布」与「生产部署已验证」分开回报。
- **web 项目**：合并即部署生产，不受版本发布影响；版本发布是按批次记录的里程碑，确认方式由 `release.stable` 决定（`confirm` 或 `auto`）。
- koyori 的 `assertAlphaVersion` 需要扩展，以接受 stable 版本号；`docs/releases/unreleased.md` 迁移为片段目录。

## 10. 部署与回滚

- 网站：CI 为 main 上每个 commit 构建镜像，推送到 registry，打 `sha-<短 SHA>` 标签；stable 额外打 `vX.Y.Z` 标签。部署即通过 Dokploy `application.saveDockerProvider` 换 tag，再 `application.deploy`。
- 部署是否成功要看容器状态和 health 接口，不能只看 `deployment.all` 的 `done`。
- `/rollback <版本|commit>`：
  - 预览：撤下的 PR、区间内的数据库迁移；有迁移时标红。
  - 确认后切换镜像，等待 health 通过。
  - 生产标记为 pinned，暂停 main 的自动部署。
  - 卡片提供 [创建 revert PR] [解除固定]。
- Dokploy 原生的 registry 回滚（`rollback.rollback`）作为备用路径。
- Electron：`electron-updater` 默认不降级，回滚走 revert + 新 patch；止血手段是撤下有问题的 Release 或其更新元数据。
- cos-tool-bot 自身：Telegram 中只提供 [创建 revert PR]，部署回滚在 Dokploy 网页上操作。

## 11. 数据模型草案

| 表                         | 关键字段                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `harness_projects`         | key、repo、topic thread id、kind、生效的策略快照（含来源 commit）                   |
| `harness_requests`         | project、type、state、issue、PR 列表、卡片 message id、thread id、创建人            |
| `harness_approvals`        | request、action、绑定对象（SHA / 修订 / 版本）、`expires_at`、`consumed_at`、actor  |
| `harness_jobs`             | request、执行器（lody / node）、机器、Lody session id 或节点任务 id、state、attempt |
| `harness_nodes`            | 仅自建节点：nodeId、label、token 哈希、capabilities、`last_seen_at`                 |
| `harness_events`           | 审计流水                                                                            |
| `harness_config_overrides` | 路径、值、修改人、时间                                                              |

## 12. 分阶段

| 阶段            | 内容                                                                         | 验收                                                    |
| --------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------- |
| H1 配置与话题   | `harness.yaml` 加载与校验、项目绑定、自动建话题、`/status`、harness 话题模式 | 应用 YAML 后自动出现项目话题；harness 话题中 bot 不闲聊 |
| H2 PR 卡片      | GitHub webhook（签名校验）、持久化审批、PR 卡片、合并                        | 手动开的 PR 能在话题里一键合并；重启后按钮仍有效        |
| H3 执行与小 bug | Lody 执行器、提示词模板、`/bug` 闭环                                         | 在 koyori 话题里 `/bug` → PR 卡片 → 合并                |
| H4 大需求       | AI 分诊、建议开话题、spec issue、批准、stack 执行与逐层合并                  | 一个两层 stack 需求走完全程                             |
| H5 发版与文档   | 版本规则、片段、preview/stable 卡片、文档检查                                | koyori 发出一次 alpha 和一次候选确认                    |
| H6 部署与回滚   | Dokploy 适配、镜像 tag、pin、迁移检测，接入 example-gallery                  | 回滚到指定 commit，并创建 revert PR                     |
| H7 扩展         | 自建节点（按需）、Mini App 证据页、每日汇总、T0 自动合并                     | —                                                       |

## 13. 待决问题

已定：

- harness 使用新的工作专用 Bot，不承载群聊配置。
- 镜像 registry：GHCR 与 Docker Hub 均可，默认 GHCR（与 GitHub Actions 同一身份）。
- 版本工具：自写 `release-kit`（见第 9 节）。

待定：

1. `release-kit` 放在哪里：独立仓库并发布到 npm，或放在某个仓库里供其他仓库引用。
2. server 容器（Linux）中运行 `lody daemon` 的方式与资源占用。
3. koyori stable 前置项：Developer ID 公证、品牌素材授权、Electron 许可文件。
4. example-gallery 的 GitHub 远端 owner、名称与可见性。

## 14. 参考

- 现有能力：`docs/GITHUB_APP.md`、`docs/GITHUB_ACCESS.md`、`docs/PI_CODING_AGENT.md`、`docs/DOKPLOY_DEPLOYMENT.md`、`docs/PUBLIC_DOCUMENTATION.md`
- 话题相关代码：`packages/bot/src/handlers/ai-reply.ts`、`packages/bot/src/utils/stream-reply.ts`
- Dokploy 回滚：https://docs.dokploy.com/docs/core/applications/rollbacks
- Lody CLI：https://lody.ai/docs/cli/ ；本机 CLI 0.100.0 的 `lody session create --help`
- 调研：Anthropic「Effective Harnesses for Long-Running Agents」、Claude Code Code Review 文档、GitHub Copilot coding agent 文档、release-please 与 electron-builder channels 文档
