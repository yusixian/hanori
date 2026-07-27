# Telegram Mini App 本地 HTTPS 开发与测试 Bot

本文记录 2026-07-28 在本机实际跑通的开发链路。目标是在不部署生产环境、不修改其他 Bot 的前提下，用真实 Telegram `initData` 验证 Mini App。

## 当前测试拓扑

```text
Telegram 用户
  ├─ Bot API 长轮询 ───────────────> server :3000 ──> PostgreSQL :5433
  └─ Telegram WebView
       └─ https://tg-test.example.invalid
            ├─ /api/* ────────────> server :3000
            └─ 其他路径/静态资源 ──> Vite :5174
```

Cloudflare Tunnel 只负责 HTTPS 网页和 API。Telegram Bot 收消息使用 Bot API 长轮询，不经过 Tunnel；因此“网页打不开”和“Bot 完全不回复”要分开排查。

本机当前使用：

| 项目                    | 值                                                   |
| ----------------------- | ---------------------------------------------------- |
| HTTPS origin            | `https://tg-test.example.invalid`                         |
| 测试 Bot                | `@example_channel_bot`（示例测试 Bot）                  |
| 应用内 Bot ID           | `00000000-0000-4000-8000-000000000017`               |
| API                     | `http://127.0.0.1:3000`                              |
| Vite                    | `http://127.0.0.1:5174`                              |
| PostgreSQL              | `localhost:5433/cos_tool_bot`                        |
| Cloudflare named tunnel | `example-tunnel` / `00000000-0000-4000-8000-000000000029` |

不要把 Bot Token、Cloudflare credential JSON、`MINI_APP_SESSION_SECRET` 或后台密码写入本文或提交到 Git。

## 一次性准备

### 1. 安装依赖并准备 `.env`

```bash
pnpm install
cp .env.example .env # 仅首次；已有本地配置时不要覆盖
```

现有 `.env` 中至少需要数据库、Better Auth、Owner 和 Bot 加密相关配置。真实 Bot 已保存在本地数据库时，不需要再创建或粘贴 Token。

### 2. 建立 Tunnel DNS route

`tg-test.example.invalid` 已经指向现有 named tunnel，正常开发时不用重复执行。只有 DNS route 被删除后才运行：

```bash
cloudflared tunnel route dns 00000000-0000-4000-8000-000000000029 tg-test.example.invalid
```

### 3. 准备 Cloudflare ingress 配置

本次临时配置位于：

```text
/private/tmp/cos-tool-bot-telegram-mini-app-cloudflared.yml
```

`/private/tmp` 可能在重启后被清理。长期使用建议复制为 `~/.cloudflared/cos-tool-bot-tg-test.yml`，并使用下面的组合配置；它同时保留原有 `example-tunnel.example.invalid`，避免同一个 named tunnel 启动多个互不一致的 ingress 配置。

```yaml
tunnel: 00000000-0000-4000-8000-000000000029
credentials-file: /Users/example/.cloudflared/00000000-0000-4000-8000-000000000029.json

ingress:
  - hostname: example-tunnel.example.invalid
    service: http://localhost:3000
  - hostname: tg-test.example.invalid
    path: ^/api/.*
    service: http://localhost:3000
  - hostname: tg-test.example.invalid
    service: http://localhost:5174
  - service: http_status:404
```

credential 文件必须只留在 `~/.cloudflared`，不要复制进仓库。

## 每次开发的启动顺序

建议使用四个终端，并按下面顺序启动。

### 终端 A：数据库与 migration

```bash
pnpm dev:db
pnpm db:migrate
docker ps --filter name=cos-bot-dev-db-1
```

预期数据库容器为 `cos-bot-dev-db-1`，状态包含 `healthy`，宿主机端口为 `5433`。

### 终端 B：Server 与测试 Bot

在同一终端生成一次临时 session secret，再启动 server：

```bash
export COS_TOOL_BOT_MINI_APP_SESSION_SECRET="$(openssl rand -hex 32)"
BETTER_AUTH_URL=https://tg-test.example.invalid \
MINI_APP_SESSION_SECRET="$COS_TOOL_BOT_MINI_APP_SESSION_SECRET" \
pnpm --filter @cos-tool-bot/server dev
```

这个 secret 会在 `tsx --watch` 热重启之间保持不变；关闭终端后重新生成会让旧 Mini App session 失效，这是本地开发的预期行为。如果需要跨终端重启保留 session，使用密码管理器保存一个仅用于本地测试的固定随机值，不要提交到 `.env.example`。

预期日志包含：

```text
Database connected
Server running on http://localhost:3000
Starting 1 active bot(s)...
Bot started
```

只应启动当前数据库中 `is_active=true` 的 Bot。测试期间可在后台停止其他 Bot，避免混淆，但不要删除它们。

### 终端 C：Vite Panel

```bash
__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=tg-test.example.invalid \
pnpm exec vite --port 5174 --strictPort --host 127.0.0.1
```

这里显式使用 `5174`，避免与日常 `pnpm dev` 的默认 `5173` 冲突。Vite 自带 `/api` 到 `localhost:3000` 的本地 proxy；Cloudflare ingress 仍直接把公网 `/api/*` 转给 3000。

### 终端 D：Cloudflare Tunnel

使用持久化组合配置时：

```bash
cloudflared --config ~/.cloudflared/cos-tool-bot-tg-test.yml tunnel run
```

继续使用本次临时配置时：

```bash
cloudflared \
  --config /private/tmp/cos-tool-bot-telegram-mini-app-cloudflared.yml \
  tunnel run
```

