# Telegram Mini App 管理面板与访问控制设计

状态：实施中（G0–G1 已完成，G2 进行中）

日期：2026-07-27

## 1. 目标

为每个 Telegram Bot 提供一个 Telegram-native 管理面板。在不把 Better Auth workspace 权限直接授予 Telegram 用户的前提下，让：

- Bot 管理员管理当前 Bot 的生命周期、访问名单、常用 AI 设置以及任意已观测群的配置；
- 显式白名单用户操作 Mini App 白名单群的低风险运行配置；
- Mini App 白名单群的当前成员读取经过投影的群配置；
- 其他用户查看静态 Help、命令说明与项目背景。

Mini App 是现有管理后台的 Telegram 专用 control plane，不是第二套业务系统，也不是首版完整复制桌面后台。

## 2. 产品边界

### 2.1 多 Bot

- 每个 Bot 打开自己的 Mini App，会话绑定单一内部 `botId`。
- URL 中的 `botId` 只负责选择目标，不能作为授权证明。
- Bot A 的 `initData`、Cookie 或 grant 不能访问 Bot B。
- Mini App 内不提供 Bot 切换器。

### 2.2 入口

- Bot 私聊 Menu Button；
- `/panel` 命令；
- 添加群使用 `https://t.me/<bot_username>?startgroup&admin=manage_chat+pin_messages`；
- 群内不主动推送管理入口。

功能按 Bot 使用 `miniAppEnabled` 默认关闭，先对单一测试 Bot 灰度。

### 2.3 非目标

M1 不包含：

- channel 或 private-chat grant；
- Provider 创建、Base URL 或 API Key 管理；
- Bot token、GitHub、MCP、备份、文件、数据导入/恢复；
- Bot 删除、批量数据删除等不可逆操作；
- 将 Telegram 管理员映射为 Better Auth workspace owner；
- 多实例共享缓存、共享限流或后台重试队列；
- Attachment Menu 或依赖新客户端覆盖率的 `requestChat` 主链路。

## 3. 权限模型

### 3.1 角色

| 角色       | 来源                          | 群范围                       | M1 写权限                                                                  |
| ---------- | ----------------------------- | ---------------------------- | -------------------------------------------------------------------------- |
| `admin`    | 当前 Bot 的 `adminChatIds`    | Bot 当前仍加入的全部已观测群 | 生命周期、访问名单、全局常用 AI 设置、群配置、群级 Provider/模型、展示策略 |
| `operator` | 独立用户 grant                | 全部 Mini App chat grant     | 群启用、AI 群白名单、触发、对话上下文、Summary 运行配置                    |
| `viewer`   | chat grant 且用户仍是该群成员 | 用户当前所属的 granted chats | 只读投影                                                                   |
| `none`     | 其他用户                      | 无                           | 仅静态 Help                                                                |

解析优先级为 `admin > operator > viewer > none`。

### 3.2 Capability

路由只校验中心化 capability，不硬编码角色名称。M1 至少定义：

- `bot.lifecycle.manage`
- `bot.settings.read`
- `bot.settings.write`
- `chat.directory.read`
- `group.config.read`
- `group.config.write`
- `chat.ai-selection.read`
- `chat.ai-selection.write`
- `access.manage`
- `audit.read`

未来预留 `credentials.manage`、`data.export`、`data.delete` 等 capability，但 M1 不映射给任何 Telegram 角色。Workspace-global MCP、备份、全局日志与创建其他 Bot 始终保留在 Better Auth workspace 边界。

`MiniAppAccessPolicy` 是唯一角色和 capability 解析入口。Bot route、Mini App route、Telegram `/model` 与 `/provider` 不能各自实现不同的授权规则。

### 3.3 动态权限

- Session 存身份，不冻结授权；每个请求重新解析当前 grant。
- Viewer membership 缓存不超过 60 秒。
- Bot/API 无法可靠校验时 viewer fail closed。
- Admin/operator 在 Bot 停机时仍可管理已有配置。
- 新增 chat grant 必须在线校验 Bot 为该群管理员。
- 新增 operator 可按精确 Telegram user ID 离线完成，资料标记为未验证，首次登录后补全。

## 4. 数据模型

### 4.1 群目录

`telegram_chats` 以 `(bot_id, chat_id)` 为身份，保存：

- `type`，M1 只接受 `group | supergroup`；
- title、username；
- nullable authoritative Bot membership status；
- `membership_observed_at`、`last_observed_at`、`left_at`；
- `migrated_to_chat_id`。

