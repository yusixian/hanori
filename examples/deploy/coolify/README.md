# 在 Coolify 部署 Hanori

此模板使用 GHCR 预构建镜像与 Coolify 的 Traefik 代理，包含应用、PostgreSQL、启动前备份和离线语录渲染。

1. 在 Coolify 创建基于 Git 的 **Docker Compose Application**，选取包含本模板的 Hanori 分支或标签。Base Directory 使用仓库根目录，Compose 路径填写 `/examples/deploy/coolify/docker-compose.yml`。如镜像受访问控制，先为部署服务器配置镜像仓库认证。
2. 在 **Advanced → Docker compose → Compose deployment** 选择 **Raw (deploy file as-is)**。保持 **Connect to predefined network** 关闭。模板仅将 `app` 接入代理网络，并通过 Traefik 标签配置域名。
3. 在应用的环境变量中填写以下值：
   - `HANORI_DOMAIN` 写域名（如 `bot.example.com`），`BETTER_AUTH_URL` 写对应的完整 HTTPS origin（如 `https://bot.example.com`）。
   - `HANORI_ROUTE_NAME` 写当前 Traefik 中唯一的名称（如 `hanori-home`）。
   - `COOLIFY_PROXY_NETWORK` 默认是 `coolify`。如已调整代理网络，填 Traefik 实际连接的外部 Docker 网络。
   - `AUTH_OWNER_EMAIL` 写 owner 邮箱。使用 `openssl rand -hex 32` 分别生成 `DB_PASSWORD`、`BETTER_AUTH_SECRET`、`ENCRYPTION_KEY`、`MINI_APP_SESSION_SECRET` 和首次登录用的 `PANEL_PASSWORD`，保存到平台的私密环境变量中。
   - 将 `HANORI_IMAGE_TAG` 设为已发布的镜像标签，例如 `v0.29.1`。
4. 将域名 DNS 指向运行 Traefik 的服务器，确保其默认 `https` 入口和 `letsencrypt` 证书解析器可用。保存配置并部署，确认 `db-backup` 退出码为 0、`quote-worker` 和 `app` 均健康，再验证：

   ```sh
   curl -fsS https://bot.example.com/api/health/ready
   ```

登录后修改初始密码并从部署配置中删除 `PANEL_PASSWORD`。更新时沿用原项目和数据卷，保留 `DB_PASSWORD` 与 `ENCRYPTION_KEY`。[备份与升级](../../../packages/docs/content/docs/self-hosting/backup-upgrade.mdx)

[Coolify Compose 文档](https://coolify.io/docs/applications/builds/docker-compose#raw-compose-deployment-for-an-application)
