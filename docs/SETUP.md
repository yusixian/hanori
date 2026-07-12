# 配置与初始化指南

本文说明本地开发和生产部署所需的环境变量、Better Auth 首次初始化、Google 登录配置，以及从旧版 JWT 面板认证迁移的步骤。

## 1. 前置条件

- Node.js 20 或更高版本
- pnpm 10+
- PostgreSQL 17，并启用 pgvector
- 生产环境建议使用随机生成的加密密钥，不要使用示例值

## 2. 最小配置

复制环境变量模板：

```bash
cp .env.example .env
```

至少填写：

```env
DATABASE_URL=postgresql://bot:password@localhost:5432/cos_tool_bot
BETTER_AUTH_SECRET=使用密码管理器生成的至少32位随机字符串
BETTER_AUTH_URL=http://localhost:3000
AUTH_OWNER_EMAIL=owner@example.com
PANEL_PASSWORD=首次登录使用的初始密码
ENCRYPTION_KEY=用于加密 Bot Token 的随机密钥
```

可以使用以下命令生成密钥：

```bash
openssl rand -base64 32
```

然后启动：

```bash
pnpm dev
```

服务启动时会自动执行数据库迁移，并完成以下初始化：

1. 创建 Better Auth 的用户、账户、session、organization 和邀请表。
2. 使用 `AUTH_OWNER_EMAIL` 创建第一个 `owner`。
3. 使用 `PANEL_PASSWORD` 创建第一个邮箱密码账户。
4. 创建固定的 `cos-tool-bot` organization。

首次成功启动并确认可以登录后，可以从 `.env` 删除 `PANEL_PASSWORD`。以后用户通过面板中的 Settings 修改密码；owner 可以生成其他成员的一次性密码重置链接。

## 3. 环境变量说明

### 数据库和服务

| 变量           | 必填           | 说明                                                                |
| -------------- | -------------- | ------------------------------------------------------------------- |
| `DATABASE_URL` | 是（直接运行） | PostgreSQL 连接字符串。Docker Compose 中由 `DB_PASSWORD` 自动拼接。 |
| `DB_PASSWORD`  | Docker 必填    | PostgreSQL 容器密码。                                               |
| `PORT`         | 否             | 服务监听端口，默认 `3000`；Docker 中也是宿主机映射端口。            |
| `BACKUP_DIR`   | 否             | 本地备份目录，默认 `./backups`；Docker 中使用 `/data/backups`。     |

### Better Auth

| 变量                   | 必填       | 说明                                                                                                          |
| ---------------------- | ---------- | ------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`   | 是         | Better Auth 加密和 session 密钥，至少 32 位随机字符串。                                                       |
| `BETTER_AUTH_URL`      | 生产必填   | 面板对外访问的完整 origin，例如 `https://bot.example.com`。开发环境未设置时默认使用 `http://localhost:3000`。 |
| `AUTH_OWNER_EMAIL`     | 是         | 第一个 owner 的邮箱；每次启动都需要保留。                                                                     |
| `PANEL_PASSWORD`       | 仅首次启动 | 旧版面板密码，同时作为迁移时第一个 owner 的初始密码。创建密码账户后即可删除。                                 |
| `GOOGLE_CLIENT_ID`     | 否         | Google OAuth Client ID。只有和 `GOOGLE_CLIENT_SECRET` 同时配置时才启用 Google 登录。                          |
| `GOOGLE_CLIENT_SECRET` | 否         | Google OAuth Client Secret。                                                                                  |

#### 从零配置 Google 登录

Google 登录是可选功能。不需要 Google 登录时，这两个变量都留空即可；只配置其中一个不会启用 Google 登录。

开始前，先确定面板的访问地址：

- 本地开发通常是 `http://localhost:3000`
- 生产环境例如 `https://bot.example.com`
- `BETTER_AUTH_URL` 只填写 origin，不要带末尾 `/`，也不要附加 `/api/auth/...`

