# Telegram Mini App 开发说明

本机使用真实测试 Bot、Cloudflare Tunnel 与 `tg-test.example.invalid` 的可重复启动步骤见 [Telegram Mini App 本地 HTTPS 开发与测试 Bot](./TELEGRAM_MINI_APP_LOCAL_DEV.md)。

Telegram Mini App 与现有 Better Auth 管理后台共用一个 Vite SPA 和一个 `BrowserRouter`，但拥有独立的 lazy chunk、session facade、错误边界、Telegram adapter 与 scoped CSS。Mini App 不挂载 Refine，也不会把 Telegram theme 写到 `document` 或后台页面。

## Route map

| Route                              | Session     | 行为                                              |
| ---------------------------------- | ----------- | ------------------------------------------------- |
| `/mini-app/:botId/help`            | 非必需      | 始终显示项目背景和 shared public command help     |
| `/mini-app/:botId/groups`          | 必需        | 展示当前角色范围内的安全群目录                    |
| `/mini-app/:botId/groups/:chatId`  | 必需        | 查看群配置，并按 capability 决定是否渲染编辑控件  |
| `/mini-app/:botId/settings`        | Admin       | 生命周期、AI 总开关、System Prompt、Provider/模型 |
| `/mini-app/:botId/access`          | Admin       | 管理群授权、Operator 与近 90 天权限活动           |
| `/mini-app/:botId/logs`            | Admin       | 查询当前 Bot 的脱敏运行日志                       |
| `/login`、`/bots/*` 和其他现有路由 | Better Auth | 继续进入独立 `AdminPanelApp`                      |

公共 Help 的命令来自 `TELEGRAM_COMMAND_CATALOG`，只选择 `publicHelpVisibility = public`。它不依赖 Telegram SDK 或 session API 的成功响应，也不展示 Bot capability、Provider 数量、运行状态或部署信息。

## Telegram adapter

`packages/panel/src/mini-app/telegram-adapter.ts` 封装：

- `initData`、theme、viewport、safe area 与 content safe area；
- `ready()` / `expand()`；
- BackButton show/hide、handler 注册与 cleanup；
- Telegram `themeChanged`、`viewportChanged`、`safeAreaChanged` 和 `contentSafeAreaChanged` 订阅清理；
- 只写入传入 Mini App root 的 `--tg-*` CSS variables。

Telegram SDK 只在 `/mini-app/*` surface 懒加载，现有 `/login`、`/bots/*` 不加载远端脚本，也不允许 Telegram framing。SDK 缺失时 adapter 为安全 no-op，Help 仍可直接打开。Telegram 提供非空 `initData` 时总是先交换当前身份的新 session，避免账号切换后复用旧 Cookie；只有没有新 `initData` 时才读取 Bot-scoped Cookie。401 显示会话过期，403 回到 Help，网络/响应异常 fail closed。

会话 Cookie 使用 `HttpOnly; Secure; SameSite=None; Partitioned` 以支持 Telegram Web 跨站 iframe，并将 Path 限定到单一 Bot API；写请求仍必须同时通过同源 `Origin` 与 session CSRF 校验。

## Access 管理

Access 页只对当前 Bot 的 Mini App Admin 开放；Operator、Viewer 和 `none` 角色仍由客户端路由门禁导回允许页面，服务端 API 必须继续独立执行 Admin capability 校验。所有 mutation 都携带 Bot-scoped session 的 `x-mini-app-csrf`，成功后重新获取完整权限投影，因此撤销不依赖旧 session 过期。

群授权最终只允许 Bot 实时身份为 `administrator|creator` 的已观察群。页面中的 `botMembershipStatus` 是缓存提示：非管理员、未知、left 或 kicked 状态会醒目提醒，但 Admin 仍可点击“实时验证并授权”，由服务端 mutation 获取当前 Telegram 身份并决定是否接受，避免旧缓存阻止恢复。通过“添加群组”打开的 Telegram deep link 仅申请 `manage_chat` 和 `pin_messages`；返回 Mini App 后可刷新再授权。若 Bot 之后离群或失去管理员身份，服务端仍必须在写入时实时拒绝，而不能只信任前端显示。

Operator 可以管理当前 Bot 的全部已授权群，无需成为这些群的成员；Viewer 始终需要是具体授权群的当前成员。Operator grant 与 AI/private-chat allowlist 完全独立，撤销后下一次写入必须立即失败。

