# G5：全局与群级 Provider/模型

状态：实现完成，阶段 Review 已修复全部已知 P0/P1（2026-07-27）。真实生产数据迁移演练归入 G7。

## 纵向、可演示的结果

Admin 在 Settings 修改全局 Provider/模型，并在任意当前 Bot 群卡片修改群级覆盖；Telegram `/provider`、`/model` 和两个面板立即看到同一结果。数据库写入失败时所有入口都不会谎报成功，也不会产生跨 Provider 的非法模型。

## 前置

- G1 chat identity/capability 完成。
- G4 group list/detail 与 revision 基础完成。
- 已备份并理解现有两张 override 表的数据。

## 要实现

- 迁移到单表 `chat_ai_selections`，含 migration report。
- `ChatAiSelectionService` 统一 global/chat resolve、set、reset、validation 与 runtime publish。
- Admin-only `chat.ai-selection.write`；移除 `modelCommandAccess=all` 绕过。
- `/model` 不再接受任意字符串。
- Provider/model 原子选择、继承来源和 availability DTO。
- Bot default + group `inherit/show/hide` 展示策略。
- Settings 与 group card 快捷选择 UI。

## 验收

- [x] 旧 provider-only/model-only/invalid 数据按确认规则迁移并生成报告。
- [x] Provider/model pair 在 DB 和单次 AI reply runtime snapshot 中一致。
- [x] 新 Provider 不接受旧 Provider 的模型。
- [x] Telegram command await persistence 后才回复成功。
- [x] 运行态 publish 失败明确显示 pending apply。
- [x] Admin 可编辑任意当前 Bot 群；离群群只读。
- [x] Operator/Viewer 不能写 selection。
- [x] 隐藏策略生效时服务端省略字段，Admin 始终可管理。

## 验证命令

```bash
pnpm db:generate
pnpm exec vitest run packages/server/src/services/chat-ai-selection-service.test.ts packages/server/src/services/chat-ai-selection-migration-contract.test.ts packages/server/src/routes/mini-app.test.ts packages/server/src/routes/bots-ai-selection.test.ts packages/bot/src/index.test.ts
pnpm test:browser
pnpm typecheck
pnpm lint
pnpm fmt:check
```

## 文档影响

- 记录 selection schema、不变量、旧数据迁移和 reset 语义。
- 更新 `/model`、`/provider` 帮助，说明不再接受任意模型与 all-user 写入。
- 更新 Settings/Groups 使用说明。

## 明确不做

- 不创建或编辑 Provider、Base URL、API Key。
- 不正规化完整 Provider catalog。
- 不允许 Operator/Viewer 修改 selection。
- 不支持任意模型字符串。

## 阶段 Review Gate

- 重点 review migration loss、pair invariant、command bypass 和 runtime consistency。
- 修复全部 P0/P1 后进入 lifecycle。

## 完成证据

- 单表 migration、migration report contract、全局/群级 service、Telegram 命令与两套 Panel 均已接到同一写路径。
- Mini App 浏览器测试覆盖原子 Provider/模型/展示策略、409 草稿保留、pending retry、Viewer 安全 label；Better Auth Panel 覆盖目录保存与 selection 冲突边界。
- 阶段 Review 未遗留 P0/P1；真实备份数据库 forward/restore 演练保留给 G7 发布门禁。
