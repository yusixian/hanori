# Dev Harness 实现清单

更新：2026-09-24

依据 [dev-harness.md](dev-harness.md)、[dev-harness-config.md](dev-harness-config.md)、[dev-harness-progress.md](dev-harness-progress.md)。按阶段连续推进，阶段末集中验证。

## 通用约定

- 代码位置：`packages/server/src/harness/`（配置、服务、GitHub、Lody、Dokploy 适配）、`packages/bot/src/harness/`（命令、话题路由、卡片渲染、回调）、`packages/database`（`harness_*` 表与迁移）、`packages/shared`（类型、命令元数据）。
- 复用现有设施：`ActiveCommandRegistry` 与 `TELEGRAM_COMMAND_CATALOG` 注册命令，`TimerRegistry` 的 lease/claim 模式做持久化任务，GitHub App 凭据服务取 installation token，`DbLogger` 与审计表记录事件。
- harness 只对 `harness.yaml` 中 `telegram.bot` 指定的 Bot 生效；其他 Bot 行为不变。
- 配置文件路径由 `HARNESS_CONFIG_PATH` 指定；未设置时 harness 完全关闭。
- 外部依赖（Lody CLI、GitHub、Dokploy）都经过适配器接口；缺失时降级提示，不影响 Bot 其余功能。
- 每个阶段附单元测试；用户可见功能按 AGENTS.md 同步 `packages/docs/content/docs/` 的公开指南。

## H1 配置与话题

| #   | 任务                                                                                                                                                 | 完成标准                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1.1 | `harness.yaml` 与 `.cos/harness.yml` 的 zod schema、默认值、按 `kind` 推断、逐层合并、时长与百分比解析                                               | 单测覆盖默认值、合并顺序、非法值定位到字段路径 |
| 1.2 | 配置加载：启动读取、`/harness reload` 重读，失败时保留旧配置                                                                                         | 写错 YAML 时 Bot 仍运行并报告错误字段          |
| 1.3 | 数据库：`harness_projects`（绑定与 thread id）、`harness_config_overrides`、`harness_events`；迁移                                                   | `pnpm db:generate` 产出有序迁移                |
| 1.4 | 覆盖层：`/harness config`、`set`、`unset`、`diff`、`export`；`set` 支持 `--ttl`；安全字段拒绝临时覆盖                                                | 单测覆盖锁定字段与 TTL 到期                    |
| 1.5 | 访问控制：只接受 `owners`、只在配置的群内响应 harness 命令与按钮                                                                                     | 非 owner 与其他群的消息被忽略                  |
| 1.6 | 话题：`topic: auto` 的项目自动 `createForumTopic` 并持久化 thread id；按 thread id 路由到项目；General 话题单独处理                                  | 应用配置后出现项目话题；重启后不重复创建       |
| 1.7 | harness 话题模式：该群内不走闲聊 AI 回复与 JEV 主动参与（普通消息先留给 H4 分诊，H1 回复提示用法）                                                   | 在 harness 群发普通消息，Bot 不闲聊            |
| 1.8 | Lody 适配器（只读部分）：`machine list --json`（在线状态、`raceLimits`/`rateLimits`）、`session show --json`（`contextWindowUsage`）；CLI 路径可配置 | 未安装 Lody 时 `/status` 显示「执行层未配置」  |
| 1.9 | `/status`（项目话题：仓库、默认分支、执行机、排队）与 `/quota`（按机器与 provider 列窗口、用量、重置时间，过期窗口标「已过期」）                     | 输出与设计示例一致                             |

## H2 PR 卡片与合并

