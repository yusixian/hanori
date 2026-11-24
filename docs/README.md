# Hanori 文档索引

## 对外自托管与集成指南

公开文档由 Hanori 在 `/docs/` 提供。以下链接指向相应的源码页面。

- 部署与环境变量见[自托管总览](../packages/docs/content/docs/self-hosting/index.mdx)、[Docker 部署](../packages/docs/content/docs/self-hosting/docker.mdx)和[配置说明](../packages/docs/content/docs/self-hosting/configuration.mdx)。
- 部署拓扑和 worker 隔离边界见[系统架构](../packages/docs/content/docs/self-hosting/architecture.mdx)。启动、密钥和网络问题见[自托管排障 FAQ](../packages/docs/content/docs/self-hosting/troubleshooting.mdx)。
- 配置 HTTPS、回调和 Mini App 域名时，查看 [HTTPS 反向代理](../packages/docs/content/docs/self-hosting/reverse-proxy.mdx)、[Caddy 与 Nginx 模板](../examples/reverse-proxy/)和 [Telegram Mini App](../packages/docs/content/docs/guides/mini-app.mdx)。
- 准备升级或恢复时，查看[备份与升级](../packages/docs/content/docs/self-hosting/backup-upgrade.mdx)和[版本发布说明](releases/)。
- 外部服务与扩展的配置见 [GitHub 与 Pi](../packages/docs/content/docs/integrations/github-pi.mdx)、[MCP](../packages/docs/content/docs/integrations/mcp.mdx)、[Telegram 链接读取](../packages/docs/content/docs/integrations/telegram-reader.mdx)和[插件开发](../packages/docs/content/docs/integrations/plugin-development.mdx)。

## 贡献者维护手册

- [配置与初始化](SETUP.md)、[部署运维](DEPLOYMENT.md)和 [Dokploy 运维](DOKPLOY_DEPLOYMENT.md)记录仓库维护流程。
- [Telegram Mini App 运维](TELEGRAM_MINI_APP.md)和 [Mini App 本地开发](TELEGRAM_MINI_APP_LOCAL_DEV.md)涵盖接入、测试及权限验收。
- [GitHub App 配置](GITHUB_APP.md)、[GitHub 访问权限](GITHUB_ACCESS.md)、[Pi 编码 worker](PI_CODING_AGENT.md)和 [Lody 开发集成](DEV_HARNESS_LODY.md)记录相关集成的维护细节。
- [公开文档站维护](PUBLIC_DOCUMENTATION.md)、[AI 日志](AI_LOGGING.md)和[生成资产库维护](GENERATION_LIBRARY.md)提供对应模块的工作说明。

## 内部历史审计 / 设计调研文档

- [设计记录](design/)包含开源准备审计、可靠性、插件市场、Mini App 权限和开发工具的设计与过程记录。
- 面板 UI 审计按页面查阅。[账号区域](UI_ACCOUNT_FOOTER_AUDIT.md)、[AI 设置](UI_AI_SETTINGS_AUDIT.md)、[Bot 管理](UI_BOT_MANAGEMENT_AUDIT.md)、[Bot 搜索](UI_BOT_SEARCH_AUDIT.md)、[会话](UI_CONVERSATIONS_AUDIT.md)、[生成列表](UI_GENERATIONS_AUDIT.md)、[记录管理](UI_RECORD_MANAGEMENT_AUDIT.md)、[用量](UI_USAGE_AUDIT.md)、[用量模型](UI_USAGE_MODEL_AUDIT.md)、[日志 Bot 选项](UI_LOG_BOT_OPTIONS_AUDIT.md)、[日志 Bot 搜索](UI_LOG_BOT_SEARCH_AUDIT.md)、[移动端日志行](UI_LOG_ROW_MOBILE_AUDIT.md)。
- [记忆系统调研](memory-systems-analysis.md)、[Memoh 架构分析](memoh-architecture-analysis.md)和[记忆演进目标](MEMORY_EVOLUTION_GOAL.md)记录记忆能力的背景与取舍。
- [JEV 互动设计](JEV_ENGAGEMENT.md)、[后续方案](JEV_INTERACTION_NEXT_STEPS.md)、[问题记录](JEV_ISSUE66_NOTES.md)和[调优交付](JEV_TUNING_DELIVERY.md)记录相关迭代。
