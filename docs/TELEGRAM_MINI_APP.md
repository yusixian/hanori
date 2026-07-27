# Telegram Mini App 开发说明

Telegram Mini App 与现有 Better Auth 管理后台共用一个 Vite SPA 和一个 `BrowserRouter`，但拥有独立的 lazy chunk、session facade、错误边界、Telegram adapter 与 scoped CSS。Mini App 不挂载 Refine，也不会把 Telegram theme 写到 `document` 或后台页面。

## Route map

| Route                              | Session     | 行为                                             |
| ---------------------------------- | ----------- | ------------------------------------------------ |
| `/mini-app/:botId/help`            | 非必需      | 始终显示项目背景和 shared public command help    |
| `/mini-app/:botId/groups`          | 必需        | 展示当前角色范围内的安全群目录                   |
| `/mini-app/:botId/groups/:chatId`  | 必需        | 查看群配置，并按 capability 决定是否渲染编辑控件 |
| `/mini-app/:botId/settings`        | Admin       | G6 前仅显示无写操作的占位页                      |
| `/mini-app/:botId/access`          | Admin       | 管理群授权、Operator 与近 90 天权限活动          |
| `/login`、`/bots/*` 和其他现有路由 | Better Auth | 继续进入独立 `AdminPanelApp`                     |

公共 Help 的命令来自 `TELEGRAM_COMMAND_CATALOG`，只选择 `publicHelpVisibility = public`。它不依赖 Telegram SDK 或 session API 的成功响应，也不展示 Bot capability、Provider 数量、运行状态或部署信息。

## Telegram adapter

`packages/panel/src/mini-app/telegram-adapter.ts` 封装：

- `initData`、theme、viewport、safe area 与 content safe area；
- `ready()` / `expand()`；
- BackButton show/hide、handler 注册与 cleanup；
- Telegram `themeChanged`、`viewportChanged`、`safeAreaChanged` 和 `contentSafeAreaChanged` 订阅清理；
- 只写入传入 Mini App root 的 `--tg-*` CSS variables。

SDK 缺失时 adapter 为安全 no-op，Help 仍可直接打开。受保护页面先读取 Bot-scoped Cookie；401 且存在 `initData` 时才交换新 session。401 显示会话过期，403 回到 Help，网络/响应异常 fail closed。

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

截图占位（G7 用 Telegram 四端实测产物替换）：

- `docs/screenshots/telegram-mini-app-help-light.png`
- `docs/screenshots/telegram-mini-app-help-dark.png`
- `docs/screenshots/telegram-mini-app-session-expired.png`
