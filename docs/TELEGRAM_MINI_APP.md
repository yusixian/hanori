# Telegram Mini App 开发说明

Telegram Mini App 与现有 Better Auth 管理后台共用一个 Vite SPA 和一个 `BrowserRouter`，但拥有独立的 lazy chunk、session facade、错误边界、Telegram adapter 与 scoped CSS。Mini App 不挂载 Refine，也不会把 Telegram theme 写到 `document` 或后台页面。

## Route map

| Route                              | Session     | G2 行为                                       |
| ---------------------------------- | ----------- | --------------------------------------------- |
| `/mini-app/:botId/help`            | 非必需      | 始终显示项目背景和 shared public command help |
| `/mini-app/:botId/groups`          | 必需        | 按角色显示 shell；业务目录在 G3–G4 接入       |
| `/mini-app/:botId/settings`        | Admin       | G2 仅显示无写操作的占位页                     |
| `/mini-app/:botId/access`          | Admin       | 管理群授权、Operator 与近 90 天权限活动       |
| `/login`、`/bots/*` 和其他现有路由 | Better Auth | 继续进入独立 `AdminPanelApp`                  |

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
