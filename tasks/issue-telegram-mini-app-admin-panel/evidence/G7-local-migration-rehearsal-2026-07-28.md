# G7 本地迁移与恢复演练证据（2026-07-28）

## 范围

本证据只覆盖合成数据上的 migration/report/restore 路径，不替代真实部署数据库快照演练，也不证明 Telegram 四端行为。

- PostgreSQL：`pgvector/pgvector:pg17`，临时容器存储，绑定 `127.0.0.1:55433`。
- 基线：依次应用 `0000`–`0037` migrations。
- 上线迁移：`0038_perpetual_metal_master.sql`、`0039_modern_plazm.sql`。
- 清理：演练容器使用 `--rm`，完成后已停止并自动删除；未写入开发或生产数据库。

## 合成 fixture

同一个 Bot 配置两个 Provider，并写入以下 legacy selection：

|             chat_id | fixture               | 预期                                   |
| ------------------: | --------------------- | -------------------------------------- |
|             `-1001` | 有效 Provider + Model | `migrated_pair`                        |
|             `-1002` | 仅有效 Model          | 绑定有效全局 Provider，`migrated_pair` |
|             `-1003` | 无效 Provider + Model | `inherited`                            |
|             `-1004` | 仅有效 Provider       | `migrated_provider_default`            |
|                `42` | 正数私聊 ID           | `ignored / non_group_chat`             |
| `-9007199254740992` | 超出 JS safe integer  | `ignored / unsafe_chat_id`             |

## 演练步骤

1. 创建隔离 PostgreSQL，应用 `0000`–`0037`，写入上述 fixture。
2. 使用 `pg_dump -Fc` 创建迁移前快照；快照大小 `98440 bytes`，当次 SHA-256 为 `030b099d4251f31e9e1ed91619e9c50b5cd5e5c01d99c74647865e15ec32a87d`。
3. 以 `ON_ERROR_STOP=1` 应用 `0038` 和 `0039`。
4. 查询 migration report、selection、Bot feature flag 和 legacy row count。
5. 新建空数据库，用 `pg_restore` 恢复迁移前快照。
6. 查询恢复库，确认旧数据存在且新表/新列不存在。

## 结果

- Migration report 共 6 行，outcome/reason 与上表全部一致。
- `chat_ai_selections` 只创建 3 行：`-1001 → p2/m3`、`-1002 → p1/m2`、`-1004 → p2/default`。
- 正数私聊和 unsafe ID 没有进入 selection。
- `bots.mini_app_enabled = false`。
- 迁移后 legacy Provider/Model rows 均保持 5 行。
- 快照恢复到新数据库成功：Bot 1 行、legacy Provider 5 行、legacy Model 5 行。
- 恢复库中 `chat_ai_selections` 不存在，`bots.mini_app_enabled` 列数为 0，证明恢复的是迁移前状态。

## 仍需外部证据

- 从真实部署数据库快照恢复隔离副本，重复 `migrate → report → restore`，核对真实 legacy 分布、数据量与运行时启动。
- 在真实 HTTPS origin 上完成 Telegram iOS、Android、Desktop、Web 验收表。
