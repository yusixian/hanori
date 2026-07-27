# G7：生产硬化与单 Bot 灰度

## 纵向、可演示的结果

默认关闭 Mini App 部署后，现有 Bot/Panel 无行为变化；只为测试 Bot 开启后，Telegram iOS、Android、Desktop、Web 都能完成登录、角色访问、配置变更、权限撤销和生命周期操作，并能按文档关闭入口和回滚。

## 前置

- G3、G4、G5、G6 全部完成阶段 Review。
- 有可用 HTTPS 测试域名、测试 Bot 和测试群。
- 数据库已备份，可执行 migration/rollback rehearsal。

## 要实现

- API unmatched JSON 404，避免 SPA HTML fallback。
- hashed asset immutable cache 与 HTML no-cache。
- Telegram WebView-compatible CSP/security headers 和 HTTPS preflight。
- Origin/CSRF、Cookie flags、单实例基础限流和错误脱敏。
- `miniAppEnabled` 与菜单配置流程。
- migration forward/rollback、旧数据报告与部署 runbook。
- 自动化矩阵和 Telegram 四端实机验收表。

## 验收

- [ ] 默认关闭时没有公开管理 route 或菜单入口副作用。
- [ ] `/api/*` 未匹配路径稳定返回 JSON 404。
- [ ] Cookie、CSP、缓存和 HTTPS 检查在生产构建通过。
- [ ] 认证/越权日志不包含原始 initData、Cookie、token、key 或正文。
- [ ] Migration、rollback 和旧 selection 报告在备份数据库演练通过。
- [ ] iOS、Android、Desktop、Web 均完成测试清单。
- [ ] 关闭 feature flag/menu 后可回退，现有 AI allowlist 不受影响。

## 验证命令

```bash
pnpm lint
pnpm fmt:check
pnpm typecheck
pnpm i18n:check
pnpm test
pnpm test:browser
pnpm build
pnpm db:generate
git diff --check
```

另按最终测试流程执行数据库迁移/回滚和 Telegram 四端手工测试。

## 文档影响

- 完成部署、环境变量、BotFather/Menu Button、权限、隐私和回滚 runbook。
- 维护管理员、Operator、Viewer 的测试账号/群准备步骤，不提交真实 ID 或 secret。
- 给出最终本地测试流程和实机验收表。

## 明确不做

- 不默认全量开启。
- 不实现 Redis/数据库分布式限流。
- 不实现安全事件可视化后台。
- 不在本 Goal 扩展 Provider credentials、backup、MCP 或不可逆数据操作。

## 阶段 Review Gate

- 对 G7 做轻量 review 并修复 P0/P1。
- 随后对总分支相对 main 做一次完整 review；修复总分支 P0/P1 后才交付测试流程。
