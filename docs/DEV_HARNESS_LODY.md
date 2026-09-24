# Dev Harness：在 server 容器中运行 Lody

状态：**未验证**。以下步骤依据 Lody CLI 0.100.0 的 `--help` 输出整理，尚未在 Linux 容器中实测（见 `docs/design/dev-harness-progress.md` 第 5 节）。

## 为什么需要

`/bug` 通过 `lody session create --machine <id>` 在 owner 的 Mac 上开会话。`session create` 要求调用方本机运行 Lody runtime，所以 server 容器需要：

1. 可执行的 `lody` CLI（`executors.lody.cli` 指向它，可写成 `[node, /path/to/cli/index.js]`）；
2. 已登录 workspace 的凭据；
3. 常驻的 `lody daemon`。

harness 只调用这些子命令：`machine list`、`session create|chat|show|status|cancel|archive`，均带 `--json`。prompt 通过 stdin（`--prompt-file -`）传入，不进入命令行参数。

## 步骤（待验证）

```bash
# 1. 在镜像中安装 Lody CLI（安装方式与包名待确认；桌面版自带的 CLI 位于
#    Lody.app/Contents/Resources/app.asar.unpacked/resources/cli/index.js）

# 2. 用 CLI API key 或机器连接 token 登录，并给这台机器起一个可识别的名字
lody login --auth "$LODY_CLI_TOKEN" --machine-name cos-tool-bot-server

# 3. 后台启动 daemon（容器入口脚本中执行，先于 server）
lody daemon start --auth "$LODY_CLI_TOKEN" --machine-name cos-tool-bot-server
lody daemon status
```

- `LODY_CLI_TOKEN` 能在 owner 的机器上启动 agent，属于最高敏感级别：只放在部署平台的 secret 中，不写入 `.env.example`、日志或 harness.yaml。
- Lody 的登录状态保存在容器用户的 home 目录（默认 `~/.lody`），需要挂载持久卷，否则每次重启都要重新登录。
- 这台 server 机器本身不在 `machines` 中列出，harness 不会把任务派给它。

## 待确认

- Linux 容器（node:22-alpine）中 daemon 的依赖、内存与 CPU 占用；
- daemon 掉线后 `session create` 的错误输出，以及是否需要健康检查重启；
- `session create --json` 的输出结构（harness 目前兼容 `session.id`、`sessionId` 与 `id` 三种位置）；
- 会话分享链接的格式；确认后填入 `executors.lody.sessionUrl`。