下面以当前 Google Cloud Console 的常见界面为例。Google 偶尔会调整菜单名称，但需要完成的内容不变。

1. 打开 [Google Cloud Console](https://console.cloud.google.com/)，使用 Google 账号登录。
2. 点击页面顶部的项目选择器，再点击“新建项目”。填写任意项目名称，例如 `cos-tool-bot`，创建后切换到这个项目。
3. 打开“Google Auth Platform”。如果看到“开始使用”按钮，点击它并填写：
   - 应用名称：用户登录时看到的名字，例如 `COS Tool Bot`
   - 用户支持电子邮件：选择你自己的邮箱
   - 受众：个人 Gmail 账号需要选择“外部”；只有 Google Workspace 组织内部使用时才选择“内部”
   - 联系信息：填写用于接收 Google 通知的邮箱
4. 在“品牌”页面按需填写应用主页、隐私政策和服务条款。仅供自己或少量测试账号使用时，可以先填写必填项；正式对外提供服务时，应填写真实的公开页面。
5. 在“受众”页面确认发布状态：
   - 测试阶段：把允许登录的 Google 邮箱添加为“测试用户”。未列入的账号无法登录。
   - 正式使用：点击“发布应用”。本项目只请求基础登录资料时通常不需要敏感权限验证，但最终以 Google Console 的提示为准。
6. 打开“客户端”页面，点击“创建客户端”，应用类型选择“Web 应用”，名称可填写 `cos-tool-bot-web`。
7. 在“已获授权的 JavaScript 来源”中添加面板 origin。这里不能包含路径：

   ```text
   http://localhost:3000
   https://bot.example.com
   ```

8. 在“已获授权的重定向 URI”中添加完整回调地址。格式固定为：

   ```text
   ${BETTER_AUTH_URL}/api/auth/callback/google
   ```

   本地和生产都需要使用时，可以同时添加：

   ```text
   http://localhost:3000/api/auth/callback/google
   https://bot.example.com/api/auth/callback/google
   ```

   注意：URI 必须逐字一致，包括 `http`/`https`、域名、端口和路径；末尾不要再加 `/`。`localhost` 和 `127.0.0.1` 也会被视为不同地址。

9. 点击“创建”。弹窗中会显示“客户端 ID”和“客户端密钥”：
   - 客户端 ID 填入 `GOOGLE_CLIENT_ID`
   - 客户端密钥填入 `GOOGLE_CLIENT_SECRET`

在本地项目的 `.env` 中添加：

```env
BETTER_AUTH_URL=http://localhost:3000
GOOGLE_CLIENT_ID=这里粘贴客户端ID
GOOGLE_CLIENT_SECRET=这里粘贴客户端密钥
```

生产部署则使用真实域名：

```env
BETTER_AUTH_URL=https://bot.example.com
GOOGLE_CLIENT_ID=这里粘贴客户端ID
GOOGLE_CLIENT_SECRET=这里粘贴客户端密钥
```

保存环境变量后必须重启服务：本地开发重新运行 `pnpm dev`，Docker 部署重新运行 `docker compose up -d`。打开登录页，出现“使用 Google 登录”按钮后即可测试。

客户端 ID 可以出现在浏览器请求中，不属于密码；客户端密钥必须保密，不要提交到 Git、粘贴到前端代码或发到公开聊天中。如果密钥泄露，请在 Google Cloud Console 中重置密钥，并立即更新部署环境。

新用户必须先获得工作区邀请，并使用邀请指定的同一个邮箱完成 Google 登录。Google Console 的“测试用户”和本项目的“工作区邀请”是两层独立限制，两边都满足才能进入工作区。

### Bot 和加密

| 变量             | 必填               | 说明                                                                                                               |
| ---------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `ENCRYPTION_KEY` | 否，但生产建议设置 | 加密 Bot Token、API Key 等敏感配置。未设置时使用内置默认值，仅适合开发环境。已有数据更换此值会导致旧密文无法解密。 |
| `BOT_TOKEN`      | 否                 | 首次迁移到数据库的 Telegram Bot Token。迁移完成后可删除。                                                          |
| `ADMIN_CHAT_IDS` | 否                 | JSON 数组，例如 `[123456789]`；首次迁移时写入 Bot 配置。                                                           |
| `NSFW_API_URL`   | 否                 | 外部 NSFW 检测服务地址；不设置则不启用。                                                                           |

### Embedding

| 变量                   | 必填 | 说明                                                                                                        |
| ---------------------- | ---- | ----------------------------------------------------------------------------------------------------------- |
| `EMBEDDING_DIMENSIONS` | 否   | embedding 维度，默认 `3072`。必须与数据库中的 vector/halfvec 列一致；部署后修改需要重新生成迁移并重新索引。 |

日志保留时间还可以通过 `LOG_RETENTION_DAYS`、`LOG_RETENTION_DAYS_ERROR` 和 `LOG_CLEANUP_INTERVAL_HOURS` 调整。生成图片和摘要清理时间分别由 `GENERATION_RETENTION_DAYS` 等服务配置控制，通常保持默认值即可。

备份的本地路径、WebDAV、S3 等远端存储配置当前在管理面板的 Backup 页面中保存，不需要额外设置一组启动环境变量。

## 4. Docker Compose 部署

准备 `.env` 后执行：

```bash
docker compose up -d --build
```

生产环境至少确认以下变量存在：

```env
DB_PASSWORD=一个强密码
BETTER_AUTH_SECRET=至少32位随机字符串
BETTER_AUTH_URL=https://bot.example.com
AUTH_OWNER_EMAIL=owner@example.com
PANEL_PASSWORD=首次迁移时的初始密码
ENCRYPTION_KEY=一个稳定的随机密钥
PORT=9600
```

`BETTER_AUTH_URL` 必须是用户实际访问面板的地址，而不是容器内的 `http://localhost:3000`。Google OAuth 和安全 cookie 都依赖这个值。

## 5. 从旧版 JWT 认证迁移

旧版使用 `JWT_SECRET + PANEL_PASSWORD`，新版使用 Better Auth cookie session。迁移步骤：

1. 保留原来的 `PANEL_PASSWORD`。
2. 新增 `BETTER_AUTH_SECRET`、`BETTER_AUTH_URL` 和 `AUTH_OWNER_EMAIL`。
3. 启动新版服务，等待数据库迁移和 owner bootstrap 完成。
4. 用 `AUTH_OWNER_EMAIL + PANEL_PASSWORD` 登录。
5. 在 Settings 中修改密码。
6. 确认新登录正常后删除 `PANEL_PASSWORD`；旧 JWT token 会自然失效。

业务数据（Bot、日志、对话、备份配置等）不会因为认证迁移被删除。

## 6. 常见问题

### 启动时报 `Missing required env`

检查 `DATABASE_URL`、`BETTER_AUTH_SECRET` 和 `AUTH_OWNER_EMAIL` 是否已设置。生产环境还必须设置 `BETTER_AUTH_URL`。

### 启动时报 `PANEL_PASSWORD is missing`

说明数据库中还没有该 owner 的邮箱密码账户。暂时恢复 `PANEL_PASSWORD`，启动成功一次后再删除。

### Google 登录回调失败

检查：

- `BETTER_AUTH_URL` 是否是实际公开地址
- Google Console 中的回调地址是否完全一致
- `GOOGLE_CLIENT_ID` 和 `GOOGLE_CLIENT_SECRET` 是否同时存在
- 访问地址是否与 `BETTER_AUTH_URL` 使用相同的域名和协议

### 用户登录成功但无法进入面板

该账号通常还没有接受 organization 邀请。请由 owner/admin 生成新的邀请链接，并确认注册或 Google 登录使用的邮箱与邀请邮箱一致。
