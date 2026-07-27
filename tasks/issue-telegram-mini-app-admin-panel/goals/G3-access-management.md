# G3：访问名单纵向闭环

## 纵向、可演示的结果

Admin 在 Telegram Mini App 中通过安全搜索或精确 ID 添加/删除 Operator，通过 startgroup deep link 添加并授权测试群；新 Operator 随即能看到授权群，群成员能只读查看，撤销后下一次写入立即被拒绝。

## 前置

- G1 identity/directory/policy 完成。
- G2 Mini App shell 与导航完成。
- 测试 Bot 已可通过 HTTPS Mini App 打开。

## 要实现

- Admin-only Access routes 和 role-projected DTO。
- 安全 people profile search projection。
- chat/operator grant 增删、note、creator、timestamps。
- startgroup deep link 与返回刷新/实际 Bot admin 校验。
- Access UI：群、用户、最近 90 天活动和筛选。
- Grant mutation 与 audit 同事务。

## 验收

- [x] 非 Admin 无法读取 Access 列表或 mutation。
- [x] 搜索不匹配 notes、traits、interests 等隐私字段。
- [x] Username 只用于发现，精确 Telegram ID 才是授权身份。
- [x] Bot 非群管理员时无法创建 chat grant，并展示最小权限修复提示。
- [x] Operator 不需要是群成员即可操作全部 granted chats。
- [x] Viewer 必须仍是具体群成员。
- [x] 撤销 grant 不依赖 session 过期即可生效。

## 验证命令

```bash
pnpm exec vitest run --config vitest.config.ts packages/server/src/routes packages/server/src/services
pnpm test:browser
pnpm i18n:check
pnpm typecheck
pnpm lint
pnpm fmt:check
```

## 文档影响

- 记录 Bot 最小管理员权限与隐私披露。
- 记录 operator/viewer 的准确能力和失效语义。
- 添加 Access 页操作说明。

## 明确不做

- 不编辑 `adminChatIds`。
- 不复用 AI/private-chat allowlist。
- 不存储群成员快照。
- 不支持 channel 或 private-chat grant。
- 不实现默认管理员权限自动同步。

## 阶段 Review Gate

- 重点 review privilege escalation、跨 Bot IDOR、搜索隐私和 audit 原子性。
- 修复全部 P0/P1 后才开放群配置 mutation。

## 完成证据（2026-07-27）

- Admin-only Access API 与 UI 已交付：群授权、Operator 安全搜索/精确 ID 授权、可选 note、明确撤销确认、startgroup deep link、刷新和 90 天 activity 三维筛选。
- 每个 API 请求实时重算 Bot-scoped capability；mutation 校验 session CSRF。群授权以在线 `getMe + getChatMember` 为准，只接受 Bot 当前为 `creator/administrator`。
- grant 增删与脱敏 audit 在同一数据库 transaction；people SQL 搜索与 DTO 只选择 Telegram ID、username、display name、lastSeen。
- G3 权限/session focused tests：6 个文件、42 tests 通过；完整 Panel browser tests：13 个文件、59 tests 通过。
- 全仓 `pnpm typecheck`、i18n（1477 keys / 7 namespaces）、Panel/Server production build、lint（0 errors、3 个既有 warnings）、format 与 diff check 通过。
- 全量 Server routes/services 在沙箱内 46/47 文件通过；唯一失败文件因 `listen EPERM` 超时，允许 Unix socket/loopback 后单独重跑 19/19 通过。
- 两次阶段 Review 均无 P0/P1；预审发现并修正 activity 筛选维度、缓存 membership 误阻断实时验证、note 长度和空 Bot username deep link；同时清除一个新增 test lint warning。
- 真实 PostgreSQL 并发/rollback、真实 Telegram startgroup 与权限升降、四端 Cookie/网络恢复仍留在 G7 灰度验收。
