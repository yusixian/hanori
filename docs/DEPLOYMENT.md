# Docker 部署指南

这份指南面向第一次接触服务器和 Docker 的用户。命令默认在 Linux 服务器上执行，生产环境的 Compose 项目名统一使用 `cos-bot-prod`。

> 永远不要执行 `docker compose down -v`。其中的 `-v` 会删除数据库存储卷。

## 一、首次部署

### 1. 准备服务器

建议使用 Ubuntu 或 Debian，并提前安装：

- Git
- Docker Engine
- Docker Compose 插件
- OpenSSL

用下面的命令确认它们可用：

```bash
git --version
docker --version
docker compose version
openssl version
```

如果命令不存在，请先按照 [Docker 官方安装文档](https://docs.docker.com/engine/install/) 安装 Docker Engine 和 Compose 插件。云服务器还需要在防火墙或安全组中放行面板端口，默认使用 `9600`。

### 2. 下载项目

```bash
mkdir -p ~/code
cd ~/code
git clone https://github.com/example-owner/cos-tool-bot.git
cd cos-tool-bot
```

以后所有部署命令都在 `~/code/cos-tool-bot` 中执行。

### 3. 创建环境变量

先复制模板：

```bash
cp .env.example .env
chmod 600 .env
```

生成数据库密码、登录密钥、数据加密密钥和首次登录密码：

```bash
printf 'DB_PASSWORD=%s\n' "$(openssl rand -hex 32)"
printf 'BETTER_AUTH_SECRET=%s\n' "$(openssl rand -hex 32)"
printf 'ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)"
printf 'PANEL_PASSWORD=%s\n' "$(openssl rand -hex 16)"
```

把输出暂时保存在安全的地方，下一步需要填入 `.env`。

使用 `nano .env` 编辑文件：

```bash
nano .env
```

至少检查并修改这些内容：

```env
# PostgreSQL 密码：填写刚才生成的 DB_PASSWORD，部署后不要修改
DB_PASSWORD=生成的DB_PASSWORD

# 面板映射到服务器的端口
PORT=9600

# 登录配置
BETTER_AUTH_SECRET=生成的BETTER_AUTH_SECRET
BETTER_AUTH_URL=http://服务器公网IP:9600
AUTH_OWNER_EMAIL=你的登录邮箱
PANEL_PASSWORD=生成的PANEL_PASSWORD

# 敏感配置加密密钥：部署后不要修改
ENCRYPTION_KEY=生成的ENCRYPTION_KEY

# Docker 内部的 NSFW 服务地址
NSFW_API_URL=http://nsfw-api:3000

# 暂时不用的配置可以保持为空
BOT_TOKEN=
ADMIN_CHAT_IDS=[]
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

注意：

- 四个生成值要填写到对应的同名配置中，不要互换。
- 已经保存数据后，不要修改 `DB_PASSWORD` 或 `ENCRYPTION_KEY`。
- `http://服务器公网IP:9600` 只适合临时测试，并且要把“服务器公网 IP”替换成真实 IP。长期使用应配置域名和 HTTPS，把 `BETTER_AUTH_URL` 改为真实地址，例如 `https://bot.example.com`，不能带结尾 `/`。
- `.env` 包含密码，不能发到群聊、不能提交到 Git。

在 nano 中按 `Ctrl+O`、回车保存，再按 `Ctrl+X` 退出。

### 4. 启动服务

```bash
docker compose -p cos-bot-prod up -d --build
```

第一次构建通常需要几分钟。完成后检查：

```bash
docker compose -p cos-bot-prod ps
docker compose -p cos-bot-prod logs --tail=200 app
curl -fsS http://127.0.0.1:9600/api/health && echo
```

正常情况：

- `app` 和 `db` 显示 `healthy`。
- 日志出现 `Database migrated`、`Authentication initialized` 和 `Server running`。
- 健康检查返回 `{"ok":true}`。

如果 `nsfw-api` 暂时显示 `unhealthy`，但 `app`、`db` 和健康检查正常，不会影响这次应用和数据库部署。

### 5. 首次登录

浏览器打开 `BETTER_AUTH_URL`，使用下面的信息登录：

- 邮箱：`AUTH_OWNER_EMAIL`
- 密码：`PANEL_PASSWORD`

登录后先在 Settings 中修改密码。确认新密码可以登录后，可以删除 `.env` 中的 `PANEL_PASSWORD`，然后执行：

```bash
./scripts/update-production.sh --force
```

Bot Token 可以在管理面板中添加，不必写入 `.env`。

## 二、后续一键更新

服务器必须位于 `main` 分支，并且仓库中不能有手工修改或未提交文件。第一次获得更新脚本时，执行：

```bash
cd ~/code/cos-tool-bot
git pull --ff-only origin main
./scripts/update-production.sh
```

以后每次更新只需要：

```bash
cd ~/code/cos-tool-bot
./scripts/update-production.sh
```

脚本会自动完成：

1. 检查 Git、Docker、分支和工作区。
2. 获取 `origin/main` 的最新代码。
3. 用 `pg_dump` 备份数据库，并用 `pg_restore` 验证备份。
4. 快进更新本地 `main`。
5. 构建新的 app 镜像。
6. 启动 app，由应用自动执行数据库迁移。
7. 等待健康检查，并显示最终状态。

脚本会记住最后一次通过健康检查的 commit。没有新代码且上次部署成功时，它不会重复部署；如果构建或启动中途失败，修好问题后直接再次执行同一个命令即可继续。

如果修改了 `.env`，希望重新创建 app 容器，可以执行：

```bash
./scripts/update-production.sh --force
```

数据库备份默认保存在：

```text
~/cos-tool-bot-backups/
```

查看已有备份：

```bash
ls -lh ~/cos-tool-bot-backups/
```

确认新版本稳定后，可以手动删除很久以前的备份，但建议至少保留最近三份。

## 三、常用检查和排障命令

查看容器：

```bash
docker compose -p cos-bot-prod ps
```

持续查看应用日志，按 `Ctrl+C` 退出：

```bash
docker compose -p cos-bot-prod logs --tail=200 -f app
```

检查接口：

```bash
curl -fsS http://127.0.0.1:9600/api/health && echo
```

重启 app，不动数据库：

```bash
docker compose -p cos-bot-prod restart app
```

如果更新失败，不要删除容器和 volume。先保存下面两条命令的输出：

```bash
docker compose -p cos-bot-prod ps
docker compose -p cos-bot-prod logs --tail=300 app
```

然后根据日志排查，或把输出交给维护者。数据库备份位于 `~/cos-tool-bot-backups/`。

更完整的环境变量、Google 登录和旧认证迁移说明见 [配置与初始化指南](SETUP.md)。
