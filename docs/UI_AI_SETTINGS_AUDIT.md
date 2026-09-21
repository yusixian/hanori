# AI 设置页效率审计

状态：静态审计完成；已补充草稿丢失的真实浏览器复现。记录日期：2026-09-22。

本文是 `packages/panel` Bot AI 设置页后续迭代的持久证据。当前迭代先交付导航与工作区调整；本文不表示这些 AI 设置改动已经实现或验收。

## 范围与证据边界

初次审计范围包括 AI 设置页的设置查找、信息层级、保存与未保存反馈，以及离开页面时的草稿保护，依据源码和已有浏览器测试。后续补充的实际浏览器证据单列于文末；所有检查均未调用真实 Bot、Telegram 或生产服务。

当前页面已经具备可复用基础：

- 大类导航已通过 `useSearchParams` 写入 `section` 查询参数：`packages/panel/src/pages/bots/ai-settings/ai-settings-page.tsx:129`、`:210-219`。
- 页面已有统一草稿序列化和 dirty 判断：`packages/panel/src/pages/bots/ai-settings/ai-settings-page.tsx:108-124`、`:369-392`。
- 折叠项基于 Radix Accordion：`packages/panel/src/components/ui/accordion.tsx:6-46`；AI 设置包装位于 `packages/panel/src/pages/bots/ai-settings/components/settings-disclosure-row.tsx:10-57`。
- 可复用搜索输入组件和现有视觉模式分别位于 `packages/panel/src/components/ui/input.tsx:4-16`、`packages/panel/src/pages/bots/generations.tsx:111-125`。
- 保存结果目前通过 Sonner toast 展示：`packages/panel/src/pages/bots/ai-settings/ai-settings-page.tsx:363-367`，全局 Toaster 挂载于 `packages/panel/src/App.tsx:65-78`。

## 发现与用户旅程

### 1. 已知设置名称时仍需猜分类并逐项展开

页面把配置分为概览、服务商与模型、回复行为、记忆、工具、权限与群组 6 个大类，证据见 `packages/panel/src/pages/bots/ai-settings/ai-settings-page.tsx:169-219`。回复行为、记忆、工具和权限四类下共有 21 个 `SettingsDisclosureRow`，分布于同文件 `:1003-1267`，但页面没有跨分类搜索或子项索引。

折叠项没有稳定的设置 ID，且每一行都创建自己的非受控 Accordion，并共用固定值 `content`：`packages/panel/src/pages/bots/ai-settings/components/settings-disclosure-row.tsx:25-28`。URL 只能表达大类，无法表达“回复行为 / 超时设置”这一级状态，也无法复制链接让另一个会话直接打开目标设置。

具体旅程：用户想修改“超时设置”，需要进入 AI 设置，判断它属于“回复行为”，再从 8 个折叠项中扫描并展开。用户若只记得“OCR”或“MCP”，同样必须先猜“工具”。刷新、返回或分享 URL 后，展开位置不能恢复。

影响：查找成本随设置数持续上升；设置虽然已经分组，仍不适合高频管理和跨会话定位。

### 2. 保存状态在窄屏不可见，顶部保存按钮的可用性难以解释

未保存提示被放在仅 `sm` 以上显示的描述容器内：`packages/panel/src/pages/bots/ai-settings/ai-settings-page.tsx:823-829`。在手机宽度上，用户编辑后只能从 Save 按钮本身推断状态。

顶部 Save 的禁用条件没有包含 `!isDirty`，因此无更改时仍可提交：`packages/panel/src/pages/bots/ai-settings/ai-settings-page.tsx:838-845`。当 Live selection 有草稿时，Save 又会被禁用，原因仅放在原生 `title`：同文件 `:846-852`。通用 Button 对禁用态应用 `pointer-events-none`：`packages/panel/src/components/ui/button.tsx:30-35`，所以依靠鼠标悬停获取该原因并不可靠，触屏和键盘用户也没有等价的就近说明。

具体旅程：用户在手机上修改触发词或 Prompt，滚动到较长表单下方后无法持续确认是否已有未保存内容；保存成功后只看到短暂 toast。另一种情况是用户修改 Live selection 后继续编辑服务商目录，sticky Save 变灰，但页面顶部没有可见原因。

影响：容易重复保存、误以为更改已生效，或把“需要先处理当前选择”误判为页面故障。

### 3. Live selection 的双保存流程缺少明确的撤销动作

Live selection 自己维护 dirty 状态并提供 Apply selection：`packages/panel/src/pages/bots/ai-settings/sections/global-ai-selection-section.tsx:35-41`、`:115-139`。父页面又把这份 dirty 状态合入整页 `isDirty`，并在它存在时禁用顶部 Save：`packages/panel/src/pages/bots/ai-settings/ai-settings-page.tsx:385-392`、`:838-852`。