人物搜索只使用 Telegram ID、username 和 display name，并只返回 ID、username、display name、last-seen 投影；不得搜索或返回 notes、traits、interests、AI 对话或人物档案内容。username 只帮助发现候选人，最终授权始终提交精确的正整数 Telegram ID。未被目录观察到的精确 ID 会明确标记为“资料未验证”，note 为可选上下文，不是强制授权理由。

## 群配置

`GET /api/mini-app/:botId/groups` 和详情接口只返回当前 capability 与 chat scope 允许的安全投影。Viewer 看到真实值但不会收到可编辑控件；Operator/Admin 的写请求必须同时携带同源 `Origin`、Bot-scoped Cookie 与 session 中的 `x-mini-app-csrf`。

Mini App 只允许字段级 PATCH：

| 区域    | 允许字段                                                 |
| ------- | -------------------------------------------------------- |
| 群运行  | `enabled`、`whitelisted`                                 |
| 触发    | reply、mention、trigger words、随机回复比例与 cooldown   |
| 对话    | enabled、上下文消息上限、群历史 token 上限               |
| Summary | enabled、schedule、timezone、window、消息上限与 cooldown |

Provider、模型、Prompt、工具、凭据、人物档案、聊天历史和用量不会出现在 G4 DTO，也不能通过 over-posting 写入。未配置 AI 的 Bot 仍可修改独立 Summary 配置，但群 AI 字段返回 `ai_not_configured`。

详情携带 opaque `revision`。保存时服务端在按 Bot 串行边界内重新锁定并读取最新 DB 数据；版本过期返回 `409 stale_revision` 和最新安全投影，客户端不得自动覆盖。DB commit 与运行态 apply 同属一个进程内 Bot 串行边界，避免旧请求反向覆盖新请求。DB 失败不会修改 runtime；runtime 失败则返回 `persisted: true, applied: false`，详情保持 `pending`，直到 Admin 手动 retry 或 Bot 下次从 DB 启动。

现有 Web Panel 的整页 AI 配置保存也携带 Bot revision。任一侧先写入后，另一侧的旧草稿会收到 409 并保留在页面中等待人工刷新核对，避免整页 PUT 把 Mini App 刚写入的 `groupOverrides` 覆盖回旧版本。

页面遵循以下交互边界：

- Viewer 与归档群使用独立的只读投影，不渲染 disabled 表单；Operator/Admin 才能看到 G4 字段的编辑控件。
- 本地修改会先显示字段级变更摘要，只有显式保存才发出 PATCH；放弃变更会恢复当前已读取版本。
- `409 stale_revision` 会保留本地草稿并展示冲突，不自动重试或覆盖；用户必须显式采用服务端最新版本后重新修改。
- `persisted: true, applied: false` 显示为 `pending`。所有角色都能看到状态，但只有 Admin 会收到“重试应用”操作。
- 未配置 AI 时不渲染群 AI 编辑控件，但 Operator/Admin 仍可编辑 Summary；响应 JSON 在进入 UI 前必须通过字段、范围与敏感键校验。

M1 明确为单实例控制面；跨实例锁、共享 pending 状态与常驻 retry worker 后移。

## Provider、模型与 Bot Settings

全局和群级 Provider/模型都通过 `ChatAiSelectionService` 原子保存。Admin 可以修改；Operator、Viewer 只能在展示策略允许时看到公开 label，响应不会包含 Provider ID、Model ID、Base URL、credential 或候选目录。群级 row 不存在表示继承全局值；reset 会删除群级 selection。Provider 与模型必须来自同一个可用 Provider，Telegram `/provider`、`/model`、Better Auth Panel 和 Mini App 共用同一持久化与运行态发布路径。

Settings 页仅 Admin 可见，并提供：

- durable Bot enable/disable/restart，分别展示 `desiredActive`、`runtimeStatus` 与 `reconciled`；
- Bot 全局 AI enable 与 System Prompt；
- 全局 Provider/模型和默认公开展示策略。

