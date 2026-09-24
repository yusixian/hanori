# Dev Harness 配置参考

状态：草案，与 [dev-harness.md](dev-harness.md) 配套

日期：2026-09-24

## 1. 原则

- **能配置的都可以配置，每项都有合理默认值**：零配置时只需填写必填项（Bot、群、owner、项目仓库），其余全部使用默认值。
- **逐层覆盖**：内置默认 → `harness.yaml` 全局 → `harness.yaml` 项目 → 仓库 `.cos/harness.yml` → 数据库覆盖层（Telegram / 面板中的临时调整）。
- **可查可校验**：
  - 所有字段有 JSON Schema，启动与 `/harness reload` 时校验，错误定位到字段路径。
  - `/harness config <路径>` 显示生效值及其来源层；`/harness diff` 显示覆盖层与 YAML 的差异；`/harness export` 导出生效配置。
- **时长**写作 `30s`、`45m`、`6h`、`7d`；**百分比**写作 `10%`。

## 2. 不开放配置的底线

以下规则写死在代码中，不能通过任何配置关闭（owner 已确认，2026-09-24）：

| 底线                                                                 | 原因                                          |
| -------------------------------------------------------------------- | --------------------------------------------- |
| 只接受 `owners` 中的 Telegram 用户、只在配置的群内操作               | 群被拉进陌生人或 bot token 泄露时仍能挡住操作 |
| 审批绑定 SHA 或修订版本、一次性消费、执行前复核                      | 防止批准的内容与实际合并的内容不一致          |
| 合并、打 tag、部署、回滚的凭据只在 server                            | 执行机被攻破时不能直接改生产                  |
| `.cos/**`、`.github/workflows/**`、`release-kit` 配置的改动固定为 T3 | 防止 agent 在 PR 中放宽自己的限制             |
| 仓库策略只读默认分支                                                 | 同上                                          |

此外，**安全相关字段只能通过 YAML 修改，Telegram 临时覆盖不能修改**：`telegram.owners`、`approvals.*`、`risk.*`、`executors.*` 中的凭据引用、`guardrails.autonomy.autoMergeTiers`。

## 3. `harness.yaml`（server 挂载）

```yaml
version: 1

telegram:
  bot: example-dev # 必填：BotPool 中的 Bot
  chatId: -1001234567890 # 必填
  owners: [123456789] # 必填
  topics:
    overview: general # General 话题用于汇总
    alerts: null # 已有告警话题的 thread id，可选
    featureTopics: suggest # off | suggest | always；大需求是否开独立话题
    closeFeatureTopicOnDone: true
    titleFormat: "{project} · #{issue} {title}"
  chat:
    casualReplies: false # harness 话题中不闲聊
    triage: true # 普通消息交给分诊
  cards:
    language: zh-CN
    screenshot: first # none | first
    showDuration: true
    showQuota: true # 卡片底部显示上下文与本周额度
    showContext: true
    showFiles: false
  notify:
    preview: digest # each | silent | digest
    digestAt: "21:00"
    timezone: Asia/Shanghai
    quietHours: null # 例如 "01:00-09:00"：期间只编辑卡片，不发新消息
    mentionOnAction: true # 需要 owner 操作时 @owner
    digestQuota: true # 每日汇总附带额度

approvals:
  ttl: 7d # 按钮有效期
  stableConfirm: twice # once | twice
  rollbackConfirm: twice
  mergeConfirm: once

executors:
  default: lody # lody | node
  lody:
    workspace: auto # 自动取唯一 workspace
    agentConfig: "Claude Code"
    worktree: true
    shareLinks: true
    poll: { active: 20s, idle: 2m }
  node:
    enabled: false
    listen: tailnet # tailnet | public

machines:
  mbp: { lody: MBP-64G, tags: [macos, electron], enabled: true }
  desktop-5090: { lody: Desktop-5090, tags: [windows, gpu], enabled: false }

roles:
  triage: { model: sonnet, effort: low }
  planner: { model: opus, effort: high }
  worker: { model: sonnet, effort: medium }
  subworker: { model: haiku, effort: low }
  reviewer: { agent: codex, effort: high } # 跨厂商审查；不可用时回退到 Claude + fable

guardrails:
  concurrency:
    perMachine: 4
    perProject: 3
    sameAreaWriters: 1
  time:
    idleRemindAfter: 45m
    runRemindAfter: 6h
    hardCancelAfter: null
  autoFixRounds: 2
  quota: # 数据来自 lody machine list 的 raceLimits
    pauseAt: { fiveHour: 95%, week: 90% } # 任一窗口达到阈值时暂停该 provider 的排队任务
    warnAt: { week: 75% } # 在 General 话题提醒一次
    fallback: {} # 例如 { planner: sonnet }：超阈值时降级模型，而不是暂停
    dailySessionCap: null # 每日会话上限，默认不限
  autonomy:
    bugStartsImmediately: true
    triageStartsWork: false # 分诊结果是否不经确认直接开工
    autoMergeTiers: []

github:
  acceptIssues: harness-only # harness-only：只处理 harness 创建或 owner 打了 label 的 issue
  acceptPullRequests: harness-only # harness-only：只为 harness 分支、trustedAuthors 的同仓库 PR、带 harness:track 标签的 PR 出卡片
  trustedAuthors: []
  mergeMethod: squash # squash | merge | rebase
  deleteBranchOnMerge: true
  requireChecks: all # all | required
  branchPrefix: harness/
  labelPrefix: "harness:"

deploy:
  dokploy:
    url: null # 使用 Dokploy 时必填
    apiKeyEnv: DOKPLOY_API_KEY
  healthTimeout: 5m
  pinOnRollback: true

release:
  stableReminder: weekly # off | weekly | changes:<N>
  candidateMinChanges: 1

audit:
  retain: 365d

projects:
  koyori:
    repo: example-owner/koyori # 必填
    topic: auto # auto | <thread id>
    machines: [mbp]
    localProject: koyori # Lody 本地项目名，默认取仓库名
    # 以下任意全局字段都可以在项目内覆盖：
    guardrails:
      time: { idleRemindAfter: 90m }
```

