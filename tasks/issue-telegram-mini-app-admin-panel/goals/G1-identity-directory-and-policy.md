# G1：Telegram 身份、群目录与权限内核

## 纵向、可演示的结果

使用测试 Bot 的真实或固定签名 fixture 创建 Bot-scoped session；同一套 API 能返回 admin/operator/viewer/none，并证明错 Bot、过期签名、撤销 grant 和失效 membership 都会拒绝访问。

## 前置

- G0 完成并通过阶段 Review。
- 已确定 Mini App HTTPS origin 和 session signing secret 配置方式。

## 要实现

- Telegram `initData` 验证与 15 分钟 Bot-scoped HttpOnly session。
- Telegram Bot profile、chat catalog、chat/operator grants、audit schema 与 migration。
- 独立 observation middleware 处理普通 updates、`my_chat_member` 和群迁移。
- `MiniAppAccessPolicy`、capability map、role resolver。
- running BotManager 暴露窄 `TelegramMembershipVerifier`。
- safe integer、user 正数、group/supergroup 负数边界校验。
- `ChatIdentityMigrationService` 迁移 M1 chat-scoped 资源。

## 验收

- [ ] 篡改、过期、未来时间、重复字段、错 Bot 和 unsafe ID 均被拒绝。
- [ ] Bot A session 无法访问 Bot B。
- [ ] Admin 仅来自当前 Bot `adminChatIds`。
- [ ] Operator grant 与 chat grant 独立于现有 AI allowlists。
- [ ] Viewer grant 还必须通过当前 membership 校验，失败时 fail closed。
- [ ] Grant 撤销对下一次 mutation 立即生效。
- [ ] Bot 离群记录归档，重新加入可恢复。
- [ ] group → supergroup 迁移遵守 target-wins 并记录冲突。

## 验证命令

```bash
pnpm db:generate
pnpm exec vitest run --config vitest.config.ts packages/server/src packages/bot/src
pnpm typecheck
pnpm lint
pnpm fmt:check
```

## 文档影响

- 记录 session、Cookie、capability 与 Bot scope 契约。
- 记录 migration forward/rollback 和 Telegram ID 约束。
- 更新环境变量示例，但不提交真实 secret。

## 明确不做

- 不实现 Groups/Access 页面。
- 不持久化完整群成员列表。
- 不把 Telegram 用户映射为 Better Auth workspace member。
- 不支持 channel/private-chat grants。
- 不实现多实例共享 membership cache。

## 阶段 Review Gate

- 重点 review tenant isolation、签名算法、Cookie、grant 撤销和 migration。
- 修复全部 P0/P1 后才允许 UI 消费这些 API。
