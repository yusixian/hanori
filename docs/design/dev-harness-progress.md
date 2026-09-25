# Dev Harness 讨论进度

更新：2026-09-25

跨会话接续时先读本文，再读 [dev-harness.md](dev-harness.md)（架构与流程）、[dev-harness-config.md](dev-harness-config.md)（配置字段与默认值）和 [dev-harness-plan.md](dev-harness-plan.md)（实现清单）。

## 1. 目标

在 Telegram 话题群里提 bug 或需求，由 AI 规划并指挥较便宜的 sub-agent 迭代，自动验收、提 PR；在群里完成确认、反馈、合并、发版和回滚。执行在 owner 的 Mac 上完成，服务器只负责转发、状态和审批。

- 小 bug：一句话 → PR → 一键合并；网站合并后自动上线。
- 大需求：AI 写 spec issue，并建议开话题讨论 → 按钮确认后执行 → PR 或 stack PR。
- 发版：按变更类型计算版本号；preview 频繁自动发布，stable 需人工确认；文档同步更新。
- 回滚：指定版本或 commit。

## 2. 已定

| 主题          | 决定                                                                                                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 实现位置      | harness 控制面在 cos-tool-bot 中实现                                                                                                                                                            |
| Bot           | 新建一个工作专用 Bot，不承载群聊配置                                                                                                                                                            |
| 群            | 新建专用私有话题群，owner 将 Bot 设为管理员；一个项目一个话题                                                                                                                                   |
| 大需求        | Bot 建议开独立话题讨论（`featureTopics: suggest`）                                                                                                                                              |
| 试点项目      | koyori（Electron + 文档站）、example-gallery（网站）；cos-tool-bot 自身也接入                                                                                                                    |
| 执行层        | 首选 Lody CLI：`lody session create --machine …` 在指定机器上建会话（owner 已实测跨机器可行）；自建出站 WSS 节点作备选                                                                          |
| 编排          | 服务器管关卡（spec 确认、PR 就绪、合并、发版、回滚），lead 会话在关卡之间自由拆任务、派子会话                                                                                                   |
| 自主程度      | `/bug` 直接开工；普通消息分诊后给按钮；回复卡片即反馈；T0 自动合并默认关闭；大需求先确认 spec                                                                                                   |
| 卡片          | 主截图 + 说明 + 按钮，状态变化时原地编辑；样式见 dev-harness.md 5.3                                                                                                                             |
| 配置原则      | 能配置的都可以配置、每项有合理默认值；YAML 声明，Telegram 可临时覆盖                                                                                                                            |
| 安全底线      | owner 与群校验、审批绑定 SHA 且只能用一次、生产凭据只在 server、改 `.cos/**` 与 workflows 固定为 T3、仓库策略只读默认分支（不开放配置）                                                         |
| 护栏默认值    | 每台机器 4 个并发、每项目 3 个、同区域 1 个写入者；45 分钟无进展提醒、6 小时总时长提醒、不自动取消；自动修复 2 轮                                                                               |
| 交付合同      | 从轻：CI 全绿、有 release-kit 片段、PR 描述有「验证」「审查」两段、改 UI 时附截图；证据过期、删测试只在卡片上提示；服务器独立审查与重跑验收默认关闭                                             |
| 版本工具      | 自写 `@coszone/release-kit`，独立仓库、发布到 npm，通用且对 agent 友好；不用 Changesets（frontmatter 只允许「包名: 级别」）                                                                     |
| 片段目录      | `.release/changes/<id>.md`，一个 PR 一个文件                                                                                                                                                    |
| 版本规则      | fix / perf → patch，feat → minor，breaking → major；0.x 阶段 breaking 按 minor 处理并标出；升 1.0 只能手动决定                                                                                  |
| 发布方式      | npm Trusted Publishing（GitHub Actions OIDC）；配置时由 owner 在浏览器登录                                                                                                                      |
| 镜像 registry | 默认 GHCR                                                                                                                                                                                       |
| 任务提示词    | 四层组装、英文模板；优先复用执行机已有 skills；v1 用 GitHub 评论双向沟通（`Question:` / `Areas:` / `Needs spec:`）；只处理 harness 创建或 owner 打 label 的 issue；卡片摘要中文                 |
| 额度显示      | 卡片底部显示上下文与本周额度；`/quota` 按机器与 provider 列出 5 小时、本周、按模型窗口及重置时间；数据来自 `lody machine list --json` 的 `raceLimits` 与 `session show` 的 `contextWindowUsage` |
| 额度护栏      | 任一窗口达到阈值（默认 5 小时 95%、本周 90%）时暂停该 provider 的排队任务，或按配置降级模型；本周 75% 时提醒                                                                                    |
| 语音反馈      | v1 不做，使用系统听写输入文字；以后可配置转写服务，默认关闭                                                                                                                                     |
| 测试沙盒      | 新建私有仓库 `example-owner/harness-sandbox` 用于 H1–H2 测试（owner 已同意，实现 H1 时创建）                                                                                                         |
| H3 验收       | 在 koyori 上连续 3 个真实小 bug，除点「合并」外全程无需人工介入                                                                                                                                 |
| 回滚          | 网站：CI 为每个 commit 构建镜像，按 `sha-*` / `vX.Y.Z` 打 tag，Dokploy 换 tag 部署；回滚后固定（pin），暂停自动部署；Electron 走 revert + 新 patch                                              |

## 3. 暂定（owner 未提异议）

