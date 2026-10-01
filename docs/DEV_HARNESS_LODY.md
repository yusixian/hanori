# Dev Harness：lody-bridge 执行层

`/bug` 需要调用 `lody session create --machine <id>` 在 owner 的 Mac 上开会话，而 `session create` 要求调用方本机运行 Lody daemon。生产镜像 `node:22-alpine` 装不上 Lody 的原生模块（`@lydell/node-pty` 没有 musl 预编译），所以 Lody 放在独立的 sidecar `lody-bridge` 中运行：

```text
app（alpine） ──HTTP + Bearer 密钥──► lody-bridge（bookworm-slim，lody@0.103.0 + daemon） ──► Lody 云 ──► Mac
             harness-bridge 网络（internal）              harness-egress 网络（出站）
```

## 边界

- bridge 只执行白名单内的命令：`--version`、`machine list`、`agent-config list`、`session create|chat|show|status|history|cancel|archive` 及其已知参数（见 `infrastructure/lody-bridge/allowlist.mjs`）。`login`、`daemon`、`delete`、`--env`、`--debug`、位置参数形式的 prompt 和 `--flag=value` 写法一律拒绝；`--config-option` 只接受 `reasoning_effort=<强度>` 和 `effort=<强度>`。`--wait --timeout <10–86400 秒>` 只允许用在 `session create`（人类可读输出，不带 `--json`）和带 `--jsonl` 的 `session chat` 上，两者必须同时出现。
- `agent-config list` 的输出在 bridge 内先裁剪，只保留每个执行配置的 `id`、`name`、`agentType`、`machineId`、模型 ID、名称和推理强度，以及分页信息；`env`（可能含 API key）不会离开 sidecar。
- 经认证的 `GET /runtime` 返回服务器 CLI 版本，`POST /runtime` 安装官方 npm 最新稳定版并重启 daemon。更新包写入 `lodyhome` 卷的 `cli/releases/`，验证后原子切换 `cli/current`；重建容器沿用此版本。安装失败保留旧版，启动失败尝试恢复旧版。运行命令、等待回合或本机会话仍运行时拒绝更新；更新期间暂停 daemon watchdog、拒绝新的 `/exec`。app 还会暂停任务调度并拒绝在已有活动任务时开始更新。此端点不接受包名、版本、命令或安装路径等客户端参数。
- prompt 只能通过 stdin（`--prompt-file -`）传入，最大 256 KiB。每条命令有超时（最长 180 秒）和 8 MiB 输出上限，超出时强制终止，harness 按「结果未知」处理，不会自动重试 `session create`。
- 认证使用 `HARNESS_LODY_BRIDGE_SECRET`（至少 32 个字符），用固定长度摘要做常量时间比较。bridge 日志只记录子命令、退出状态和耗时，不记录参数值、prompt、token 或 stdout。
- 子进程的环境变量中去掉了 `LODY_CLI_TOKEN` 和 bridge 密钥；bridge 进程启动前入口脚本也会 `unset LODY_CLI_TOKEN`。
- 带 `--wait` 的命令由 `waiter.mjs` 执行：`session create` 打印出会话 ID、`session chat` 打印出第一条 JSON Lines 事件（或运行超过 20 秒）时即视为 Lody 已接受，bridge 立即应答 app，stdout 换成与普通命令相同的 JSON（只含 `ok` 和 `sessionId`）。接受前退出或出错时按普通命令的结果返回；接受阶段仍受 180 秒上限约束。子进程继续等到回合结束，bridge 再向 `HARNESS_LODY_CALLBACK_URL` 发一条签名回调：body 只有 `sessionId`、`command`、`status`（`completed`/`failed`/`canceled`/`timeout`）、`exitCode` 和起止时间，没有对话内容；请求头 `x-harness-timestamp` 为 Unix 秒，`x-harness-signature` 为 `sha256=<hex>`，即以 `HARNESS_LODY_BRIDGE_SECRET` 为密钥对 `<timestamp>.<body>` 做 HMAC-SHA256。等待进程读到的回复正文只用来判断事件类型，随即丢弃。
- 同时等待的回合最多 `LODY_BRIDGE_MAX_WAITERS` 个（默认 8），超出时返回 429，harness 改用不带 `--wait` 的普通命令。app 不可达、超时、408/429/5xx 时回调在 2、10、30 秒后重试，仍失败就放弃并记一行日志（不含会话 ID）；其他状态码不重试。回调丢失时 harness 仍靠轮询发现会话停下。
- Lody CLI 只接受 `--auth <token>` 形式的参数。入口脚本先用 `lodyhome` 卷里保存的登录启动 daemon，失败时才带 token 重试，所以 token 只在首次启动或更换后短暂出现在容器内的进程参数里。
- bridge 每 `LODY_DAEMON_WATCH_MS` 执行一次 `lody daemon status`，daemon 不在时用保存的登录重新启动。重启失败时 `/health` 返回 503，容器显示 unhealthy。
- 容器以非 root 的 `node` 用户运行，`cap_drop: ALL`、`no-new-privileges`，不发布主机端口；`~/.lody` 保存在命名卷 `lodyhome` 中。