目录由独立 Bot observation middleware 从普通 updates、`my_chat_member` 和 chat migration 事件幂等维护。旧 `groupOverrides` 只能生成未验证候选，不自动生成 grant。

### 4.2 授权

使用两张显式表，不使用多态 subject 表：

- `mini_app_chat_grants(bot_id, chat_id, created_by, note, created_at)`；
- `mini_app_operator_grants(bot_id, telegram_user_id, created_by, note, created_at)`。

它们与现有 AI `whitelisted`、`privateChatWhitelist` 完全独立，避免已有 AI 用户被静默提升为面板操作者。

### 4.3 Bot 公开身份

`telegram_bot_profiles` 保存 `getMe` 投影：Telegram Bot user ID、username、display name 与 observed timestamp。深链和 UI 使用该投影，授权仍以内部 `botId` 为租户边界。

### 4.4 群级 Provider/模型

将现有 `chat_provider_overrides` 与 `chat_model_overrides` 迁移为：

```text
chat_ai_selections
  bot_id
  chat_id
  provider_id
  model_id nullable
  revision
  updated_by
  updated_at
```

不变量：

- 无 row 表示继承 Bot 全局 Provider/模型；
- 有 row 必须有有效 Provider；
- `model_id = null` 表示使用该 Provider 默认模型；
- 非空模型必须属于该 Provider 已配置/发现的模型列表；
- Provider 和模型在同一事务中校验、保存和迁移。

旧 model-only override 在迁移时绑定到当时的有效 Provider。迁移输出报告，不允许继续保存孤立模型。

Provider/模型展示策略与 selection 解耦：Bot AI 配置保存默认 show/hide，`groupOverrides` 保存可选 `inherit | show | hide`，统一由 `GroupConfigService.patch` 修改。

### 4.5 审计

重要写入在同一业务事务写 audit：授权、群配置、AI selection、展示策略、生命周期与手动重试。记录 actor、role/capability、Bot、资源、旧值摘要、新值摘要、结果和时间；不记录 token、Cookie、原始 `initData`、Provider key 或群消息正文。

管理界面展示最近 90 天活动。读取不审计；认证失败只记录分类和聚合计数。

### 4.6 Telegram ID

继续使用 JS `number` 与 PostgreSQL `bigint(mode: "number")`，但所有边界统一校验：

- `Number.isSafeInteger`；
- Telegram user ID 为正；
- group/supergroup chat ID 为负。

## 5. 认证与 API

### 5.1 Session

1. 前端只将原始 `Telegram.WebApp.initData` 发给 session endpoint。
2. 服务端使用路径目标 Bot 的 token 按官方算法验证 hash。
3. 校验 `auth_date` 新鲜度、未来时间、重复字段和 Telegram user safe integer。
4. 签发 15 分钟 HttpOnly、Secure Cookie。
5. Cookie Path 限定 `/api/mini-app/:botId`，载荷内 Bot ID 必须与路径一致。
6. 原始 `initData` 验证后即丢弃，不进入日志或浏览器存储。

默认 `SameSite=Lax`，以 Telegram iOS、Android、Desktop、Web 实测为发布门槛；只有实测要求时才改为 `SameSite=None; Secure`。

### 5.2 API 边界

Mini App 使用独立 `/api/mini-app/:botId/*` facade：

- 不复用 Better Auth middleware；
- 不直接 mount 现有宽 `/api/bots/*` route；
- 复用 application services 和 shared types；
- DTO 按 capability 投影，隐藏字段在服务端直接省略；
- 所有写请求校验 Origin、CSRF、Bot scope、当前 capability 与配置 revision；
- 过期版本返回 `409` 和最新值。

会话创建和重要写请求采用单实例内存限流。多实例共享限流与安全事件面板后移。

## 6. 核心服务边界

### 6.1 `GroupConfigService`

`bots.aiConfig.groupOverrides` 在 M1 继续使用 JSON，但所有入口只允许字段级 PATCH：

- 单实例使用按 Bot 锁和 latest-value read/merge/write；
- 客户端携带 revision，拒绝 stale save；
- DB 是真实来源；
- commit 后通过窄 runtime controller 热应用，不重启整个 Bot；
- 热应用失败返回 `persisted: true, applied: false`，UI 显示“已保存、待应用”；
- M1 不实现常驻重试队列，管理员可手动重试，Bot 下次启动自动读取。

Operator 可修改：群启用、AI 群白名单、trigger、conversation enable/context limits，以及 Summary 的 enabled、schedule/timezone、message window、cooldown。Prompt、Provider、模型和凭据不在其 capability 内。