页面文案要求用户先“应用或撤销当前选择草稿”，但组件只有 Apply 和 Retry，没有 Discard 回调或按钮：`packages/panel/src/pages/bots/ai-settings/sections/global-ai-selection-section.tsx:16-33`、`:123-139`；对应文案位于 `packages/panel/src/i18n/locales/zh-CN/ai-settings.ts:143`。

具体旅程：用户试选另一个模型后改变主意，又想保存 API URL 等目录配置。当前只能手动重新选择原服务商、模型和展示开关，或直接应用本来不想要的选择，才能解除顶部 Save 锁定。

影响：高频试选场景操作冗长，并放大两个保存入口之间的认知负担。

### 4. `beforeunload` 不能证明站内导航受到保护

AI 设置页仅注册浏览器 `beforeunload`：`packages/panel/src/pages/bots/ai-settings/ai-settings-page.tsx:395-402`。应用由 `BrowserRouter` 承载：`packages/panel/src/App.tsx:65-78`，管理页路由在 `packages/panel/src/admin-panel-app.tsx:137-179` 内使用 React Router 切换。

具体旅程：用户编辑 Prompt 后点击管理面板中的另一个入口。SPA 导航通常不会卸载文档，因此现有 `beforeunload` 只能覆盖刷新、关闭标签页等浏览器级离开，不能作为站内 Link 已受保护的证据。

影响：站内跳转存在无提示丢失草稿的风险。该项在真实浏览器验证前记为“源码证据充分的兼容性风险”，不把尚未执行的交互测试写成已复现缺陷。

### 5. 已有状态摘要在手机和普通窄窗口被隐藏

许多折叠项已经传入 Enabled、Disabled、数量或模式摘要，例如记忆设置位于 `packages/panel/src/pages/bots/ai-settings/ai-settings-page.tsx:1103-1136`，工具设置位于同文件 `:1140-1221`。但 `SettingsDisclosureRow` 把摘要设为 `hidden ... lg:block`：`packages/panel/src/pages/bots/ai-settings/components/settings-disclosure-row.tsx:46-49`。

具体旅程：用户在 390px 手机或小于 1024px 的桌面窗口中巡检哪些工具、记忆和权限已启用。当前必须逐项展开，不能从折叠列表直接扫视有效状态。

影响：已有信息没有发挥作用，巡检成本和页面“很乱”的感受同时增加。

## 建议拆成两个可审查批次

### 批次 A：设置查找与信息层级

目标是让用户能按名称找到设置、打开准确位置，并从折叠态看懂关键状态。该批次不改变配置保存 API 或 Bot 行为。

建议范围：

1. 为 21 个子设置定义稳定 ID，并让 `SettingsDisclosureRow` 支持受控展开及可定位标识。
2. 在 AI 设置 sticky 区域加入设置搜索。匹配标题、描述和必要关键词；选中结果后同时更新 `section` 与 `setting` 查询参数。
3. 载入含 `setting` 的 URL 时切换到所属大类并自动展开目标项；浏览器前进、后退应恢复相同状态。
4. 在手机和窄窗口保留摘要，必要时将摘要放到标题下方，避免与折叠箭头争抢横向空间。
5. 继续复用现有中英文 i18n；新增文案后运行 `pnpm i18n:check`。

验收检查点：

- 输入“超时”、`timeout`、`OCR`、`MCP` 能得到正确结果；中文界面搜索中文，英文界面搜索英文。
- 选择搜索结果后 URL 包含稳定的 `section` 和 `setting`，目标项可见且已展开。
- 复制该 URL 到新标签页能恢复相同位置；前进、后退不会丢失大类和展开项。
- 空搜索、无结果、清空搜索有明确状态；搜索不会修改配置或制造 dirty 状态。
- 390×844、桌面窄窗口和 1440×900 下，摘要可读、无横向溢出，键盘可完成搜索、选择和展开。
- 浏览器测试至少覆盖跨分类命中、URL 恢复、历史返回、无结果和移动摘要；再做真实浏览器桌面/手机验收。

### 批次 B：保存信心与草稿保护

目标是让用户随时知道是否需要保存、为何不能保存，并能安全撤销或离开。该批次应保持现有 revision、冲突恢复和运行时 apply 语义。

建议范围：

