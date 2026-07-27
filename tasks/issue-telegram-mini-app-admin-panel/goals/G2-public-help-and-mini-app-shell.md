# G2：公共 Help 与 Mini App Shell

## 纵向、可演示的结果

浏览器直开 Help 即可看到中英文项目背景和命令；从 Telegram 或 DEV adapter 打开 Mini App 时，页面适配亮暗主题、safe area 和返回按钮，并根据 G1 返回的角色展示正确导航，而现有 Admin Panel 登录路由不受影响。

## 前置

- G0 command catalog 可用。
- G1 session/bootstrap DTO 契约稳定；公共 Help 本身不依赖 G1 runtime。

## 要实现

- 一个 BrowserRouter 下的 lazy MiniAppApp 与 lazy AdminPanelApp。
- 公共 `/mini-app/:botId/help`，无 API/session 依赖。
- 独立 Telegram adapter 和仅 DEV 可用的 mock。
- zh-CN/en `miniApp` namespace 与 bundle split。
- Telegram theme、viewport、safe-area、BackButton 和 mobile bottom navigation。
- 独立 fetch/error boundary；401/403 不跳现有 `/login`。

## 验收

- [x] `fetch` 失败或 Telegram SDK 缺失时，Help 仍能显示。
- [x] 公共 Help 不展示当前 Bot enabled capability、Provider 数量或部署状态。
- [x] Admin 导航为 Groups/Settings/Access/Help；Operator/Viewer 为 Groups/Help。
- [x] 亮暗主题、窄屏、safe area 和键盘场景无内容遮挡。
- [x] Mini App 401 显示 session expired，403 回到 Help。
- [x] 现有 Better Auth login、Refine routes 和 light-theme Panel 无回归。

## 验证命令

```bash
pnpm test:browser
pnpm i18n:check
pnpm --filter @cos-tool-bot/panel typecheck
pnpm --filter @cos-tool-bot/panel build
pnpm lint
pnpm fmt:check
```

## 文档影响

- 记录 Mini App route map、Telegram adapter 和 DEV mock 使用方法。
- 更新中英文 Help 文案与截图占位。

## 明确不做

- 不复用 Refine auth/data/layout。
- 不实现 Groups/Settings/Access 的业务表单。
- 不把 Telegram theme 强加给现有 Admin Panel。
- 不依赖 Attachment Menu。

## 阶段 Review Gate

- 重点 review route isolation、生产 mock 泄漏、可访问性和移动布局。
- 修复全部 P0/P1 后再接真实 mutation。

## 完成证据（2026-07-27）

- `pnpm test:browser`：12 个文件、52 个浏览器测试通过，覆盖 Help、角色导航、401/403、session 和 Telegram adapter。
- `pnpm --filter @cos-tool-bot/panel check:mini-app-entry`：确认后台 HTML 不加载 Telegram SDK，Mini App adapter 仅在对应 surface 懒加载官方 SDK。
- Panel `typecheck`、`build`、全仓 `lint`（0 errors、3 个既有 warnings）、`fmt:check` 与 `git diff --check` 通过。
- 生产构建中 Mini App JS 为 17.17 kB（gzip 6.68 kB），且不包含 DEV mock 标记、Refine 或 Better Auth；Admin surface 保持独立 lazy chunk。
- 以 390×844 viewport 人工检查公共 Help；后端不可用时仍显示背景、隐私说明和公开命令。
- 阶段 Review 未发现 P0；发现并修复外层 Mini App route 缺失导致重定向循环，并为两个 lazy surface 增加 chunk 加载失败兜底。最终 Review 将 Telegram 官方 SDK 从全局入口收敛为 Mini App surface 懒加载，避免扩大后台脚本与 framing 权限。
- 尚未在 Telegram iOS/Android/Desktop/Web 实机覆盖动态键盘、SDK 网络失败和 safe-area 差异；这些属于 G7 四端灰度验收，不改变 G2 的 fail-closed 与 CSS 契约。
