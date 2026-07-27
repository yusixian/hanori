# Telegram Mini App Goals 执行索引

总分支：`codex/telegram-mini-app-epic`

## 状态

| Goal | 纵向结果                                                      | 状态   | 前置        |
| ---- | ------------------------------------------------------------- | ------ | ----------- |
| G0   | 隐私日志、命令事实和 Summary 安全基线可验证                   | 已完成 | 无          |
| G1   | Telegram session、群目录、grant 与 capability 可通过 API 演示 | 已完成 | G0          |
| G2   | 公共 Help 与隔离 Mini App shell 可在浏览器/Telegram 演示      | 已完成 | G0、G1 契约 |
| G3   | Admin 添加群/Operator，撤销后权限立即失效                     | 已完成 | G1、G2      |
| G4   | Viewer 只读、Operator 字段级编辑并热应用                      | 已完成 | G1–G3       |
| G5   | Admin 全局/群级 Provider 模型选择跨入口一致                   | 进行中 | G1、G4      |
| G6   | Durable lifecycle 与常用 Settings 可演示                      | 待开始 | G1、G2、G5  |
| G7   | 默认关闭、单 Bot 灰度、四端验收与可回滚                       | 待开始 | G3–G6       |

## 每阶段完成定义

1. 该 Goal 文档中的纵向演示可以实际执行。
2. Acceptance criteria 已逐项核对，不以“代码已写”代替行为证据。
3. Focused tests、受影响 package typecheck、lint、format 通过。
4. 对阶段 diff 做一次轻量 Review：
   - P0：越权、数据丢失、密钥/正文泄漏、跨 Bot 访问、不可回滚破坏；必须立即修复。
   - P1：核心流程错误、并发不一致、状态伪成功、严重回归；必须在进入下一阶段前修复。
   - P2：非阻断易用性、可维护性或边缘兼容问题；能顺手修则修，否则记录到阶段交接。
5. 文档、migration、环境变量和用户可见文案与行为同步。
6. 阶段提交只包含本 Goal 与已确认的前置修复。

## Subagent / 子分支规则

- 只有边界独立、可以单独验证的工作才切子分支。
- 子分支从当前总分支 HEAD 创建独立 worktree，不在共享主 worktree 切换 branch。
- Subagent 必须提交自己的改动，并回传 commit SHA、验证命令和遗留风险。
- 主线在 cherry-pick 前检查 commit diff；合入后重新执行相关测试，不能只接受 subagent 的绿色结果。
- 多个子分支修改同一不变量时，优先串行合入并在总分支补集成测试。

## 最终交付门禁

- 对 `main...codex/telegram-mini-app-epic` 做一次完整 Review。
- 修复总分支全部 P0/P1。
- 执行 G7 全量命令和 migration/rollback rehearsal。
- 输出从本地启动、测试账号准备、BotFather/Menu Button 配置到 Telegram 四端验收的逐步测试流程。