### 6.2 `ChatAiSelectionService`

它是全局与群级 Provider/模型的唯一写入口，供 Telegram 命令、现有 Panel 和 Mini App 共用：

- 列出已配置且 credential usable 的公开 Provider/模型 metadata；
- 解析 desired/effective pair 与继承来源；
- 原子 set/reset 群 selection；
- DB commit 成功后 awaited 热发布到运行态；
- 持久化失败不得更新内存或返回成功；
- Provider 被删除时将受影响 selection reset 到全局并审计；
- 模型被删除时回退该 Provider default 并审计。

`/provider`、`/model` 迁移到该 service，不再 fire-and-forget；移除任意模型字符串和 `modelCommandAccess=all` 绕过。

### 6.3 `BotLifecycleService`

`bots.isActive` 是唯一 durable desired state：

- enable：先持久化 true，再启动；启动失败保留 desired=true 并返回未协调状态；
- disable：先持久化 false，再停止，确保服务重启不会复活；
- restart：仅在 desired=true 时执行，保持 desired state；
- start/stop/restart 继续按 Bot 串行；
- 返回 `{desiredActive, runtimeStatus, reconciled}` 并审计。

停止拒绝新 updates，取消活跃 AI 生成和未完成内部任务；已经发生的外部副作用不能回滚。配置、已落库历史和其他 Bot 不受影响。

Active timer 在停机期间保持 durable；重新启动时恢复，已过期提醒补发一次并标记延迟。Lifecycle 实施必须同时修复普通 stop/restart 丢失 timer handle 的现有问题，并覆盖 Summary/RSS 等 Bot-scoped job 的停止语义。

### 6.4 `TelegramMembershipVerifier`

由运行中的 BotManager 实现，只暴露窄的 membership/status 查询，不暴露 token 或原始 Bot API client。Viewer 校验、chat grant 创建和目录刷新共用该 seam。

### 6.5 `ChatIdentityMigrationService`

basic group 升级为 supergroup 时，在事务中迁移 chat grant、group override、Summary config、AI selection 和其他 M1 chat-scoped 资源。目标 ID 已有显式配置时目标优先，保留 old ID lineage 和 conflict audit；不迁移聊天历史。

Forward 流程由 Telegram migration update 自动触发：先锁当前 Bot row，再创建 target catalog identity，随后在同一事务迁移 grant、完整 `groupOverrides`、Summary config、旧 model/provider override、RSS collection 与 timer，最后写 lineage 和只含资源 ID/计数的 system audit。重复 update 不产生第二次写入；同一 old ID 指向不同 target 时拒绝处理。

以下内容刻意留在 old chat ID：conversation messages/summaries/compaction state、chat summaries 与 PixAI generations。迁移不复制内容，也不在 audit 中保存消息或 Prompt。

回滚分两层处理：

- G1 schema migration 仅新增表。回退应用版本时保留这些表最安全，旧版本会忽略它们；生产执行 `pnpm db:migrate` 前仍必须创建数据库快照。
- chat identity migration 采用 target-wins，冲突时会删除 old singleton，因此不提供自动反向迁移。需要恢复 old 配置只能从迁移前数据库快照回滚，再重新处理 Telegram 已升级后的 target chat；该演练是 G7 发布门禁。

## 7. 前端架构

保持一个 Vite SPA 和一个 BrowserRouter：

```text
/
├─ /mini-app/:botId/help       public static surface
├─ /mini-app/:botId/*          lazy MiniAppApp
│  ├─ groups
│  ├─ settings                 admin only
│  └─ access                   admin only
└─ /*                          lazy AdminPanelApp / Refine / Better Auth
```

Mini App 不实例化 Refine auth/data/layout。独立 Telegram adapter 管理 `initData`、theme、viewport、safe area、ready/expand/back/close 与事件清理；DEV mock 只能通过 `import.meta.env.DEV` 进入。

导航：

- admin：Groups、Settings、Access、Help；
- operator/viewer：Groups、Help。

M1 Settings：运行状态和 lifecycle、全局 AI enable、从已有配置选择全局 Provider/模型、编辑全局 System Prompt。Provider/模型只展示公开名称，不返回 key、Base URL 或内部状态。

群列表管理员可快速选择有效 Provider/模型；复杂字段进入详情页，展示 dirty state、变更摘要并显式保存。Viewer 使用只读值而不是 disabled controls。

i18n 拆为 `common + miniApp` 核心，后台 namespace 懒加载。Mini App 采用 Telegram 语义颜色和 safe-area，自适应亮暗主题；现有后台继续保持自身视觉边界。