同一个 named tunnel 最好只运行一套本机 ingress 配置。若存在另一个 `cloudflared tunnel run` 进程，先确认它是否服务其他项目；不要直接全部结束。

## 只给测试 Bot 开启 Mini App

1. 打开 [测试 Bot 编辑页](https://tg-test.example.invalid/bots/00000000-0000-4000-8000-000000000017/edit)。
2. 登录 Better Auth 后滚动到表单底部。
3. 开启“启用 Telegram Mini App（需先完成 HTTPS 配置）”。
4. 保存并确认该 Bot 恢复 `running`。
5. 不要给其他 Bot 打开该开关。

开关保存在本地 PostgreSQL 的 `bots.mini_app_enabled`，不是 `.env`。切换开关会短暂重启这一个 Bot，以重新注册 `/panel` 命令；不会主动启停其他 Bot。

## BotFather 设置

代码中的 `/panel` 不依赖 BotFather Main Mini App。BotFather 的设置只用于 Bot 资料页上的全局 `Open App` 按钮。

如需启用，在 `@BotFather` 为 `@example_channel_bot` 配置：

```text
https://tg-test.example.invalid/mini-app/00000000-0000-4000-8000-000000000017/help
```

需要撤销时在 BotFather 使用 `/empty`。不要把普通后台路由 `/bots/...` 配成 Mini App URL。

## 手工验证

### 1. HTTPS 与路由

```bash
curl -fsS https://tg-test.example.invalid/api/health
curl -fsS -o /dev/null -w '%{http_code}\n' \
  https://tg-test.example.invalid/mini-app/00000000-0000-4000-8000-000000000017/help
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://tg-test.example.invalid/api/definitely-not-a-route
```

预期依次为健康 JSON、`200`、`404`。

### 2. Bot 长轮询

私聊 `@example_channel_bot`，依次发送：

```text
/help
/panel
```

`/help` 应正常回复；`/panel` 应回复带 `Open Panel` 的 Web App 按钮。后台日志页应出现相应 command 记录。

如果所有命令和普通消息都不回复，这不是 Tunnel 问题。先确认只有一个进程使用该 Token，再重启当前 server。`f97493f` 起，Bot 每次启动都会显式重置 Telegram `allowed_updates`，不会再继承只允许 `channel_post` 的旧状态。

### 3. 真实 Mini App 身份

必须从 Telegram 私聊中的 Web App 按钮进入，才能获得签名 `initData`。直接在普通浏览器打开 Help 是允许的，但 Admin/Groups/Settings/Access 等受保护页面没有 Telegram `initData` 时返回 Help 或未认证状态，不能算真实验收。

至少检查：

- Admin 能看到管理导航与当前 Bot 数据；
- 无授权用户只能看到公开 Help；
- 关闭 `miniAppEnabled` 后旧 session 也不能继续读取 Mini App API；
- Provider/Model、群配置、权限与 lifecycle mutation 均只出现在对应角色下。

## Telegram 群与 Channel 怎么测

Mini App M1 的可授权对象是 `group` / `supergroup`，不是广播 Channel。要测试 Viewer 与群配置，推荐创建一个私有测试群或 supergroup：

1. 添加 `@example_channel_bot`；
2. 将 Bot 提升为管理员；
3. 在群里发送一条消息，让本地服务观察到该群；
4. Admin 从 Mini App 的 Access 页面实时验证并授权该群；
5. 用群内普通成员身份进入 Mini App，验证只能查看该授权群且不能执行重要操作。

如果单独创建 Telegram Channel，它可以用于验证 `channel_post` 是否被 Bot 收到，但不会作为 Mini App 白名单群授权目标。Bot 用户名中包含 `channel` 不代表必须使用 Channel。

## 停止本地环境

按以下顺序在各终端 `Ctrl-C`：

1. `cloudflared`；
2. Vite；
3. server。

数据库可继续保留。需要停止时：

```bash
docker compose -p cos-bot-dev -f docker-compose.dev.yml stop
```

不要删除 volume；本地 Bot、账号、grant 与测试数据都保存在其中。

## 常见故障

| 现象                             | 优先检查                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------- |
| `tg-test` HTML 能打开但页面白屏  | Vite 5174 是否仍在运行；Tunnel 日志是否能连接 5174                              |
| `/api/health` 为 502/503         | server 3000 是否运行，数据库是否 healthy                                        |
| Mini App session API 为 404      | 该 Bot 的 `miniAppEnabled` 是否真的开启                                         |
| 直接浏览器打开受保护页显示未认证 | 正常；真实身份必须从 Telegram Web App 按钮进入                                  |
| Bot 所有消息都没反应             | 与 Tunnel 无关；检查 server、唯一 Token 消费者与长轮询 `allowed_updates`        |
| Bot 日志只有 started/stopped     | 更新没有进入进程；先测试 `/help`，再查 Telegram polling，而不是查前端           |
| `/panel` 不在 Telegram 命令列表  | 开关未生效或 Bot 重启失败；重新保存开关并查看 server 日志                       |
| Tunnel 随机 404                  | 同一个 named tunnel 可能运行了不同 ingress 配置；合并配置并只保留一套 connector |
| 保存 Mini App 开关返回 503       | 设置可能已持久化但 Bot 重启失败；修复 HTTPS/server 后关闭再开启以 reconcile     |

## 相关验证命令

```bash
pnpm --filter @cos-tool-bot/panel typecheck
pnpm --filter @cos-tool-bot/server typecheck
pnpm test:browser
pnpm i18n:check
pnpm lint
pnpm fmt:check
pnpm build
```

完整权限、部署与回退契约见 [Telegram Mini App 开发说明](./TELEGRAM_MINI_APP.md)。
