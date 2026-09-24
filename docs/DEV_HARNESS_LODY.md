# Dev Harness：lody-bridge 执行层

`/bug` 需要调用 `lody session create --machine <id>` 在 owner 的 Mac 上开会话，而 `session create` 要求调用方本机运行 Lody daemon。生产镜像 `node:22-alpine` 装不上 Lody 的原生模块（`@lydell/node-pty` 没有 musl 预编译），所以 Lody 放在独立的 sidecar `lody-bridge` 中运行：

```text
app（alpine） ──HTTP + Bearer 密钥──► lody-bridge（bookworm-slim，lody@0.100.0 + daemon） ──► Lody 云 ──► Mac
             harness-bridge 网络（internal）              harness-egress 网络（出站）
```

## 边界

- bridge 只执行白名单内的命令：`--version`、`machine list`、`session create|chat|show|status|cancel|archive` 及其已知参数（见 `infrastructure/lody-bridge/allowlist.mjs`）。`login`、`daemon`、`delete`、`--env`、`--debug`、`--wait`、位置参数形式的 prompt 和 `--flag=value` 写法一律拒绝。
- prompt 只能通过 stdin（`--prompt-file -`）传入，最大 256 KiB。每条命令有超时（最长 180 秒）和 8 MiB 输出上限，超出时强制终止，harness 按「结果未知」处理，不会自动重试 `session create`。
- 认证使用 `HARNESS_LODY_BRIDGE_SECRET`（至少 32 个字符），用固定长度摘要做常量时间比较。bridge 日志只记录子命令、退出状态和耗时，不记录参数值、prompt、token 或 stdout。
- 子进程的环境变量中去掉了 `LODY_CLI_TOKEN` 和 bridge 密钥；bridge 进程启动前入口脚本也会 `unset LODY_CLI_TOKEN`。
- 容器以非 root 的 `node` 用户运行，`cap_drop: ALL`、`no-new-privileges`，不发布主机端口；`~/.lody` 保存在命名卷 `lodyhome` 中。

## 配置

| 变量                         | 设置在      | 说明                                                           |
| ---------------------------- | ----------- | -------------------------------------------------------------- |
| `LODY_CLI_TOKEN`             | lody-bridge | Lody CLI Token，入口脚本用它执行 `lody daemon start --auth`    |
| `HARNESS_LODY_BRIDGE_SECRET` | 两个服务    | 共享 Bearer 密钥，至少 32 个字符，两边必须相同                 |
| `HARNESS_LODY_BRIDGE_URL`    | app         | `http://lody-bridge:43190`；留空时 harness 使用本地 `lody` CLI |
| `LODY_MACHINE_NAME`          | lody-bridge | 可选，注册到 Lody 的机器名，默认 `cos-tool-bot-server`         |
| `LODY_VERSION`               | 构建参数    | 可选，默认 `0.100.0`；升级前需复核白名单与 `--help`            |

harness.yaml 中 `executors.lody.bridge.urlEnv` / `secretEnv` 可以改成别的环境变量名；这两个字段只能通过 YAML 修改，Telegram 覆盖层不能改。

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
   - `lody-bridge` 容器健康检查为 healthy，日志中有 `lody-bridge: daemon started`；
   - 在 Lody 桌面端的机器列表中能看到 `cos-tool-bot-server`（不要把它加入 harness.yaml 的 `machines`，harness 不会往它派任务）；
   - 在 harness 群 General 话题中发 `/status`，执行层一行显示在线机器，并注明「经lody-bridge」。
6. 在项目话题中发一条 `/bug` 做端到端验证。

## 排查

- `/status` 显示「无法连接 lody-bridge」：检查 `HARNESS_LODY_BRIDGE_URL` 与 `harness` profile 是否启用。
- 显示「lody-bridge 拒绝了认证」：两个服务的 `HARNESS_LODY_BRIDGE_SECRET` 不一致。
- 显示 `Not logged in`：daemon 没有启动或 token 失效。可在容器中执行 `lody daemon status` 和 `lody daemon logs`；更换 token 后重新部署。
- 升级 `LODY_VERSION` 后，重新核对 `lody session create --help` 等输出与白名单是否一致。

## 本地验证记录（2026-09-25）

在 arm64 的 Docker 中构建 `lody-bridge` 阶段并以无 token 方式运行，确认：以 `node` 用户运行；`lody --version` 为 0.100.0；`/health` 返回版本；未认证请求返回 401；白名单外命令返回 400；通过 bridge 执行 `--version` 成功；未登录时 `machine list` 返回 Lody 的 `Not logged in` 错误；compose 中的健康检查命令通过。尚未使用真实 token 验证 daemon 登录与跨机器创建会话。
