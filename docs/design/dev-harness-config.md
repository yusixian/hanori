# Dev Harness 配置参考

状态：草案，与 [dev-harness.md](dev-harness.md) 配套

日期：2026-09-24

## 1. 原则

- **能配置的都可以配置，每项都有合理默认值**：零配置时只需填写必填项（Bot、群、owner），项目可以写在 YAML 里，也可以在面板或 Mini App 中添加（见 §7）。
- **逐层覆盖**（`/harness config <路径>` 显示的来源层名称）：
  1. 内置默认、按 `kind` 推断
  2. `harness.yaml`（全局）→ `harness.yaml 项目`
  3. `.cos/harness.yml`；仓库没有这个文件时换成「按仓库推断」（§8）
  4. 「面板设置（全局）」：面板中设置的 lead 执行配置（§9）
  5. 「面板设置」：面板项目的绑定、策略修改和该项目的执行配置
  6. 覆盖层（全局）→ 覆盖层（项目）：Telegram `/harness set` 的临时调整
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
    agentConfig: Codex # roles.worker.agent 未设置时 lead 使用的 Lody 执行配置（名称或 id）
    models: {} # 替换面板中某类 agent 的模型列表，见 §9
    worktree: true
    shareLinks: true
    poll: { active: 20s, idle: 2m }
    turnWait: 2h # 会话创建与每次发消息都带 `--wait --timeout`，回合结束立即上报；null 只靠轮询，见 §10
  node:
    enabled: false
    listen: tailnet # tailnet | public

machines:
  mbp: { lody: MBP-64G, tags: [macos, electron], enabled: true }
  desktop-5090: { lody: Desktop-5090, tags: [windows, gpu], enabled: false }

roles: # 只写要改的角色，其余保留内置值
  triage: { model: sonnet, effort: low }
  planner: { model: opus, effort: high }
  worker: { effort: high } # lead 会话；model 默认取该 agent 类型模型列表的第一项（Codex 为 gpt-6-sol）
  # subworker / reviewer 未设置时跟随 lead：Codex lead 用 gpt-6-luna 子会话、Claude Code + opus[1m] 审查；
  # Claude lead 用 haiku 子会话、Codex + gpt-6-sol 审查。effort 可选 default | low | medium | high | xhigh | max | ultra

guardrails:
  concurrency:
    perMachine: 4
    perProject: 3
    sameAreaWriters: 1
  time:
    idleRemindAfter: 45m
    runRemindAfter: 6h
    hardCancelAfter: null
    undeliveredAfter: 3m # 会话连续两次轮询都是 idle、且安静这么久，仍没有 PR 或只有草稿 PR：转为「需要你看一下」，见 §10
    queueEscalateAfter: 15m # 因没有可用执行机（Mac 离线、lody-bridge 不通）排队这么久，在 General 提醒一次；null 关闭
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
  # required 读取分支保护，需要 GitHub App 的 Administration 读权限，且仓库所在套餐支持分支保护；
  # 读不到时改由所有可见检查决定能否合并，并按分支记录一次警告
  branchPrefix: harness/
  labelPrefix: "harness:"
  ci: # 推送后 CI 尚未登记的窗口，见 §10
    grace: 60s # 每次推送后没有任何检查时，至少等这么久才允许合并
    registrationTimeout: 10m # 仓库预期有 CI 时最多等这么久（路径过滤可能让 CI 不触发）
    detectTtl: 30m # 「是否预期有 CI」按仓库与目标分支缓存的时长
  reconcile: # 补偿丢失的 webhook，只读全局值，见 §10
    interval: 3m # null 关闭
    batch: 10 # 每轮最多同步的请求数

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

projects: # 可省略；YAML 项目在面板中只读，与面板项目同名或同仓库时以 YAML 为准
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
kind: web # web | electron | native | service | library；决定下列默认值

verify:
  quick: null # 默认按 kind 推断，例如 pnpm lint && pnpm typecheck && pnpm test
  full: null
  acceptance: null # 有 UI 改动时运行
  timeout: 30m

sizeGate: # 默认不限；只有想给 agent 加限制时才写
  maxFiles: null # 例如 20：超过时 lead 发 Needs spec 停下
  forbidTiers: [] # 例如 [T3]：需要改这些档位时停下；T3 本身已要求 owner 在 GitHub 合并
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
  templates: {} # 按请求类型替换内置模板：bug、task、revise、answer、followup、ci_failed，例如 { bug: .cos/prompts/bug.md }
  preferSkills: [oneshot, frontend-acceptance, gh-stack, pr-visual, review-code-change]