Enable 直接执行；Disable 与 Restart 需要二次确认，不要求原因。`isActive` 是唯一 durable desired state：Disable 后 server restart 不会复活 Bot；runtime 失败时持久化状态仍保留，UI 显示 pending/unreconciled。Stop 会停止接收新 update 并取消当前进程中的 active Bot work；已经发送到外部系统的消息或请求不会回滚。Active timer 保留在数据库，重新启动后恢复；投递使用 60 秒 `processing` lease，同一 lease 只有一个 worker，成功后才标记 `fired`，已知失败回到 `active` 并在当前进程重试一次。若进程恰好在 Telegram 已接收、DB 标记成功前崩溃，lease 过期后的恢复可能重复投递——这是外部 API 无幂等键时选择“避免永久丢失”的 at-least-once 边界。事件返回空文本时会补发确定性提示；已知只读工具可安全重放，未知工具默认视为有副作用；副作用已经成功后，即使后续发送失败也不整段重放，以免重复图片生成、写文件、写记忆或 Telegram 操作。Timer 将这种“仅副作用成功”视为已消费；scheduled RSS 不暴露写工具，只有收到可见 Telegram delivery 才由服务统一推进整批 checkpoint，AI 停用、隐私关闭或发送失败都不会消费整批待发送项目。

## 运行日志

日志页复用 `audit.read` capability，只对当前 Bot 的 Admin 显示并开放 API；Operator、Viewer 与无授权用户都在服务端返回 403，关闭 Mini App 的 Bot 返回 404，其他 Bot 的 session Cookie 返回 401。该能力不扩展现有角色模型，也不允许通过前端路由或隐藏导航绕过服务端授权。

`GET /api/mini-app/:botId/logs` 是只读、按 Bot 隔离的游标分页接口，单页最多 50 条并支持 level 筛选。M1 不提供自由文本搜索、SSE、自动轮询、下载或删除；用户显式刷新或加载更早日志，避免 raw message 侧信道、移动端持续连接和后台耗电。

响应使用显式安全投影：只返回 `id`、`createdAt`、`level`、allowlist 固定事件文案，以及 allowlist 中的 `command`、`chatType`、`updateId`、`messageId`。不得回显数据库中的自由文本 `message` 或原始 `meta`，也不得返回消息正文、caption、文件名、sticker pack、参数、Provider/模型凭据、错误对象或 stack；未知事件按 level 映射成通用运行事件。客户端按严格 schema 拒绝多余字段。所有 `/api/mini-app/*` 响应由应用本身设置 `Cache-Control: private, no-store`，反向代理仍必须保持不缓存。

## 生产灰度 Runbook

### 1. 准备与迁移

1. 对生产数据库创建可恢复快照，并记录当前应用 commit；不要把连接串或快照提交到仓库。
2. 设置公开 HTTPS origin，例如 `BETTER_AUTH_URL=https://bot.example.com`。不能使用 localhost、裸 HTTP、额外 path 或尾部 `/`。
3. 生成独立的 `MINI_APP_SESSION_SECRET`（至少 32 字符，不复用 Bot Token、`BETTER_AUTH_SECRET` 或 encryption key）。
4. 保持所有 Bot 的 `miniAppEnabled=false`，部署新版本并运行 `pnpm db:migrate`。
5. 在克隆/测试数据库检查 migration report，再启动应用完成 smoke test。`0038` 会保留 legacy override 表供兼容/核对，并先把正数私聊 ID 记为 `ignored`；`0039` 只新增默认 false 的 `mini_app_enabled`；`0040` 放宽 selection 为安全非零 Telegram conversation ID，并重新校验、恢复仍有效的旧私聊 Provider/模型选择。超出 JS safe integer 的 ID 始终不迁移。

建议在隔离数据库演练：从快照恢复一份副本 → 运行 `pnpm db:migrate` → 检查 `chat_ai_selection_migration_reports`、正数/负数 `chat_ai_selections` 和原 legacy rows → 再从同一快照恢复另一份副本验证恢复流程。仓库不提供 destructive down migration；应用回滚时保留新增表/列最安全。旧应用会忽略正数 selection row；若必须恢复负数专用约束，需先备份并删除正数 row，否则 constraint 无法收紧。

### 2. HTTPS 与响应预检

将 `<origin>` 和 `<botId>` 替换为真实值：

```bash
curl -fsS -D - -o /dev/null <origin>/mini-app/<botId>/help
curl -fsS -D - -o /dev/null <origin>/assets/<hashed-asset>
curl -sS -i <origin>/api/definitely-not-a-route
```

确认 HTML 为 `no-cache, no-store, must-revalidate`，hash asset 为一年 `immutable`；Mini App HTML 的 CSP 允许 Telegram SDK/framing，后台与 API 的 CSP 只允许 self 且 `frame-ancestors 'none'`；所有响应含 `nosniff`、Referrer/Permissions Policy，未知 `/api/*` 返回可见的 JSON 404。反向代理必须保留 `Origin`、Cookie 和 `Set-Cookie`，且不能缓存 `/api/mini-app/*`。