## 8. 隐私与生产安全

Bot 成为群管理员后，即使 Privacy Mode 开启也会收到全部群消息。因此上线前必须：

- 通用 Bot 日志永不持久化群消息正文，只保留事件类型、Bot/群/用户/消息 ID、时间和结果；
- Mini App chat grant 与 AI conversation/history grant 完全隔离；
- 添加群流程明确披露管理员 Bot 的消息可见性；
- 只有明确开启的业务能力才能在专用存储处理消息内容。

生产发布还要求：

- `/api/*` unmatched route 返回 JSON 404，不进入 SPA HTML fallback；
- hashed assets immutable cache，入口 HTML no-cache；
- Telegram WebView 兼容的 CSP 和安全头；
- HTTPS preflight；
- 分 surface error boundary，外部错误脱敏。

## 9. 高收益重构

M1 纳入：

1. 共享 Telegram command catalog，统一注册、`/help`、`setMyCommands` 与静态 Help；
2. `GroupConfigService.patch`；
3. database 使用 shared 的 `AiConfigStored`，移除重复类型；
4. `ChatAiSelectionService` 与单表 selection；
5. `BotLifecycleService`；
6. Summary update/delete 的 Bot-scoped atomic 修复与 cooldown 条件占用；
7. 群消息正文日志移除。

Provider 管理正规化、完整模型管理、JSON 配置完全正规化、多实例 CAS/共享缓存、分布式限流留到后续。

## 10. 实施 Goals

### G0：隐私与共享事实基线

完成群消息正文日志移除、共享 command catalog、`AiConfigStored` 类型收敛、Summary 原子安全修复。该 Goal 不开放 Mini App，但为后续权限和 Help 提供可信基础。

### G1：Telegram 身份、群目录与权限内核

完成 `initData` 验证、Bot-scoped session、Telegram Bot profile、chat catalog、两类 grant、audit、capability policy、membership verifier 与 chat identity migration。

### G2：公共 Help 与 Mini App shell

交付无需 session/API 的 Help、Telegram adapter、主题/safe-area、角色导航和无权限状态；不改变现有 Admin Panel 登录与路由。

### G3：访问名单纵向闭环

管理员可以搜索安全投影、按精确 ID 添加 operator、通过 deep link 添加并授权群、撤销 grant，并查看 90 天活动；viewer/operator 权限变化即时生效。

### G4：群配置纵向闭环

交付 Groups list/detail、viewer 投影、operator 字段级 PATCH、revision conflict、Summary 配置和运行态热应用，不整体覆盖 AI JSON。

### G5：全局与群级 Provider/模型

迁移单表 selection，交付 admin 全局/群级快捷选择、展示策略、统一 Telegram 命令和 Panel service，并修复持久化与运行态一致性。

### G6：Bot 生命周期与常用 Settings

交付 durable enable/disable/restart、timer 恢复、任务取消语义、全局 AI enable/System Prompt 与清晰的 pending-apply 状态。

### G7：生产硬化与单 Bot 灰度

完成 API fallback、Cookie/CSRF/Origin、基础限流、CSP/cache/HTTPS、错误脱敏、迁移/回滚演练和四类 Telegram 客户端验收，随后只对试点 Bot 开启。

后续实际实施时可按 Goals 创建子 Issue；当前只发布父级 Feature Epic。

## 11. 验收重点

- Bot A 的身份、Cookie、grant 和 chat ID 无法访问 Bot B。
- 非授权用户始终能看 Help，但拿不到 Bot capability 或部署状态。
- Admin/operator/viewer/none 的 DTO 和 mutation 符合权限矩阵。
- Grant 撤销立即阻止写入，viewer membership 最迟 60 秒失效。
- Bot 离线时 viewer fail closed；admin/operator 仍可保存已有配置。
- Provider/模型永不形成跨 Provider 非法组合，DB 失败不得伪装成功。
- Stop 后服务重启不自动复活；restart 不丢 active timer。
- 群升级后 grant/config/selection 使用新 chat ID 且冲突可审计。
- 任何 Mini App 响应、日志和前端状态都不包含 token、key、原始 `initData` 或群消息正文。
- Telegram iOS、Android、Desktop、Web 均完成登录、主题、返回、Cookie、权限撤销和失败态检查。

## 12. 参考

- `tasks/research-telegram-mini-apps/README.md`
- [Telegram Mini Apps](https://core.telegram.org/bots/webapps)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Telegram Deep Links](https://core.telegram.org/api/links)