## 4. `.cos/harness.yml`（业务仓库，默认分支）

```yaml
version: 1
kind: web # web | electron | service | library；决定下列默认值

verify:
  quick: null # 默认按 kind 推断，例如 pnpm lint && pnpm typecheck && pnpm test
  full: null
  acceptance: null # 有 UI 改动时运行
  timeout: 30m

sizeGate: # 小 bug 的规模闸门
  maxFiles: 5
  forbidTiers: [T3]
  forbidCrossPackages: false

areas: # 并发写入的分区；未声明时整个仓库算一个区
  desktop: ["apps/desktop/**"]
  site: ["apps/site/**"]
  core: ["packages/core/**"]

risk:
  default: T2
  T0: ["docs/**", "**/*.md", "**/locales/**"]
  T1: []
  T3: [] # 固定 T3 的路径无需列出，会自动追加

contract: # 交付合同，默认从轻
  releaseFragment: required # required | optional
  sections: [verify, review] # PR 描述中必须有的段落
  screenshots: when-ui # always | when-ui | never
  uiPaths: ["apps/**/src/**/*.tsx"] # 判断「改到 UI」的路径
  review:
    by: lead # lead | server；server 表示服务器另起独立 reviewer 会话
    reverify: false # 独立 reviewer 是否在执行机上重跑验收
  flags: # 只在卡片上提示，不拦截
    staleEvidence: true
    testDeletion: true

release:
  tool: release-kit # 读取仓库中的 release-kit.yaml
  preview:
    trigger: merge # merge | manual | daily
    workflow: null # 例如 release-preview.yml
  stable:
    approval: owner # owner | auto
    workflow: release.yml

docs:
  paths: []
  requiredFor: [feat, breaking]

deploy:
  target: none # none | dokploy | github-release | vercel
  onMerge: production # production | staging | none
  image: null
  health: null

prompts:
  extra: [] # 追加给 lead 会话的仓库说明文件，例如 [AGENTS.md, docs/CONVENTIONS.md]
  templates: {} # 按请求类型替换内置模板，例如 { bug: .cos/prompts/bug.md }
  preferSkills: [oneshot, frontend-acceptance, gh-stack, pr-visual, review-code-change]
```

## 5. 按 `kind` 推断的默认值

| 字段                              | web        | electron       | service    | library |
| --------------------------------- | ---------- | -------------- | ---------- | ------- |
| `verify.acceptance`               | 浏览器验收 | 打包后桌面验收 | 无         | 无      |
| `deploy.target`                   | dokploy    | github-release | dokploy    | none    |
| `deploy.onMerge`                  | production | none           | production | none    |
| `release.preview.trigger`         | none       | merge          | none       | manual  |
| `release.stable.approval`         | owner      | owner          | owner      | owner   |
| `guardrails.time.idleRemindAfter` | 45m        | 90m            | 45m        | 45m     |

## 6. Telegram 中的配置命令

| 命令                                  | 作用                                             |
| ------------------------------------- | ------------------------------------------------ |
| `/harness config [路径]`              | 显示生效值与来源层                               |
| `/harness set <路径> <值> [--ttl 1d]` | 写入覆盖层；可设过期时间，到期自动恢复           |
| `/harness unset <路径>`               | 删除覆盖                                         |
| `/harness diff`                       | 覆盖层与 YAML 的差异                             |
| `/harness export`                     | 以文件形式发送生效配置                           |
| `/harness reload`                     | 重新读取 YAML 并校验；失败时保留旧配置           |
| `/quota`                              | 按机器与 provider 显示各时间窗口的用量与重置时间 |

在项目话题中执行时，路径默认限定在该项目。
