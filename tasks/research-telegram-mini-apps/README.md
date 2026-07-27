# Telegram Mini Apps 接入研究报告

> 更新日期：2026-07-27
>
> 官方来源：[Telegram Mini Apps](https://core.telegram.org/bots/webapps)、[Bot API](https://core.telegram.org/bots/api)、[Deep Links](https://core.telegram.org/api/links)

## 结论

截图中的“群组配置 / 白名单”不是 Telegram 自动生成的后台，而是 Bot 开发者提供的普通 HTTPS Web App。Telegram 负责 WebView、入口、主题参数和签名身份；群目录、授权、配置、审计与 UI 都需要 Bot 服务自行实现。

cos-tool-bot 已有 React Panel、Hono API、PostgreSQL、grammY、多 Bot BotPool 和 Telegram 人物档案，适合在现有 monorepo 中增加独立 Mini App surface，不需要新技术栈或第二套部署。

最终产品定位是：

- 每个 Bot 独立的 Telegram-native control plane；
- 管理员处理生命周期、访问名单和常用 AI/群配置；
- 显式白名单人处理白名单群的低风险运行配置；
- 白名单群当前成员读取安全投影；
- 其他人查看静态 Help。

完整设计见 `docs/design/telegram-mini-app-access-control.md`。

## Telegram 提供什么

### 启动入口

适合本项目的入口有：

| 入口                      | 用途                                            | 结论                      |
| ------------------------- | ----------------------------------------------- | ------------------------- |
| Main Mini App             | Bot 资料页的 Launch app 和 `startapp` deep link | 可作为正式入口            |
| Menu Button               | Bot 私聊输入框旁固定入口                        | M1 主入口                 |
| Inline Keyboard `web_app` | 从消息跳入指定页面                              | 后续 contextual deep link |
| Reply Keyboard `web_app`  | 私聊一次性交互                                  | 不作为后台主入口          |
| Attachment Menu           | 任意聊天附件菜单                                | 官方资格受限，不作为依赖  |

Mini App URL 必须使用 HTTPS。现有 Hono 可以同源托管 Panel 静态资源和 Mini App API。

### 身份签名

页面可以读取 `window.Telegram.WebApp.initData`。安全流程是：

1. 前端原样提交 `initData`；
2. 服务端用启动该页面的 Bot token 验证 hash；
3. 校验 `auth_date`、未来时间、重复字段和 user ID；
4. 使用 timing-safe comparison；
5. 换取短期、Bot-scoped session；
6. 后续请求仍校验 Bot scope 和实时业务权限。

`initDataUnsafe` 不能作为认证或授权依据。Bot token 不能进入浏览器、URL、localStorage 或 Telegram DeviceStorage。

多 Bot 架构天然要求每个 Bot 使用自己的 token 验证：Bot A 的签名提交到 Bot B endpoint 必须失败。

### WebView 能力

Mini App 可读取 Telegram theme、viewport、safe-area、platform，并使用 BackButton 等原生交互。它仍然是普通网页，需要自行处理：

- 自适应亮暗主题；
- 动态 viewport 和虚拟键盘；
- iOS safe-area；
- BackButton/MainButton 生命周期；
- 浏览器直开与 DEV mock；
- Cookie 在 iOS、Android、Desktop、Web 的差异。

## Telegram 不提供什么

### 没有“列出 Bot 所在全部群”API

Mini App 和 Bot API 都不能一次列出全部群。群列表必须来自 Bot 自己观察并维护的目录：

- 普通 group/supergroup updates；
- `my_chat_member`；
- basic group → supergroup migration；
- Bot 离群、被踢和重新加入。

旧 `groupOverrides` 只能当未验证候选，不能证明 Bot 现在仍在群中。

### 身份不等于权限

Telegram 签名只能证明用户是谁，不能证明其可以管理某个 Bot 或群。项目现有两套边界不能混用：

- Web Panel：Better Auth workspace roles；
- Telegram Bot：每 Bot `adminChatIds`。

Mini App 必须使用独立 policy 和 session，不能让 Telegram 身份直通现有 `/api/bots/*`。

### 可靠成员检查要求 Bot 管理员

Bot API 对其他用户的 `getChatMember` 只有在 Bot 是群管理员时才保证可靠。M1 因此通过下面的 deep link 添加 Bot：

```text
https://t.me/<bot_username>?startgroup&admin=manage_chat+pin_messages
```

`manage_chat` 满足可靠 membership 查询；`pin_messages` 保留项目已有 pin tool。删除消息、封禁、邀请、提升管理员等权限不申请。用户仍可以在 Telegram 确认页修改权限，服务端返回后必须验证实际状态。

### 管理员 Bot 的隐私后果

Bot 成为管理员后，即使 Privacy Mode 开启也会收到群内全部消息。当前项目通用日志链路会在权限门禁前记录原始文本，因此上线 Mini App 前必须先移除群消息正文持久化，并保证 chat grant 不会自动开启 AI conversation/history。

这是 M1 发布阻断项，不是帮助页提示能够替代的风险。

## 现有仓库能力与缺口

### 可复用

- `packages/panel`：React 19、Tailwind v4、i18n、UI primitives；
- `packages/server`：Hono、BotPool、加密 Bot token、同源静态部署；
- `packages/database`：Bot、人物档案、群配置、Summary、timer、审计所需基础；
- `packages/bot`：grammY、Bot API client、update pipeline；
- `chat_provider_overrides` / `chat_model_overrides`：已有群级 AI selection 数据；
- `adminChatIds`：当前 Bot 管理员信任根。

### 缺口

- Mini App `initData` 验证和 Bot-scoped session；
- 群目录和 Bot membership lifecycle；
- 独立 chat/operator grants；
- 中心化 capability policy；
- 安全的字段级群配置 API；
- Telegram WebView-first UI；
- Bot 生命周期 desired/runtime 协调；
- Provider/模型原子配置对；
- 群迁移时的跨表 identity migration。

## 代码审计发现

### 宽 AI 配置接口不适合 Mini App

现有 AI 更新接口会读写大块 `aiConfig` JSON。Mini App 若为修改一个群开关而复用该接口，会同时获得 Provider、Prompt、工具和其他群配置，并可能用旧快照覆盖并发修改。

应通过 `GroupConfigService.patch` 做字段级 merge、revision conflict 和热应用。

### Provider/模型存在撕裂风险

现有群级 Provider 与模型分两张表、两个 Map、两个 fire-and-forget callback：

- 切换 Provider 不会清理旧模型；
- 数据库失败仍可能回复“已切换”；
- 快速写入可能导致 DB 和 runtime 顺序不同；
- `/model` 允许任意字符串；
- `modelCommandAccess=all` 能绕过 Mini App 的管理员限制。

最终方案是迁移到单一 `chat_ai_selections`，由 awaited `ChatAiSelectionService` 同时服务 Telegram 命令、现有 Panel 和 Mini App。

### 现有启停不是 durable 开关

当前 `start/stop/restart` 只改变当前 BotPool manager，不写 `bots.isActive`。服务重启时只根据 `isActive` 启动，因此 UI 的 stop 可能在服务重启后失效。

Stop/restart 还会清掉 runtime timer handle，但普通 Bot start 不重新执行 timer recovery，可能让 active timer 一直搁置到整个服务重启。

最终方案是统一 `BotLifecycleService`：`isActive` 表达 desired state，运行态返回 reconciliation 结果，restart 恢复 timer。

### Summary 权限与冷却需要先修

Summary 的 update/delete 必须同时按 Bot 和 chat scope 约束，手动 cooldown 必须使用条件占用，避免跨 Bot 更新和并发重复执行。这些问题直接影响 operator 能力，属于 M1 prefactor。

## 推荐架构

```text
Telegram WebView
  │ initData
  ▼
Mini App surface (packages/panel)
  │ Bot-scoped cookie
  ▼
/api/mini-app/:botId/*
  ├─ session validator
  ├─ MiniAppAccessPolicy
  ├─ role-projected DTOs
  └─ application services
       ├─ GroupConfigService
       ├─ ChatAiSelectionService
       ├─ BotLifecycleService
       ├─ TelegramMembershipVerifier
       └─ ChatIdentityMigrationService
```

前端保持一个 Vite 构建，但 Mini App 与 Admin Panel 使用两个 lazy surface。Mini App 不实例化 Refine/Better Auth/data provider，只共享纯组件、类型和 i18n。

API 使用 `/api/mini-app/:botId/*` 和 Path-scoped Cookie。URL botId 不是权限来源；服务端必须核对 session 内 Bot、Telegram user 和实时 capability。

## 最终 M1

M1 包含：

- public Help、命令目录和项目背景；
- Telegram theme/safe-area 与中英文；
- admin/operator/viewer/none 四态；
- 群目录、两类 grant、90 天活动；
- 群配置 list/detail 与字段级保存；
- 管理员全局 AI enable、Provider/模型、System Prompt；
- 管理员对任意当前 Bot 群的 Provider/模型快捷覆盖；
- Provider/模型可见性默认公开、Bot 默认 + 群覆盖；
- durable Bot enable/disable/restart；
- timer 恢复、配置热应用和 pending-apply 状态；
- 单 Bot feature flag 与四类 Telegram 客户端验收。

Operator 只能修改 granted groups 的低风险运行配置；viewer 只能看当前所属 granted groups；无权限用户始终能看 Help。

## 上线顺序

1. 数据库 migration、隐私 P0 和 application services；
2. 后端 session/policy/routes，feature flag 仍关闭；
3. 公共 Help 与 Mini App shell；
4. 单个测试 Bot 的群/access/config/lifecycle 闭环；
5. 自动化与 migration rollback；
6. Telegram iOS、Android、Desktop、Web 实机；
7. 配置测试 Bot Menu Button，再决定扩大范围。

回滚先关闭 `miniAppEnabled` 和菜单入口，再停用 routes。新增目录、grant、selection 与 audit 表保留不会改变现有 Bot 行为；确认导出后才考虑 drop。

## 参考链接

- [Telegram Mini Apps 官方文档](https://core.telegram.org/bots/webapps)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Telegram Mini Apps 客户端实现](https://core.telegram.org/api/bots/webapps)
- [Telegram Deep Links](https://core.telegram.org/api/links)
- [Telegram Suggested Admin Rights](https://core.telegram.org/api/rights)
