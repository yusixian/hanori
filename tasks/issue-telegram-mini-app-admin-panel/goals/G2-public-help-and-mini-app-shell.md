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

- [ ] `fetch` 失败或 Telegram SDK 缺失时，Help 仍能显示。
- [ ] 公共 Help 不展示当前 Bot enabled capability、Provider 数量或部署状态。
- [ ] Admin 导航为 Groups/Settings/Access/Help；Operator/Viewer 为 Groups/Help。
- [ ] 亮暗主题、窄屏、safe area 和键盘场景无内容遮挡。
- [ ] Mini App 401 显示 session expired，403 回到 Help。
- [ ] 现有 Better Auth login、Refine routes 和 light-theme Panel 无回归。

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
