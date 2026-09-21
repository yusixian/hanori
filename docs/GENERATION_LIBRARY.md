# 生成资产库维护与验收

Issue #53 分成三个可独立关闭的能力：角色沉淀与原创角色、提示词资产、生成时自动注入。
公共操作指南见 `packages/docs/content/docs/guides/media.mdx`。

## 数据与权限

- `generation_characters`：Danbooru 规范 tag 在 Bot 内唯一；原创角色采用独立 ID，不按名称合并。上游元数据与人工 OC 内容分开。
- `people_character_bindings`：people 到角色的多对多引用，区分代表形象和喜爱角色；部分唯一索引保证每人至多一个默认代表形象。
- `prompt_assets`：明确标注 safe/nsfw 的共享提示词资产；仅 Bot 管理员或后台 owner/admin 可写。
- `generation_library_configs`：Bot 独立开关，自动注入和 NSFW 默认关闭。
- `generation_asset_uses`：每任务每资产唯一，用于恢复与重试的成功计数。任务快照保存实际素材内容，不依赖当前资产仍存在。

后台身份不能冒充 Telegram 用户。工具 actor 从当前事件构造；people 绑定写权限与角色编辑权限分别校验。后台研究与续聊只开放查询，不开放 OC、绑定或资产维护；查询派生的公开资料沉淀与次数统计仍启用。

AI 回合已持有发言者隐私锁。库写入通过 `runLibraryExclusiveMany` 复用当前有效锁租约；已结束的异步上下文不能继续当作持锁。跨用户操作遇到逆序且占用的锁立即返回可重试错误，不互相等待。数据库事务进一步保护默认角色切换与去重。

删除用户通过既有 forget 流程删除其 OC 与关联；普通删除 people 仅解除绑定。历史任务快照、已发送图片与独立共享资源不因删除当前角色而重写。

Bot 导入按依赖顺序重新分配角色、people、资产和生成任务 ID，并同步转换绑定、素材快照和使用账本。缺少实际关联依赖时整笔导入回滚；仅用于历史快照的已删除素材采用负数占位 ID，避免与新资产冲突。历史内容不改写，重复导出导入仍保留该语义。

上述保证仅针对素材库引用转换。历史生成任务原有的全局唯一 `idempotencyKey` / `providerOperationId` 仍可能阻止同实例重复导入；本次没有改变任务恢复或供应商操作的语义。导入映射测试采用 mock，不代表完整生产备份恢复验收。

## 升级与回退

按顺序应用新增迁移：0048 角色和绑定、0049 提示词资产和开关、0050 成功使用账本。迁移生成后审阅了 SQL 的索引/外键创建顺序。实施时先在开发数据库验证，再通过现有部署流程应用；不要改写已部署迁移。

先保持自动注入关闭，验证角色/资产检索和 CRUD，再为一个测试 Bot 启用自动注入。检查任务快照中原始 prompt、最终 prompt、角色及资产内容。开关关闭不删除数据；需要恢复原有纯提示词流程时关闭自动注入，或在单次请求中明确选择 `skipLibrary`。

图片配额、preset 和供应商审批仍由原有生成服务处理。新增库错误在供应商调用之前失败；不自动切换后端。数据库 unavailable 时不会悄悄漏掉 pinned 出图。

## 定向验证

常规单测与路由测试：

```bash
pnpm exec vitest run packages/bot/src/tools/generation-library.test.ts packages/bot/src/tools/danbooru.test.ts packages/bot/src/tools/image-generation.test.ts packages/server/src/routes/generation-library.test.ts packages/server/src/services/user-privacy-service.test.ts packages/server/src/services/image-generation-service.test.ts
pnpm --filter @cos-tool-bot/panel test:browser src/pages/bots/generation-library.browser.test.tsx src/pages/bots/profiles.browser.test.tsx
```

真实 PostgreSQL 验证使用显式 `GENERATION_LIBRARY_TEST_DATABASE_URL`；测试拒绝非本机或名称不以 `_test` 结尾的数据库。它创建随机 schema、准备所需基础表、执行本次三份真实迁移，再验证事务、并发去重、默认角色、访问隔离和计数回滚，最后清理自己的 schema。未配置变量时跳过该测试，不会读取 `DATABASE_URL`。

```bash
GENERATION_LIBRARY_TEST_DATABASE_URL='postgres://localhost/cos_generation_library_test' \
  pnpm exec vitest run packages/server/src/services/generation-library.integration.test.ts
```

该测试证明新增迁移和领域行为，不替代全历史迁移链、生产迁移或真实 Telegram/图片供应商验收。
