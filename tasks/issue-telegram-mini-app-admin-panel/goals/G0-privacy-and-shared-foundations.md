# G0：隐私与共享事实基线

## 纵向、可演示的结果

在不开启 Mini App 的情况下，运行一个测试 Bot 并发送普通群消息：日志中只能看到结构化事件信息，不能出现消息正文；Bot 的命令注册、`/help` 和 `setMyCommands` 来自同一目录；Summary 的跨 Bot 写入和并发手动触发被可靠拒绝。

## 前置

- 父 Epic #34 已确认。
- 不依赖其他 Goal。
- 保持现有 Bot、Panel 和数据库行为兼容。

## 要实现

- 移除通用 Telegram 群消息日志中的正文，保留排障所需 identifiers 和结果。
- 建立 shared command catalog，并让注册、`/help`、`setMyCommands` 使用同一事实源。
- database schema 类型复用 shared `AiConfigStored`，移除重复手写类型。
- Summary update/delete 增加 Bot scope；manual cooldown 使用原子条件占用。
- 为上述行为补单元和路由测试。

## 验收

- [ ] 群消息正文、caption 和原始 update 不进入通用持久日志。
- [ ] 私聊/群聊结构化日志仍能定位 Bot、chat、user、message 和结果。
- [ ] 代表性配置下，实际注册命令与 `setMyCommands` 集合一致。
- [ ] `/help` 不再维护独立命令列表。
- [ ] Summary 无法跨 Bot update/delete。
- [ ] 两个并发 manual summary 请求最多一个占用 cooldown。
- [ ] 现有行为回归测试通过。

## 验证命令

```bash
pnpm exec vitest run --config vitest.config.ts packages/bot/src packages/server/src/routes/summary.test.ts packages/server/src/services/chat-summary-service.test.ts
pnpm typecheck
pnpm lint
pnpm fmt:check
```

## 文档影响

- 更新命令目录维护说明。
- 在隐私文档中说明通用日志不保存群消息正文。
- 若用户可见命令文案变化，同步 zh-CN/en。

## 明确不做

- 不创建 Mini App route、session、grant 或 UI。
- 不重写整个 Bot command framework。
- 不正规化全部 `aiConfig` JSON。
- 不实现安全事件后台。

## 阶段 Review Gate

- 对本 Goal diff 做一次轻量 review。
- 修复全部 P0/P1 后才进入 G1/G2；P2 只记录不阻塞。