- release-kit 默认英文模板，内置 `default-zh`，可同时输出多语言。
- PR 号：CI 从环境变量读取，缺失时 `apply` 通过 git 反查，可选调用 GitHub API。
- 预发布序号：默认只看 git tag，可选参考 GitHub Release。
- release-kit 使用 MIT 许可证。
- 角色模型默认值：triage Sonnet、planner Opus、worker Sonnet、subworker Haiku、reviewer Codex（不可用时回退到 Fable）。

## 4. 待讨论

无。讨论已完成，进入实现（2026-09-24），按 [dev-harness-plan.md](dev-harness-plan.md) 推进。

## 4.1 实现状态

| 部分                                                       | 状态                                                                                                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| release-kit v0.1（R1–R6）及跟进（续跑、PR 号补齐、oxlint） | 已实现，69 个测试通过；已推送到公开仓库 `example-owner/release-kit`；npm 尚未发布                                                                                        |
| H1 配置与话题                                              | 已合并（PR #110，19c5ff2）并部署；2026-09-25 在生产端到端验证：`/status`、自动建话题                                                                                |
| H2 PR 卡片与合并                                           | 已合并并部署；2026-09-25 在生产端到端验证：沙盒 PR #1 出卡片，查看详情后经卡片合并；随后「详情」改为在卡片上就地展开，T2 点「合并」时展开详情并要求确认             |
| H3 Lody 执行与小 bug（3.1–3.6）                            | 已合并；2026-09-25 在生产端到端验证：沙盒 `/bug` 建 issue #2，Lody 会话在 MBP 上产出 PR #3，卡片显示 T2、CI 与额度页脚；3.7（koyori 接入）待进行                    |
| lody-bridge sidecar                                        | 已上线（PR #111，入口脚本权限修复 PR #112）；daemon 登录成功；随后补了 daemon 巡检重启、`/health` 反映 daemon 状态、优先复用保存的登录                              |
| 独立审查（安全与正确性）                                   | 已完成：无 critical/high；3 个 medium 与 4 个 low 已修复并补测试；「按 bot 名称绑定」保留，`/status` 显示绑定的 bot id                                              |
| 日常操作                                                   | 已实现（待合并）：`/list`、`/cancel`、`/retry`；PR 卡片增加「打回」「取消」（二次确认，不关 PR）「会话」「重新排队」；`/bug` 截图改为服务端签名链接写进 issue       |
| 可靠性兜底                                                 | 分支 `harness/reliability` 已实现并有单测：CI 登记窗口、webhook 补偿、会话停下未交付、排队升级（配置见 dev-harness-config.md §10）；尚未在真实 GitHub / Lody 上验证 |
| 沙盒仓库                                                   | `example-owner/harness-sandbox`（私有）已推送，CI 全绿                                                                                                                   |

全量验证（2026-09-24）：`pnpm typecheck` 通过；`pnpm lint` 0 errors（3 个既有 warning）；`pnpm fmt:check` 通过；`pnpm test` 211 个文件、1827 个用例通过。

H3 验收还差：koyori 接入（`.cos/harness.yml` 属于 T3，需 owner 在 GitHub 合并），之后连续 3 个真实小 bug。

## 5. 待验证或待准备

| 事项                                                                         | 负责                           |
| ---------------------------------------------------------------------------- | ------------------------------ |
| Dokploy `rollbackId` 从哪个接口获取；私有 registry 回滚问题（issue #3861）   | H6 实现时验证                  |
| koyori stable 前置项：Developer ID 公证、品牌素材授权、Electron 许可文件打包 | H5 前                          |
| example-gallery 的 GitHub 远端 owner、名称与可见性                            | H6 前                          |
| release-kit 首次发布与 npm Trusted Publishing 配置                           | owner 登录，release-kit 发布前 |
| `raceLimits` 字段名是否稳定（疑似拼写），升级 Lody 后复核                    | H3 实现时                      |

## 6. 分阶段

| 阶段 | 内容                                                              |
| ---- | ----------------------------------------------------------------- |
| H1   | 配置加载与校验、项目绑定、自动建话题、`/status`、harness 话题模式 |
| H2   | GitHub webhook、持久化审批、PR 卡片、一键合并                     |
| H3   | Lody 执行器、提示词模板、`/bug` 闭环（koyori）                    |
| H4   | 分诊、建议开话题、spec issue、stack 执行与逐层合并                |
| H5   | release-kit 接入、preview / stable 卡片、文档检查                 |
| H6   | Dokploy 部署与回滚，接入 example-gallery                           |
| H7   | 自建节点（按需）、Mini App 证据页、每日汇总、T0 自动合并          |

release-kit v0.1 可以与 H1–H2 并行开发。

## 7. 相关文件

| 文件             | 位置                                                                                                                                                         | 状态       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| 架构与流程       | 本仓库 `docs/design/dev-harness.md`                                                                                                                          | 已合并     |
| 配置参考         | 本仓库 `docs/design/dev-harness-config.md`                                                                                                                   | 已合并     |
| 讨论进度         | 本文                                                                                                                                                         | 已合并     |
| release-kit 设计 | `example-owner/release-kit` 仓库 `docs/design.md`                                                                                                                 | 已推送     |
| 前期调研         | `~/Documents/Programming/agent-workbench/tasks/ai-autonomous-delivery-research/`（`report.md`、`release-and-tg-control.md`、`flows.md`、`topic-harness.md`） | 不纳入 git |
