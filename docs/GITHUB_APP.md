# GitHub App 配置指南

这份文档面向第一次配置 GitHub App 的管理员。配置完成后，管理面板中的 `owner` 和 `admin` 可以为每个 Bot 连接 GitHub，并在 GitHub 页面选择允许访问的仓库。`editor` 和 `viewer` 看不到授权入口，也不能调用授权接口。

项目使用的是 **GitHub App 安装授权**，不是让管理员粘贴长期 PAT。GitHub App 能限定仓库和权限，并使用短期凭据，适合让 Bot 执行 GitHub 与编码任务。GitHub 官方也[建议优先使用 GitHub App](https://docs.github.com/en/apps/overview)。

这里采用两阶段流程：GitHub 安装完成后先返回 Setup URL，让服务端可靠取得并绑定 `installation_id`；服务端验证安装状态后，再显式发起 OAuth user authorization。不要使用 GitHub 提供的“安装时直接 OAuth”快捷选项，否则 Setup URL 不会被调用，服务端无法在多 installation 场景中可靠确定这次选择的 installation。

## 一、准备公开地址

先确认生产环境的 `BETTER_AUTH_URL` 是管理面板真实的公开 HTTPS 地址，例如：

```env
BETTER_AUTH_URL=https://bot.example.com
```

地址不能带结尾 `/`。后面的示例都假设它是 `https://bot.example.com`。如果域名、协议或端口不同，请把示例替换成你的真实地址。

GitHub 必须能把浏览器重定向回这个地址；`localhost` 和服务器内网地址只适合本机开发，不适合生产环境。

## 二、创建 GitHub App

1. 登录 GitHub。
2. 点击右上角头像，进入 **Settings**。
3. 在左侧进入 **Developer settings** → **GitHub Apps**。
4. 点击 **New GitHub App**。

如果 GitHub App 由组织统一管理，也可以在组织的 **Settings** → **Developer settings** 中创建。GitHub 的完整字段说明见[注册 GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app)。

### 1. 基本信息和地址

按下面填写：

| GitHub 字段                                            | 应填写的内容                                              |
| ------------------------------------------------------ | --------------------------------------------------------- |
| GitHub App name                                        | 自己能识别的唯一名称，例如 `cos-tool-bot-production`      |
| Homepage URL                                           | `https://bot.example.com`，也就是完整的 `BETTER_AUTH_URL` |
| Callback URL                                           | `https://bot.example.com/api/github-app/callback`         |
| Request user authorization (OAuth) during installation | **不要勾选，保持关闭**                                    |
| Setup URL                                              | `https://bot.example.com/api/github-app/setup`            |
| Redirect on update                                     | 可以不勾选；仓库范围变化后在管理面板重新连接即可          |
| Webhook / Active                                       | 取消勾选；当前版本不使用 GitHub Webhook                   |

Setup URL 和 Callback URL 必须分别与下面两个地址完全一致，协议、域名、端口和路径都不能少：

```text
${BETTER_AUTH_URL}/api/github-app/setup
${BETTER_AUTH_URL}/api/github-app/callback
```

GitHub 官方说明，Setup URL 用于安装完成后的跳转；如果启用安装时 OAuth，就无法填写 Setup URL。这个项目需要 Setup URL，因此必须关闭 **Request user authorization (OAuth) during installation**。[查看 GitHub Setup URL 说明](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration#adding-or-updating-a-setup-url)

Setup 回调收到 GitHub 提供的 `installation_id` 和签名状态后，服务端才会显式启动 OAuth web application flow，并把用户带回 Callback URL。GitHub 官方要求显式 OAuth 流程的 `redirect_uri` 与 App 设置中的 Callback URL 匹配，并建议使用 `state` 防止伪造请求。[查看 user access token web application flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#using-the-web-application-flow-to-generate-a-user-access-token)

### 2. 仓库权限

在 **Repository permissions** 中配置：

| 权限          | 级别                 | 用途                                          |
| ------------- | -------------------- | --------------------------------------------- |
| Contents      | Read and write       | clone、读取文件、commit 和 push               |
| Issues        | Read and write       | 查看、创建和更新 Issue                        |
| Pull requests | Read and write       | 查看、创建和更新 PR                           |
| Metadata      | Read-only            | GitHub 自动提供的基础仓库信息权限             |
| Workflows     | Read and write，可选 | 只有允许 AI 修改 `.github/workflows` 时才开启 |

其他 Repository、Organization 和 Account 权限保持 **No access**。权限应尽量少；GitHub 官方确认 HTTP Git 操作需要 Contents 权限，而修改 Actions workflow 文件还需要额外的 Workflows 权限。[查看 GitHub App 权限说明](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)

### 3. 可安装范围

- 只在创建 App 的个人账号或组织中使用：选择 **Only on this account**，范围最小。
- 还要安装到其他 GitHub 组织：选择 **Any account**。组织可能要求组织 owner 审批安装。

检查完毕后点击 **Create GitHub App**。

## 三、取得五个环境变量

创建完成后会进入 GitHub App 的 **General** 页面。项目要求五个变量全部填写；少任何一个都会拒绝部署。

### `GITHUB_APP_ID`

在 General 页顶部找到 **App ID**，复制数字。例如页面显示 `123456` 时，只复制数字本身。

### `GITHUB_APP_CLIENT_ID`

在同一页找到 **Client ID**。它通常以 `Iv` 开头。Client ID 与 App ID 不是同一个值，不能互换。

### `GITHUB_APP_CLIENT_SECRET`

在 **Client secrets** 区域点击 **Generate a new client secret**，立即复制生成的值并安全保存。不要把它发到聊天、截图或提交到 Git。

### `GITHUB_APP_SLUG`

查看页面上的 **Public link**，格式类似：

```text
https://github.com/apps/cos-tool-bot-production
```

最后一段 `cos-tool-bot-production` 就是 slug。这里只填写 slug，不要填写完整 URL。

### `GITHUB_APP_PRIVATE_KEY`

在 **Private keys** 区域点击 **Generate a private key**。GitHub 会下载一个 `.pem` 文件。这个文件相当于 App 的最高权限凭据，不能上传到仓库、网盘或聊天。

`.env` 的一个变量必须只占一行，因此不能直接粘贴多行 PEM。请先把下载的文件通过安全方式传到服务器，然后在服务器执行下面的命令。这个命令不会把私钥打印到终端或写入 shell history；它会把换行转换为字面量 `\n`，原子更新 `.env`，并把权限设为 `600`。

例如，在自己的电脑上执行下面的命令，把路径、SSH 用户名和服务器地址替换成真实值：

```bash
scp ~/Downloads/你的App.private-key.pem 服务器用户@服务器地址:~/github-app.private-key.pem
```

然后 SSH 登录服务器，再继续下面的操作。

先把示例文件名替换为真实路径：

```bash
cd ~/code/cos-tool-bot
chmod 600 "$HOME/github-app.private-key.pem"
PRIVATE_KEY_FILE="$HOME/github-app.private-key.pem" python3 - <<'PY'
import os
from pathlib import Path

env_path = Path(".env")
pem_path = Path(os.environ["PRIVATE_KEY_FILE"])
pem = pem_path.read_text(encoding="utf-8").replace("\r\n", "\n").replace("\r", "\n")
if "-----BEGIN " not in pem or " PRIVATE KEY-----" not in pem or "-----END " not in pem:
    raise SystemExit("这不是有效的 PEM 私钥文件")
if not pem.endswith("\n"):
    pem += "\n"

key = "GITHUB_APP_PRIVATE_KEY"
single_line_pem = pem.replace("\n", r"\n")
replacement = f"{key}={single_line_pem}"
lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []
result = []
replaced = False
for line in lines:
    if line.startswith(f"{key}="):
        if not replaced:
            result.append(replacement)
            replaced = True
    else:
        result.append(line)
if not replaced:
    result.append(replacement)

temporary = env_path.with_name(f".{env_path.name}.github-app.tmp")
temporary.write_text("\n".join(result).rstrip("\n") + "\n", encoding="utf-8")
temporary.chmod(0o600)
temporary.replace(env_path)
env_path.chmod(0o600)
PY
```

确认命令成功后，删除服务器上的原始 PEM 文件：

```bash
rm -f "$HOME/github-app.private-key.pem"
```

不要使用 `cat` 检查私钥，也不要把 `.env` 内容贴到终端输出中。

## 四、填写并部署

使用 `nano .env` 填写另外四项；私钥使用上一节的命令写入：

```env
GITHUB_APP_ID=填写App ID
GITHUB_APP_CLIENT_ID=填写Client ID
GITHUB_APP_CLIENT_SECRET=填写Client Secret
GITHUB_APP_SLUG=填写Public link最后一段
```

`GITHUB_APP_PRIVATE_KEY` 已由上面的安全命令单独写入，不要再用 nano 覆盖。文档中的文字只是占位说明，必须替换为 GitHub 页面上的真实值。五项必须全部填写，或者全部留空。全空时主应用仍能正常运行，但管理面板会提示 GitHub App 未配置，无法使用 GitHub 授权。

部署或重新创建容器：

```bash
./scripts/update-production.sh --force
```

脚本只检查五项是否完整，不会输出任何变量值。配置不完整时会在构建和启动前停止。

## 五、在管理面板连接仓库

1. 使用 `owner` 或 `admin` 登录管理面板。
2. 打开对应 Bot 的 **AI 设置**：`/bots/<botId>/ai`。
3. 在 **GitHub 工具**区域点击连接 GitHub。
4. GitHub 页面会要求选择安装到个人账号或组织。
5. 优先选择 **Only select repositories**，只勾选这个 Bot 真正需要操作的仓库；不要为了省事授权所有仓库。
6. 确认安装。GitHub 会先跳转到 `/api/github-app/setup`，服务端核对这次安装的 `installation_id`。
7. 服务端随后会把浏览器带到 GitHub OAuth user authorization 页面；确认授权后，GitHub 再跳转到 `/api/github-app/callback`。
8. Callback 验证当前管理员确实有权访问刚才的 installation，然后返回管理面板。

GitHub 会在安装页面显示 App 请求的权限和仓库范围。安装与授权是两个独立步骤：安装决定 App 能访问哪些仓库，后续 user authorization 用于确认当前管理员的 GitHub 身份和 installation 访问权。[查看 GitHub 的安装与授权说明](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-github-marketplace-for-your-organizations#difference-between-installation-and-authorization)

如果组织启用了第三方 App 审批，GitHub 可能先显示等待组织 owner 批准。这不是服务器故障，需要 GitHub 组织 owner 在组织设置中批准。

## 六、验证配置

授权成功后：

1. 回到同一个 Bot 的 GitHub 工具区域，确认显示 GitHub 账号、installation 和已授权仓库。
2. 先让 Bot 执行只读操作，例如读取仓库信息或列出 Issue。
3. 再测试一次需要管理员确认的写操作，例如创建测试分支或 PR。
4. 在 GitHub 仓库中确认操作主体、目标仓库和权限范围符合预期。

如果后来在 GitHub 中增删了 installation 的仓库，需要回到面板断开并重新连接一次，刷新本 Bot 保存的仓库快照。

服务器侧可以检查容器和日志，但不要输出 `.env`：

```bash
docker compose -p cos-bot-prod ps app
docker compose -p cos-bot-prod logs --tail=200 app
```

## 七、断开与彻底撤销

面板中的“断开 GitHub”只会清除当前 Bot 的本地绑定和临时 Token 缓存，不会直接卸载 GitHub App。这样可以避免多个 Bot 共用同一个 installation 时被误删。

需要彻底撤销时，在 GitHub 执行：

1. **Settings** → **Applications** → **Installed GitHub Apps**。
2. 找到这个 App，点击 **Configure**。
3. 可以缩小仓库范围；如果完全不用，点击 **Uninstall**。
4. 再进入 **Authorized GitHub Apps**，找到同一个 App 并点击 **Revoke**，撤销个人 user authorization。

卸载后，App 会立即失去对应账号和仓库的访问权。[查看 GitHub 的卸载说明](https://docs.github.com/en/apps/using-github-apps/reviewing-and-modifying-installed-github-apps)

如果 Client Secret 或 Private Key 可能泄露，应先在 GitHub App General 页生成新凭据，更新服务器 `.env` 并强制部署，确认新凭据工作后，再删除 GitHub 上的旧凭据。