## 配置

| 变量                         | 设置在      | 说明                                                                        |
| ---------------------------- | ----------- | --------------------------------------------------------------------------- |
| `LODY_CLI_TOKEN`             | lody-bridge | Lody CLI Token；没有保存的登录时入口脚本用它执行 `lody daemon start --auth` |
| `HARNESS_LODY_BRIDGE_SECRET` | 两个服务    | 共享 Bearer 密钥，至少 32 个字符，两边必须相同                              |
| `HARNESS_LODY_BRIDGE_URL`    | app         | `http://lody-bridge:43190`；留空时 harness 使用本地 `lody` CLI              |
| `LODY_MACHINE_NAME`          | lody-bridge | 可选，注册到 Lody 的机器名，默认 `cos-tool-bot-server`                      |
| `LODY_DAEMON_WATCH_MS`       | lody-bridge | 可选，daemon 巡检间隔，默认 `60000`；`0` 关闭自动重启                       |
| `LODY_VERSION`               | 构建参数    | 可选，默认 `0.103.0`；作为未安装持久化更新时的初始 CLI 版本                 |
| `HARNESS_LODY_CALLBACK_URL`  | lody-bridge | 可选，回合结束回调地址，默认 `http://app:3000/api/harness/lody/turn`        |
| `LODY_BRIDGE_MAX_WAITERS`    | lody-bridge | 可选，同时等待结束的回合数上限，默认 `8`                                    |

harness.yaml 中 `executors.lody.bridge.urlEnv` / `secretEnv` 可以改成别的环境变量名；这两个字段只能通过 YAML 修改，Telegram 覆盖层不能改。app 用同一个 `HARNESS_LODY_BRIDGE_SECRET` 校验回调；未设置时 `/api/harness/lody/turn` 返回 404。`executors.lody.turnWait`（默认 `2h`）是传给 `--timeout` 的等待时长，设为 `null` 时不带 `--wait`，只靠轮询。本地 CLI 模式（未设置 bridge URL）同样带 `--wait`，由 app 进程内的等待池（上限 8）直接处理回合结束。

## Dokploy 部署步骤

1. 在 Lody 桌面端打开 Settings → Account → CLI Token，创建一个 token。它能在 owner 的机器上启动 agent，只存放在 Dokploy 的环境变量里。
2. 生成共享密钥，例如 `openssl rand -hex 32`。
3. 在 Dokploy 的 Compose 应用 → Environment 中设置：
   ```text
   COMPOSE_PROFILES=harness        # 已启用 coding worker 时写 coding,harness（在原值后追加，不要覆盖）
   LODY_CLI_TOKEN=<CLI Token>
   HARNESS_LODY_BRIDGE_SECRET=<共享密钥>
   HARNESS_LODY_BRIDGE_URL=http://lody-bridge:43190
   ```
4. 重新部署。`lody-bridge` 会随 `harness` profile 一起构建和启动。
5. 验证：
   - `lody-bridge` 容器健康检查为 healthy，日志中有 `lody-bridge: daemon started`（重启后为 `daemon started with the saved login`）；
   - 在 Lody 桌面端的机器列表中能看到 `cos-tool-bot-server`（不要把它加入 harness.yaml 的 `machines`，harness 不会往它派任务）；
   - 在 harness 群 General 话题中发 `/status`，执行层一行显示在线机器，并注明「经lody-bridge」。
6. 在项目话题中发一条 `/bug` 做端到端验证。

## 排查

- `/status` 显示「无法连接 lody-bridge」：检查 `HARNESS_LODY_BRIDGE_URL` 与 `harness` profile 是否启用。
- 显示「lody-bridge 拒绝了认证」：两个服务的 `HARNESS_LODY_BRIDGE_SECRET` 不一致。
- 显示 `Not logged in`，或日志出现 `daemon is down and restart failed`：保存的登录或 token 已失效。可在容器中执行 `lody daemon status` 和 `lody daemon logs`；更换 token 后重新部署。
- 升级 `LODY_VERSION` 后，重新核对 `lody session create --help` 等输出与白名单是否一致，并确认 `--wait` 的输出没有变：`session create` 在人类可读模式下先单独打印一行会话 ID，`session chat --jsonl` 输出 `update`/`done`/`error` 事件（0.100.0 的实现如此，未在文档中承诺）。
- 回合结束后卡片迟迟不变：看 bridge 日志中的 `turn <status> …; callback …`。`callback failed (401)` 表示两边密钥不一致；`failed (network)` 表示 bridge 访问不到 `HARNESS_LODY_CALLBACK_URL`。

## 本地验证记录（2026-09-25）

在 arm64 的 Docker 中构建 `lody-bridge` 阶段并以无 token 方式运行，确认：以 `node` 用户运行；`lody --version` 为 0.100.0；`/health` 返回版本；未认证请求返回 401；白名单外命令返回 400；通过 bridge 执行 `--version` 成功；未登录时 `machine list` 返回 Lody 的 `Not logged in` 错误；compose 中的健康检查命令通过。尚未使用真实 token 验证 daemon 登录与跨机器创建会话。
