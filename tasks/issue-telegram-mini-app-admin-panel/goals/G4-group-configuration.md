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

- [ ] Operator 只能修改 granted chat 的允许字段。
- [ ] Viewer 所有 mutation 403，且 DTO 无 Prompt、profiles、history、usage 或 credentials。
- [ ] 两个并发非重叠字段更新不会互相丢失。
- [ ] stale revision 返回 409 和最新值。
- [ ] DB 失败不修改 runtime；runtime 失败显示 persisted/pending apply。
- [ ] 运行中配置热应用不 restart Bot。
- [ ] Summary update/delete 与 cooldown 继续满足 G0 不变量。

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

- 不整体 PUT AI config。
- 不让 Operator 修改 Provider、模型、Prompt 或展示策略。
- 不实现常驻 retry worker。
- 不在本 Goal 正规化全部 groupOverrides JSON。

## 阶段 Review Gate

- 重点 review lost update、field over-posting、runtime/DB 分裂和权限投影。
- 修复全部 P0/P1 后进入 AI selection。
