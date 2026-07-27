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

- [ ] 非 Admin 无法读取 Access 列表或 mutation。
- [ ] 搜索不匹配 notes、traits、interests 等隐私字段。
- [ ] Username 只用于发现，精确 Telegram ID 才是授权身份。
- [ ] Bot 非群管理员时无法创建 chat grant，并展示最小权限修复提示。
- [ ] Operator 不需要是群成员即可操作全部 granted chats。
- [ ] Viewer 必须仍是具体群成员。
- [ ] 撤销 grant 不依赖 session 过期即可生效。

## 验证命令

```bash
pnpm test -- packages/server/src/routes packages/server/src/services
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
