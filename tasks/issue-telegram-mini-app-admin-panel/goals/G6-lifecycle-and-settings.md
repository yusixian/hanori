# G6：Bot Lifecycle 与常用 Settings

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

- [ ] Disable 后 server restart 不会重新启动 Bot。
- [ ] Enable 失败保留 desired=true 且 API/UI 显示 unreconciled。
- [ ] Restart 不改变 desired state；desired=false 时拒绝 restart。
- [ ] 一个 Bot 的 lifecycle 不影响其他 Bot。
- [ ] 停止取消活跃 AI/internal tasks，并说明外部副作用不会回滚。
- [ ] Active timer 在 start/restart 后恢复；overdue 只补发一次并标记 delayed。
- [ ] Summary/RSS 等 Bot-scoped job 不因 stop 形成静默丢任务状态。
- [ ] 所有 lifecycle mutation 写 audit。

## 验证命令

```bash
pnpm test -- packages/server/src/services/bot-manager.test.ts packages/server/src/services/bot-pool packages/server/src/routes/bots-profile-lifecycle.test.ts packages/server/src/services/timer-registry.test.ts
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
