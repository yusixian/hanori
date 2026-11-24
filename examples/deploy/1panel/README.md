# 在 1Panel 部署 Hanori

此模板使用 GHCR 预构建镜像。OpenResty 通过宿主机回环地址访问 `app`，数据库、备份和渲染服务均未发布宿主机端口。

1. 将本目录的 `docker-compose.yml` 放到服务器的部署目录。从[环境模板](../../../.env.selfhost.example)准备同目录下的 `.env`，设置文件权限为 `0600`。如镜像受访问控制，先为部署服务器配置镜像仓库认证。
2. 填写 `AUTH_OWNER_EMAIL` 和公开 HTTPS origin `BETTER_AUTH_URL`。使用 `openssl rand -hex 32` 分别生成 `DB_PASSWORD`、`BETTER_AUTH_SECRET`、`ENCRYPTION_KEY`、`MINI_APP_SESSION_SECRET` 和首次登录用的 `PANEL_PASSWORD`。将 `HANORI_IMAGE_TAG` 设为已发布的镜像标签，例如候选版 `v0.29.1-rc.1`。
3. 在 **容器 → 编排 → 创建编排** 选择从路径导入，填写部署目录中 Compose 文件的绝对路径，在同一项目中保留 `.env`。启动后确认 `db-backup` 退出码为 0、`quote-worker` 和 `app` 均健康。也可在该目录执行：

   ```sh
   docker compose up -d
   curl -fsS http://127.0.0.1:43100/api/health/ready
   ```

4. 安装使用宿主机网络的 OpenResty，在 **网站 → 创建网站 → 反向代理** 中填写公开域名与代理地址 `http://127.0.0.1:43100`，启用 HTTPS。若修改 `PORT`，同时修改代理地址，再验证公开入口：

   ```sh
   curl -fsS https://bot.example.com/api/health/ready
   ```

登录后修改初始密码并从 `.env` 删除 `PANEL_PASSWORD`。更新时沿用原项目和数据卷，保留 `DB_PASSWORD` 与 `ENCRYPTION_KEY`。[备份与升级](../../../packages/docs/content/docs/self-hosting/backup-upgrade.mdx)

[1Panel 创建网站文档](https://1panel-dev.github.io/docs/v2/user_manual/websites/website_create/#3)