1. 在所有断点持续显示整页状态：已保存、未保存、正在保存、保存失败、需先处理当前选择。状态更新应有合适的 `aria-live`。
2. clean 时禁用顶部 Save；dirty 且可保存时启用。禁用原因用可见文本表达，不依赖禁用按钮的 `title`。
3. 为 Live selection 增加 Discard，恢复服务端 `selection` 与 `displayDefault`；Apply、Discard、Retry 的职责保持清楚。
4. 保留现有 `beforeunload`，并增加站内导航保护；确认、取消离开都要有浏览器测试。
5. 保存成功后保持可见的“已保存”状态，toast 作为补充；错误仍需给出下一步，不要清掉用户草稿，除非现有冲突恢复契约明确要求重新加载。

验收检查点：

- 初始 clean 状态显示“已保存”且 Save 禁用；编辑任一受管字段后立即显示“未保存”并启用 Save。
- 手机宽度下 dirty 状态和主要保存动作始终可见；保存中控件不可重复提交。
- 成功保存后回到 clean；失败后保留草稿并显示可执行的错误；revision 冲突和 apply failure 继续遵守当前恢复逻辑。
- 修改 Live selection 后，Apply 和 Discard 都可用；Discard 精确恢复服务端值并解除顶部 Save 的选择锁定。
- 有草稿时点击站内入口会提示：取消后仍在原页且草稿不变，确认后才导航；刷新和关闭标签页仍由 `beforeunload` 覆盖。
- 浏览器测试覆盖 clean/dirty/saving/error、Apply/Discard、站内离开确认与取消，并在真实 BrowserRouter 组装下执行。

## 需要主代理判断：SPA 离开保护兼容性

当前根路由使用声明式 `BrowserRouter`，不是源码中可见的 `createBrowserRouter` / `RouterProvider` 数据路由：`packages/panel/src/App.tsx:3`、`:65-78`。因此实现前需要主代理确认 React Router 7.13 在当前组装下可用的 blocker API，不能仅根据 API 名称直接接入，也不应为一个表单保护顺带迁移整个路由架构。

判断顺序建议如下：

1. 在当前 `BrowserRouter` 组装下做最小行为验证，确认候选 blocker 是否能拦截 AppLayout 内的 Link 和 Refine 导航。
2. 若现成 blocker 不兼容，优先设计页面级、可测试且不破坏 Cmd/Ctrl+Click 等链接语义的方案，并把限制写入测试和文档。
3. 若只有迁移到 Data Router 才能可靠覆盖，单独提出架构批次，评估认证、Refine router provider、Mini App 分流和所有现有路由的影响，不混入批次 B。

在上述兼容性验证完成前，“站内离开保护已实现”不能通过静态类型检查或 `beforeunload` 测试来证明。

## 起始基线的测试缺口

`packages/panel/src/pages/bots/ai-settings/ai-settings-page.browser.test.tsx:23-57` 在起始基线只验证从 Smart group engagement 跳转到 debugger。`packages/panel/src/pages/bots/ai-settings/sections/global-ai-selection-section.browser.test.tsx:45-111` 只覆盖 Apply、Retry 和只读权限，没有覆盖 Discard、顶部 Save 联动、搜索、URL 展开状态、dirty 状态或离开保护。

因此两个批次都必须增加页面级浏览器测试；组件测试只能证明局部交互，不能替代真实路由组装和桌面/手机验收。

## 后续浏览器证据（2026-09-22）

主代理在完整 BrowserRouter 应用、1440×900 Chromium 和全量拦截的 API 夹具下复现：进入回复行为，修改系统提示词，确认“有未保存的更改”；点击侧栏返回 Bot 列表并等待 AI 表单卸载，未出现确认提示；浏览器返回后系统提示词恢复服务端空值，草稿丢失。证据在 `.acceptance/ui-efficiency/ai-draft-baseline/`，复现脚本 `verify-ai-draft-baseline.mjs` 位于同一父目录。未调用保存 API、真实 Bot 或生产服务。

兼容性调查：本地 React Router 7.13.0 的 `useBlocker` 首先调用 `useDataRouterContext`，当前根 `BrowserRouter` 不能直接使用它。后续需把可靠的站内保护作为独立路由兼容批次评估，保留 Mini App 分流、懒加载和 Refine 认证行为；不把只拦截鼠标链接或 `beforeunload` 当作完整保护。[官方 useBlocker 说明](https://reactrouter.com/api/hooks/useBlocker)。

## 批次 A 交付进展

v0.5.0 候选已实现 21 项设置搜索、稳定深链、历史恢复和手机摘要，并完成独立审查修复。主树 AI 页面浏览器回归 9/9；完整应用的桌面、窄窗口与手机夹具验收覆盖定位、键盘焦点和切换时草稿保留。该批次不改变保存或站内离开保护，批次 B 的草稿丢失问题仍待修复；发布状态以 UI_EFFICIENCY_GOAL.md 为准。
