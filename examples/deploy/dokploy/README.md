# 在 Dokploy 部署 Hanori

创建 **Docker Compose** 资源，使用以下任一版本的 Compose：

- **从源码构建**：选择 Hanori Git 仓库与目标分支或标签，Compose 路径使用根目录的 [`docker-compose.yml`](../../../docker-compose.yml)。保持 Advanced Command 为默认的 `up -d --build --remove-orphans`。已有实例迁移按[迁移部署教程](../../../docs/DOKPLOY_DEPLOYMENT.md)执行。
- **使用预构建镜像**：取与目标镜像标签对应的 [`docker-compose.prebuilt.yml`](../../../docker-compose.prebuilt.yml)，删除 `app.ports`，保留 `app.expose` 和 `app.labels`，再粘贴到 Dokploy 的 Raw Compose 源。将 `HANORI_IMAGE_TAG` 设为已发布的镜像标签（例如 `v0.29.1`），私有镜像需配置仓库认证。[预构建镜像说明](../../../packages/docs/content/docs/self-hosting/docker.mdx#使用-ghcr-预构建镜像)

在环境变量页，参照[环境模板](../../../.env.selfhost.example)配置 owner 邮箱、HTTPS origin 和初始凭据。用 `openssl rand -hex 32` 分别生成 `DB_PASSWORD`、`BETTER_AUTH_SECRET`、`ENCRYPTION_KEY`、`MINI_APP_SESSION_SECRET` 和 `PANEL_PASSWORD`。升级时保留原项目、数据卷、数据库密码和加密密钥。

1. 在 **Advanced** 关闭 **Enable Isolated Deployment**，避免平台为断网 worker 自动注入网络。保持 Compose 中 `app.labels` 的列表语法。
2. 在 **Domains** 只为 `app` 绑定域名，容器端口填 `3000` 并启用 HTTPS。将 `TRAEFIK_DOCKER_NETWORK` 设为代理和 `app` 共享的实际网络名，默认 `dokploy-network`。
3. 在 **Preview Compose** 确认 `app` 保留 `default`、`harness-bridge` 并接入代理网络，`quote-worker` 和可选的 `media-worker` 仍使用 `network_mode: none`，可选的 `coding-worker` 仅连接 `coding-sandbox`。确认 `db` 没有宿主机端口，`app` 仍等待 `db-backup` 成功退出。
4. 部署后查看 `db-backup` 的日志并确认成功退出，再检查应用就绪状态：

   ```sh
   curl -fsS https://bot.example.com/api/health/ready
   ```

登录后修改初始密码并从部署配置中删除 `PANEL_PASSWORD`。[Dokploy Compose 域名文档](https://docs.dokploy.com/docs/core/docker-compose/domains)
