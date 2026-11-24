# Hanori HTTPS 反向代理模板

任选一份模板，将 `bot.example.com` 替换为自己的域名，并将 DNS 指向代理。模板假设代理直接接收公网流量，且与 Hanori 的宿主机端口位于同一台机器。应用应只在 `127.0.0.1:43100` 接受代理连接。Docker Compose 的端口绑定示例见[反向代理指南](../../packages/docs/content/docs/self-hosting/reverse-proxy.mdx)。

- [Caddyfile](Caddyfile) 由 Caddy 自动申请和续期证书，并将 HTTP 重定向至 HTTPS。放行 TCP 80 和 443，将站点块加入生效的 Caddyfile，并运行 `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`。校验通过后启动或重载 Caddy。
- [nginx.conf](nginx.conf) 是 `http {}` 作用域内的配置片段。将其加入已被主配置加载的站点目录（例如 `/etc/nginx/conf.d/hanori.conf`），替换证书链和私钥路径。先取得证书，配置自动续期与续期后的重载，再运行 `nginx -t`。校验通过后启动或重载 Nginx。

在 Hanori 环境变量中设置 `BETTER_AUTH_URL=https://bot.example.com`，只填写公开 origin。修改后重新创建 app 容器或重启源码进程，再验证：

```bash
curl -fsS http://127.0.0.1:43100/api/health/ready
curl -fsS https://bot.example.com/api/health/ready
```

两个请求都应返回 HTTP 200，以及 `ok: true`、`status: "ready"` 和相同的预期版本。通过公开域名登录面板。启用 OAuth 时还需验证实际回调，启用 Mini App 时从 Telegram 内打开受保护页面。