### 3. 只开启测试 Bot

1. 在现有 Better Auth Panel 编辑测试 Telegram Bot，开启“Telegram Mini App”，保存后确认 Bot 恢复 running；HTTPS 配错会持久化选择但返回 503，修正后可再次关闭/开启以 reconcile。
2. 私聊测试 Bot 发送 `/panel`。只有 private chat 使用 Telegram `web_app` 按钮并携带签名 `initData`；群内 `/panel` 只引导用户进入 Bot 私聊，不把普通网页 URL 伪装成已认证入口。
3. 可选配置永久 Menu Button：在 `@BotFather` 使用 `/setmenubutton`，选择测试 Bot，将 URL 设置为 `<origin>/mini-app/<botId>/help`。代码不会自动覆盖既有 Menu Button。
4. 不在确认四端通过前给其他 Bot 开启开关。

### 4. 测试身份与四端验收

准备四类独立身份，真实 ID/群名只记在私有发布记录中：Admin（在该 Bot `adminChatIds`）、Operator grant、已授权群当前成员 Viewer、无授权用户。至少准备一个已授权测试群，并让 Bot 为 administrator/creator。

| 客户端           | 登录/initData | 主题/safe area/返回 | 角色与字段投影 | 配置+冲突/pending | 撤权即时生效 | lifecycle | 状态 |
| ---------------- | ------------- | ------------------- | -------------- | ----------------- | ------------ | --------- | ---- |
| Telegram iOS     |               |                     |                |                   |              |           | 待测 |
| Telegram Android |               |                     |                |                   |              |           | 待测 |
| Telegram Desktop |               |                     |                |                   |              |           | 待测 |
| Telegram Web     |               |                     |                |                   |              |           | 待测 |

每端都要验证：None 只能看 Help；Viewer 只能读自己仍属于的授权群；Operator 可写所有授权群的低风险字段但不能管理 access/lifecycle/selection；Admin 可管理 access、任意当前群、Provider/模型和 lifecycle。撤销 chat/operator grant 后，下一个请求立即失权；隐藏 Provider/模型时非 Admin 响应中连内部 ID 都不存在。Stop 后确认其他 Bot 正常、timer/RSS 未丢，Enable 后恢复；Restart 不改变 desired state。

### 5. 回退

1. 先在 Better Auth Panel 关闭该 Bot 的 `miniAppEnabled`，确认 Mini App API（包括旧 Cookie）返回 404，Bot 私聊 `/panel` 从命令菜单移除且 Bot 仍运行。
2. 若配置过 Menu Button，在 `@BotFather` `/setmenubutton` 中恢复默认/移除自定义入口。
3. 如需立即注销全部 Mini App session，可轮换 `MINI_APP_SESSION_SECRET`；这不影响 Bot Token、聊天数据或 Better Auth session。
4. 回滚应用版本时保留 additive schema。只有 migration 数据本身需要撤销时才停服务并恢复预迁移数据库快照；不要手工删除新表或猜测反向 SQL。
5. 原 AI `whitelisted` 与 `privateChatWhitelist` 不属于 Mini App grant，开关或回退不得修改它们。

## DEV mock

mock 只能在 Vite `import.meta.env.DEV` 分支进入，production build 在读取 query/localStorage 前已经返回。开发环境可打开：

```text
http://localhost:5173/mini-app/<botId>/help?tgWebAppMock=1&tgWebAppColorScheme=dark
```

可选 query：

- `tgWebAppColorScheme=light|dark`
- `tgWebAppInitData=<fixture>`

也可以写入 localStorage key `cos-tool-bot:telegram-mini-app-mock`：

```json
{ "enabled": true, "colorScheme": "dark", "initData": "fixture" }
```

mock 仅用于浏览器布局和失败态开发，不能替代真实 Telegram `initData` 验证。

## 本地验证

```bash
pnpm --filter @cos-tool-bot/panel typecheck
pnpm --filter @cos-tool-bot/panel build
pnpm test:browser
pnpm i18n:check
pnpm lint
pnpm fmt:check
```

Telegram 四端验收尚需在真实 HTTPS 环境完成；本地自动化不能替代真实 `initData`、Cookie 与 WebView 行为。可将发布证据保存在不含真实 ID/secret 的私有记录中。

截图建议：

- `docs/screenshots/telegram-mini-app-help-light.png`
- `docs/screenshots/telegram-mini-app-help-dark.png`
- `docs/screenshots/telegram-mini-app-session-expired.png`
