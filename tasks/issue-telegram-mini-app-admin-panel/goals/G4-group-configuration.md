# G4：群配置纵向闭环

## 纵向、可演示的结果

Viewer 可以只读查看授权群的安全配置；Operator 可以在详情页修改允许字段、看到变更摘要并保存；Web Panel 同时修改时 Mini App 得到 409 而不是覆盖新值；运行中的 Bot 无需 restart 即采用新配置。

## 前置

- G1 policy 与 chat catalog 完成。
- G2 shell 完成。
- G3 grants 闭环完成。

## 要实现

- 唯一 `GroupConfigService.patch` 与 revision 契约。
- group list/detail 的 Admin/Operator/Viewer DTO projection。
- allowed field schema：enabled、AI whitelist、trigger、conversation 和限定 Summary fields。
- DB source of truth、按 Bot 锁、latest-value merge 和 runtime hot apply。
- saved/pending-apply 状态与 admin 手动 retry。
- 群列表、详情页、只读 viewer UI、dirty state 和 change summary。

## 验收

- [x] Operator 只能修改 granted chat 的允许字段。
- [x] Viewer 所有 mutation 403，且 DTO 无 Prompt、profiles、history、usage 或 credentials。
- [x] 两个并发非重叠字段更新不会互相丢失。
- [x] stale revision 返回 409 和最新值。
- [x] DB 失败不修改 runtime；runtime 失败显示 persisted/pending apply。
- [x] 运行中配置热应用不 restart Bot。
- [x] Summary update/delete 与 cooldown 继续满足 G0 不变量。

## 验证命令

```bash
pnpm exec vitest run --config vitest.config.ts packages/server/src/routes packages/server/src/services packages/bot/src
pnpm test:browser
pnpm i18n:check
pnpm typecheck
pnpm lint
pnpm fmt:check
```

## 文档影响

- 记录允许字段矩阵、revision/409 和 pending-apply 语义。
- 更新群配置页面操作说明。

## 明确不做

- Mini App 不整体 PUT AI config；既有 Web Panel 整页保存使用 Bot revision 防止覆盖 Mini App 新值。
- 不让 Operator 修改 Provider、模型、Prompt 或展示策略。
- 不实现常驻 retry worker。
- 不在本 Goal 正规化全部 groupOverrides JSON。

## 阶段 Review Gate

- 重点 review lost update、field over-posting、runtime/DB 分裂和权限投影。
- 修复全部 P0/P1 后进入 AI selection。

## 完成证据

- 后端与 runtime：`5646e20`；Web Panel stale-save 防护：`64cffa5`；Mini App UI：`7390264`；revision 单调性修复：`5fc1183`。
- 后端 G4/相关服务定向测试 63/63，完整 Panel browser 66/66；全仓 typecheck、format、i18n、Panel build 通过；lint 为 0 error、3 个既有 warning。
- 阶段 Review 发现并修复两个 P1：commit 后 runtime apply 重排序，以及 summary-only 同毫秒更新不推进 revision；复核后无剩余明确 P0/P1。
- 真实 PostgreSQL 行锁/rollback、Telegram Bot 热应用与四端 WebView 仍属于 G7 实机/发布门禁；M1 明确不覆盖多实例锁和 durable retry worker。