```

## 5. 按 `kind` 推断的默认值

| 字段                              | web        | electron       | native         | service    | library |
| --------------------------------- | ---------- | -------------- | -------------- | ---------- | ------- |
| `verify.acceptance`               | 浏览器验收 | 打包后桌面验收 | 无             | 无         | 无      |
| `deploy.target`                   | dokploy    | github-release | github-release | dokploy    | none    |
| `deploy.onMerge`                  | production | none           | none           | production | none    |
| `release.preview.trigger`         | none       | merge          | manual         | none       | manual  |
| `release.stable.approval`         | owner      | owner          | owner          | owner      | owner   |
| `guardrails.time.idleRemindAfter` | 45m        | 90m            | 90m            | 45m        | 45m     |

`native` 指不基于 Electron 的桌面或移动端应用，例如 Swift / Xcode 项目。

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

## 7. 面板项目

owner 可以在网页面板的「Dev Harness」页（`/harness`）或 Mini App 中添加项目：从 GitHub App 能访问的仓库里选一个，选执行机，保存后立即生效，不需要 `/harness reload`。

- 面板项目存在数据库 `harness_projects.binding` 中，与 YAML 项目合并成同一个项目集合；同名或同仓库时以 YAML 为准，被挡住的面板项目在面板中显示提示，不会被静默删除。
- 保存后会自动创建项目话题并读取仓库策略；删除时如果还有排队或进行中的任务会被拒绝。
- 面板只能修改策略中的这些字段，存在 `policy_patch` 中，位于仓库文件之上：`kind`、`verify.quick|full|acceptance`、`contract.releaseFragment`、`prompts.preferSkills`。风险分级、固定 T3 路径和 §2 的安全字段不能在面板中修改。
- YAML 项目在面板中只读，只能单独设置该项目的执行配置（§9）。
- 仓库列表来自 GitHub App 的全部安装（个人账号和组织）；要添加新账号或仓库，在面板中点「授权更多仓库」进入 GitHub App 安装页。

## 8. 按仓库推断

仓库默认分支没有 `.cos/harness.yml` 时，server 读取少量文件推断策略，结果缓存在 `harness_projects.inferred_policy`，默认分支有新提交时随策略一起刷新。只写有把握的字段，其余仍用默认值：

| 仓库特征                                          | `kind`            | `verify`                                                                                                                                             |
| ------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json` 依赖 `electron`                    | electron          | `quick`：已有的 `lint`、`typecheck`、`test` 脚本；`full`：`verify` 或 `check`；`acceptance`：`test:e2e`、`test:desktop` 或 `e2e`                     |
| `package.json` 有 `bin` / `exports`，没有应用框架 | library           | 同上                                                                                                                                                 |
| `package.json` 只有 express / hono 等服务端框架   | service           | 同上                                                                                                                                                 |
| 其他 `package.json`                               | web               | 同上                                                                                                                                                 |
| `Tuist.swift` 或 `Project.swift`                  | native            | `quick`：`tuist install && tuist generate --no-open && xcodebuild -workspace <Name>.xcworkspace -scheme <Name> ... build`；`full`：`xcodebuild test` |
| 只有 `*.xcodeproj`                                | native            | 不推断                                                                                                                                               |
| `Package.swift`                                   | library           | `swift build && swift test`                                                                                                                          |
| `Cargo.toml` / `go.mod`                           | library / service | `cargo test` / `go test ./...`                                                                                                                       |

- 包管理器优先看 `packageManager` 字段，其次看锁文件（`pnpm-lock.yaml`、`yarn.lock`、`bun.lock(b)`），否则用 npm；命令写成 `pnpm lint`、`yarn lint`、`npm run lint`、`bun run lint`。
- `<Name>` 取 `Project.swift` 中的 `name:`，读不到时用仓库名。
- 仓库在 `.agents/skills/<name>/SKILL.md` 或 `.claude/skills/<name>/SKILL.md` 定义了与默认 `preferSkills` 同名的 skill 时，从列表中去掉，避免把仓库自己的同名流程（例如 koyori 的 `oneshot` 发版流程）用在修 bug 上。

## 9. 在面板中设置 lead 执行配置

lead 会话的执行配置（Lody agent 配置、模型、推理强度）可以在面板中设置全局默认，也可以按项目覆盖（YAML 项目也可以）。它们对应 `roles.worker.agent`、`roles.worker.model`、`roles.worker.effort`，位于 `harness.yaml` 之上、Telegram 覆盖层之下；留空的字段继续使用 YAML 或内置值。

- 内置默认：Lody 中名为 `Codex` 的执行配置、`gpt-6-sol`、推理强度 `high`。
- 执行配置列表来自 `lody agent-config list`，lody-bridge 只返回 `id`、`name`、`agentType`、`machineId`，不返回 `env`。Lody 可访问时，执行配置必须在列表中。
- 模型列表按 agent 类型内置（Codex：gpt-6-sol、gpt-6-astra、gpt-6-luna、gpt-5.6-sol、gpt-5.6-terra、gpt-5.6-luna、gpt-5.5；Claude：default、opus[1m]、claude-fable-5-1[1m]、sonnet、haiku）。可以填列表外的模型 ID；列表内的模型会校验推理强度是否支持。用 `executors.lody.models` 替换某类 agent 的列表：

