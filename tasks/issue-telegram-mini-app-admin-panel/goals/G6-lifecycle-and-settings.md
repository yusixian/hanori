# G6：Bot Lifecycle 与常用 Settings

状态：实现完成，阶段 Review 已修复全部已知 P0/P1（2026-07-27）。

## 纵向、可演示的结果

Admin 在 Mini App 启用、停用或重启当前 Bot：状态在整个 server restart 后仍符合选择；停止会中断当前 Bot 的工作而不影响其他 Bot；active timer 在再次启动后恢复，过期提醒只补发一次并标记延迟。

## 前置

- G1 session/capability 完成。
- G2 Settings shell 完成。
- G5 全局 AI selection service 完成。

## 要实现

- `BotLifecycleService` 统一现有 Panel 和 Mini App lifecycle route。
- `isActive` 作为 durable desired state，返回 desired/runtime/reconciled。
- enable/disable/restart 的异常和 pending reconciliation。
- active AI、Summary、RSS、generation recovery 和 timer 的停止/重启语义。
- Admin Settings：lifecycle、global AI enable、System Prompt、全局 Provider/模型。
- start 无确认；stop/restart 二次确认，无 reason 字段。

## 验收

- [x] Disable 后 server restart 不会重新启动 Bot。
- [x] Enable 失败保留 desired=true 且 API/UI 显示 unreconciled。
- [x] Restart 不改变 desired state；desired=false 时拒绝 restart。
- [x] 一个 Bot 的 lifecycle 不影响其他 Bot。
- [x] 停止取消活跃 AI/internal tasks，并说明外部副作用不会回滚。
- [x] Active timer 在 start/restart 后恢复；overdue 只补发一次并标记 delayed。
- [x] Summary/RSS 等 Bot-scoped job 不因 stop 形成静默丢任务状态。
- [x] 所有 lifecycle mutation 写 audit。

## 验证命令

```bash
pnpm exec vitest run --config vitest.config.ts packages/server/src/services/bot-manager.test.ts packages/server/src/services/bot-pool packages/server/src/routes/bots-profile-lifecycle.test.ts packages/server/src/services/timer-registry.test.ts
pnpm test:browser
pnpm typecheck
pnpm lint
pnpm fmt:check
```

## 文档影响

- 记录 desired/runtime/reconciled 状态机。
- 记录 Stop 对 AI、timer、Summary、RSS 和外部副作用的影响。
- 更新 Admin Panel 与 Mini App lifecycle 行为说明。

## 明确不做

- 不提供临时 stop 与 durable disable 两套按钮。
- 不要求填写操作原因。
- 不允许 Operator/Viewer 管理 lifecycle。
- 不加入 Bot 删除或 token 修改。

## 阶段 Review Gate

- 重点 review crash windows、timer duplication/loss、跨 Bot 影响和错误伪成功。
- 修复全部 P0/P1 后进入生产硬化。

## 完成证据

- Better Auth 与 Mini App 复用 `BotLifecycleService`；BotPool 以 durable `isActive` 为启动闸门，返回 desired/runtime/reconciled，不以当前 manager 存在与否推断期望状态。
- Timer pause/resume、`processing` lease、跨 Bot 隔离、失败回滚和一次有界重试有聚焦测试；正常路径单次投递，外部投递与 DB finalize 之间的崩溃歧义按 at-least-once 恢复。事件空文本会补发确定性提示；已知只读工具可重放、未知工具默认有副作用，副作用成功后不因发送失败整段重放。Timer 将 effect-only 结果视为已消费；scheduled RSS 不暴露写工具，只有可见 Telegram delivery 才由服务统一推进整批 checkpoint。
- 最终 Review 将新建 timer 的首次触发也统一到 `TimerRegistry` claim/deliver/rollback 状态机；首次 Telegram 投递失败会在当前进程 5 秒后重试一次，持久化失败则创建操作直接返回错误，避免只能等待 Bot restart 或界面误报成功。
- Mini App Settings 已交付 lifecycle、AI 总开关、System Prompt 和全局 Provider/模型。Enable 不确认，Disable/Restart 二次确认；浏览器测试覆盖 CSRF 与原子 settings mutation。
- 阶段 Review 修复：timer resume 错误伪成功、RSS 停机静默丢 digest、Mini App flag 启用失败后无法关闭并恢复 Bot。最终 Review 继续修复 `continueChat` 吞掉 skip/send error、claim 后崩溃永久丢 timer、工具成功后整段重放、RSS effect-only 错误推进 checkpoint、crash 后 disable 未清理 handler/disposer，以及群迁移后 runtime 仍使用旧 chat ID。