| #   | 任务                                                                                                                                   | 完成标准                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 2.1 | GitHub webhook 路由：签名校验、按 delivery id 幂等、只处理配置中的仓库                                                                 | 重复投递只处理一次                            |
| 2.2 | `harness_requests`、`harness_approvals` 表；审批记录绑定 PR + head SHA，TTL、一次性消费、执行前复核                                    | 重启后按钮仍有效；过期或已消费时明确提示      |
| 2.3 | PR 卡片：主截图（从 PR 描述提取图片，无图时纯文本）+ 说明 + 按钮；状态变化时原地编辑；中文摘要由 triage 模型生成，失败时回退到 PR 标题 | 手动开 PR 后 30 秒内出现卡片，CI 变化更新卡片 |
| 2.4 | 交付合同（从轻）：CI 全绿、`sections`、截图、发版片段（release-kit 未接入前视为 optional）；flags 只提示                               | 缺项时卡片显示缺什么                          |
| 2.5 | 合并：复核 SHA 与 checks → GitHub App squash merge；新 push 使旧按钮失效并刷新卡片                                                     | 在沙盒仓库走通                                |
| 2.6 | 风险等级：按路径计算 T0–T3，固定 T3 路径；T3 不给合并按钮；T2 合并前在卡片上就地展开详情并确认                                         | 单测覆盖路径匹配                              |
| 2.7 | 审计：每次按钮操作写 `harness_events`                                                                                                  | 可在面板或日志中查到                          |
| 2.8 | 沙盒仓库 `example-owner/harness-sandbox`（私有，极小网页项目 + CI）                                                                         | owner 已同意创建                              |

## H3 Lody 执行与小 bug 闭环

| #   | 任务                                                                                                                                                                                                                   | 完成标准                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 3.1 | Lody 适配器（写操作）：`session create --machine --local-project --worktree --agent --model --prompt-file - --json`、`session chat`、`session status`、`cancel`、`archive`；server 容器内运行 `lody daemon` 的部署说明 | 在 MBP 上建出会话                |
| 3.2 | 提示词模板：四层组装，`bug`、`revise` 两类先落地；`prompts.extra`、`prompts.templates`、`preferSkills`                                                                                                                 | 模板渲染单测                     |
| 3.3 | `/bug`：建 issue（打 label）→ 入队 → 按护栏并发与分区调度 → 建会话 → 卡片「进行中」                                                                                                                                    | 卡片显示机器、模型、耗时、上下文 |
| 3.4 | 评论协议：解析 `Areas:`、`Question:`、`Needs spec:`；问题转发到 Telegram，回复写回评论并 `session chat`                                                                                                                | 来回一轮走通                     |
| 3.5 | 回复卡片即反馈：写 PR comment + `harness:revise` label + `session chat`                                                                                                                                                | PR 更新后卡片刷新                |
| 3.6 | 护栏：无进展提醒、总时长提醒、`autoFixRounds`、额度阈值暂停或降级、每日会话上限                                                                                                                                        | 用短 TTL 覆盖测试提醒            |
| 3.7 | koyori 接入：`.cos/harness.yml`（由 harness 开 PR 提交，T3，owner 在 GitHub 合并）                                                                                                                                     | 连续 3 个真实小 bug 只需点合并   |

## release-kit v0.1（并行，独立仓库）

| #   | 任务                                                                                                                    | 完成标准                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| R1  | 仓库骨架：TypeScript + ESM + tsdown + vitest，bin `release-kit`，包名 `@coszone/release-kit`，MIT                       | `pnpm build` 产出可执行 bin               |
| R2  | 配置 schema（zod → JSON Schema）、预设 `web`/`electron`/`library`、`init [--agents]`                                    | 生成配置、片段目录、AGENTS.md 片段、Skill |
| R3  | 片段解析与校验、`add`、`check`（片段格式、kind 与 PR 标题、必需片段、正文规则）                                         | 错误带 code、file、line、fix              |
| R4  | `plan`（0.x 规则、原因说明）、`preview`（基于 tag 的 `-alpha.N`）、`apply`（版本文件、说明文件、删除片段、`--dry-run`） | fixture git 仓库测试覆盖                  |
| R5  | `describe`、统一 `--json` 输出与退出码；中英文默认模板                                                                  | 快照测试                                  |
| R6  | README、发布 workflow（Trusted Publishing，暂不触发）                                                                   | 文档齐全                                  |

H4–H7 在 H3 验收后按 dev-harness.md 第 12 节继续。