```yaml
executors:
  lody:
    models:
      codex:
        - { id: gpt-6-sol, name: GPT-6 Sol, efforts: [low, medium, high, xhigh, max, ultra] }
```

- 推理强度通过 `lody session create --config-option` 传给 Lody：Codex 用 `reasoning_effort=<值>`，Claude 用 `effort=<值>`；`default` 或留空时不传。
- 额度按执行配置的 `agentType` 归属 provider；拿不到列表时按模型 ID 前缀（`gpt-`、`o3` 等为 Codex，`claude`、`opus`、`sonnet`、`haiku`、`fable` 为 Claude）判断，最后才看名称。

## 10. 可靠性兜底

- **CI 登记窗口**：GitHub 在推送几秒后才登记检查，这段时间 PR 没有任何检查。推送后 `github.ci.grace` 内，没有检查的 PR 显示「等待 CI 登记」，不能合并。目标分支的 `.github/workflows/*.yml` 里有 `pull_request` / `pull_request_target` 触发的 workflow 时视为「预期有 CI」，最多等到 `registrationTimeout`；没有 workflow 的仓库（例如 MoePeek、mcp-platform）过了 grace 即可合并。只看 check run 与 commit status，不看 check suite：订阅 `check_suite` 会留下没有 run 的 queued suite。检查登记（`check_run.created`）或等待到期时卡片自动刷新。
- **补偿丢失的 webhook**：webhook 先返回 202 再异步处理，重启会丢事件。调度器每 `reconcile.interval` 取最多 `batch` 个未结束的请求，轮流处理：有 PR 的按 webhook 相同的同步流程读取 PR 状态、head 与检查并刷新卡片；运行中或「需要你看一下」但还没关联 PR 的，按 `branchPrefix` + 请求 ID 查找同仓库的开放 PR 并关联。issue 评论（`Question:` 等协议行）不补偿。
- **会话停下但没有交付**：Lody 会话状态只有 `running` 和 `idle`。连续两次轮询都是 `idle`，且距离最后一条消息、最近一次推送或反馈都超过 `undeliveredAfter`，仍没有 PR 或只有草稿 PR 时，请求转为「需要你看一下」，并回复卡片一条消息，附会话最后一条回复的摘录（经 lody-bridge 的只读命令 `session history --limit 4 --reverse`，bridge 只返回角色、时间和前 4000 字）。会话重新运行，或 PR 已关联且不是草稿时，自动恢复。`/task` 没有 PR 时不发这条提醒，而是把最后一条回复作为结果发到话题，见下一条。
- **回合结束回调**：`executors.lody.turnWait` 不为 null 时，harness 发起的每个回合（建会话、回答、修订、继续、CI 修复、`/task`）都带 `--wait --timeout <秒>`。经 lody-bridge 时，bridge 在 Lody 接受回合后立即应答，等待进程留在后台，结束后向 app 的 `POST /api/harness/lody/turn` 发一条用 `HARNESS_LODY_BRIDGE_SECRET` 签名的回调（HMAC-SHA256，覆盖时间戳和原始 body，时间戳超出 ±5 分钟即拒绝）；本地 CLI 模式在进程内直接处理。收到回调后立即检查该会话：只要 Lody 状态是 `idle` 就视为回合已结束，不再等两次轮询和 `undeliveredAfter`。状态还显示 `running` 时标记保留到下一次轮询；harness 再次向会话发消息，或会话在标记 60 秒后仍在运行时，标记清除。`--wait` 超时（`status: timeout`）、回调丢失或服务重启后，仍按上一条的轮询规则处理。标记只在内存中。
- **`/task` 的结束**：回合结束且 `harness/<请求 ID>` 分支上没有开放 PR 时，读会话最后一条回复：以 `Question:` 开头的转到话题（状态「需要你看一下」，回复即作答），以 `Needs spec:` 开头的转为「需要写 spec」，其余作为结果发到话题（最多 3500 字，可展开引用；配置了 `sessionUrl` 时附「打开会话」），请求转为 `completed`。有 PR 时交给 PR 卡片。`completed` 算已结束（不进 `/list`、`/cancel`，不占并发），但会话还会被轮询 30 分钟：会话自己又开始运行（例如子会话回报）时回到「进行中」。回复结果消息或卡片会把同一个会话重新打开并发送回复，下一次回合结束再发新结果。
- **排队升级**：排队卡片显示已排队时长（分钟级，超过 5 分钟按 5 分钟、超过 1 小时按 30 分钟取整）。原因是执行层不可用或没有在线的执行机时，排队超过 `queueEscalateAfter` 在 General 话题提醒一次；并发、额度、同区域等有意的等待不提醒。排队起点按请求和启动次数记在 `harness_events`，重启后不会重置。
