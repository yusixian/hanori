# 用量页模型明细可读性验收

## 范围与基线

2026-09-23，在 v0.12.0 后的 main `476e175090a1c794e5c9e7b96b8591bf21ec6965` 复验旧候选。当前生产构建的 1440×900 与 390×844 截图都确认：Recharts 固定 140px 的模型坐标轴裁切 `gemini-2.5-flash-preview-09-2025` 的左侧。基线截图在 `.acceptance/ui-efficiency/usage-model-current-baseline/`。

## 本轮结果与验收条件

- 「按模型」改为完整模型 ID、Token 总量、输入和输出值及分段条；分段条共用当前列表最高输入加输出用量的尺度。其他用量图表、筛选/API 与错误恢复逻辑保持原有行为。
- 1440px 与 390px 下完整模型 ID 可读；约 280 字符的无空格 ID 自动换行，数值和条形仍可见；页面无横向溢出。
- 时间/Bot 筛选、加载、空结果、四种独立错误与重试、125 Bot 完整选项和键盘选择保持可用。中英文沿用现有文案键。

## 当前证据

- 用量页浏览器回归 24/24，通过两个宽度的完整与超长 ID、总量和输入/输出数值断言；Panel 类型检查、相关 lint/format、i18n 2426 keys、Panel 生产构建通过。
- 生产构建预览在 1440×900 与 390×844 各执行 49 次合成 GET，筛选、错误恢复、空态与键盘选择通过，无页面异常和横向溢出。证据 `.acceptance/ui-efficiency/usage-model-production-flow/`。
- 当前构建的正常及超长 ID 截图已逐张目视复核，见 `.acceptance/ui-efficiency/usage-model-production-visual/` 与 `.acceptance/ui-efficiency/usage-model-long-id/`。
- 本地聚焦验收汇总在 `.acceptance/ui-efficiency/usage-model-report/report.html`；报告明确区分聚焦通过与完整隔离验收器未运行。
- 公共指南已更新；文档 typecheck/build 与 18 项桌面/手机文档浏览器检查通过。独立 Sol 只读审查未发现明确阻断回归。

## 边界与待交付

浏览器数据是合成夹具，没有读取真实用量或验证线上实例。仓库完整隔离验收器依赖 Docker 且会清理固定的 3100 端口；本机 Docker daemon 不可用、应用入口无法启动，3100 当前属于其他项目，未运行该验收器。此处的通过结论仅针对上述聚焦流程。

v0.12.1 的提交、远端 CI、GitHub Release 和合入后核验仍待完成；生产部署未授权。
