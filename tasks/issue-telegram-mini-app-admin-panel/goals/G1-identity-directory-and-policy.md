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

- [x] 篡改、过期、未来时间、重复字段、错 Bot 和 unsafe ID 均被拒绝。
- [x] Bot A session 无法访问 Bot B。
- [x] Admin 仅来自当前 Bot `adminChatIds`。
- [x] Operator grant 与 chat grant 独立于现有 AI allowlists。
- [x] Viewer grant 还必须通过当前 membership 校验，失败时 fail closed。
- [x] Grant 撤销对下一次权限解析立即生效；具体 mutation 的 403 由 G3/G4 验收。
- [x] Bot 离群记录归档，重新加入可恢复。
- [x] group → supergroup 迁移遵守 target-wins 并记录冲突。

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

## 完成证据（2026-07-27）

- 固定签名 fixture 通过 HTTP session route 演示 admin/viewer/none、15 分钟 Bot-scoped Cookie、过期/未来/篡改拒绝、跨 Bot 拒绝，以及 grant/membership 下一次解析立即降权。
- Bot observation 已接入真实 BotPool 启动链；运行时只暴露 `getMe` 公开投影和 `getChatMember` membership，不暴露 token 或 Telegram client。
- chat identity migration 使用 Bot row lock 和单事务执行 target-wins、lineage 与 system audit；明确排除 conversation/history、compaction、chat summaries 和 PixAI generations。
- `pnpm db:generate` 输出 `No schema changes, nothing to migrate`；全仓 `pnpm typecheck`、`pnpm fmt:check`、server build 通过；`pnpm lint` 为 0 error、3 个既有 warning。
- server+bot 全范围测试首轮 85 files / 637 tests 中，82 files / 623 tests 通过；其余 3 files 因 sandbox `listen EPERM`/连带超时失败，在允许 loopback 的环境单独重跑 3 files / 59 tests 全部通过。
- 阶段边界 Review 未发现 P0/P1。验证盲区：真实 PostgreSQL 双连接竞争、数据库快照/回滚演练与真实 Telegram iOS/Android/Desktop/Web 往返留到 G7。
