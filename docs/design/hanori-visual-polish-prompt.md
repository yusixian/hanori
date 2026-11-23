# Hanori · 花织视觉打磨提示词

把以下内容复制给下一个 Agent：

```text
在仓库根目录继续打磨 Hanori · 花织的视觉。先读取 AGENTS.md 和现有品牌设计记录，再用 git status 核对当前修改。

产品是自托管 AI 伴侣，以 Telegram 为主要入口，工作台管理 Bot、模型、记忆、创作和工具。名字 Hanori · 花织 / 仓库名 hanori 已确认。希望活泼、亲切、有角色感，参考 astro-koharu 的樱花粉、粉蓝和柔和渐变；保留工作台的信息清晰度、操作效率和可读性。当前 SVG 樱花笑脸标识只是首版，可继续打磨。

先看用户给的审美参考：
.lody/attachments/c1f7f559-image.png
.lody/attachments/7613134a-image.png
再看 .open-source/hanori-preview 下的登录页和导航截图，并查看实际浏览器。

重点覆盖：品牌标识/字标、字体层级和配色 token、登录页、桌面/手机导航、公开文档，以及代表性的管理页面、表单和空/加载/错误状态。检查共用控件和硬编码颜色，形成一致的视觉语言。可以自主处理常规可逆设计细节，先说明简短方向后直接实现，不要只给建议或停在计划。

主要代码入口：
packages/panel/src/style.css
packages/panel/src/pages/login.tsx
packages/panel/src/components/layout/app-layout.tsx
packages/panel/src/components/hanori-mark.tsx
packages/panel/src/components/ui/
packages/panel/src/i18n/locales/en/ 和 zh-CN/
packages/docs/app/styles.css
packages/docs/app/lib/layout.tsx
packages/docs/public/docs/icon.svg
packages/shared/src/brand.ts

如果需要角色插画，请给我可直接用于生图的提示词、尺寸、构图、用途、透明背景要求与移动端裁切说明，我可以生图。新增公开素材要有可分发来源，并进入受审阅导出清单。先用现有 SVG 保证页面可以运行。

只改视觉和必要的双语文案，保留鉴权、权限、表单输入、路由、键盘操作和 Telegram Mini App 签名校验。数据库、加密参数、组织 slug、内部 workspace scope、Compose/volume 和本地存储 key 都不要随产品名替换。不要恢复暂停的 UI goal、改生产配置、读取或输出密钥。本次视觉任务不包含新的提交、推送、PR、发布或部署授权；如用户另行授权，按最新指令执行。

开发预览：pnpm --filter @cos-tool-bot/panel dev --host 127.0.0.1
文档预览：pnpm dev:docs
已有 http://127.0.0.1:43105/login 是前一轮生产前端构建，改源码后不会自动更新，不带后端或文档。需要后端数据时可使用明确标注的合成 API 响应，不连接真实账号和生产数据。启动预览后，按可用 Lody MCP 工具描述上报地址并告诉我从 Browser 查看。

完成后在实际浏览器验证 1440、390、320px；覆盖双语、无横向溢出、键盘焦点、语言切换保留输入及相关状态。按改动范围完成仓库要求的格式/lint/类型/双语/单元/浏览器/构建/文档检查，汇报实际结果、截图和剩余限制。之前的测试结果是基线，不能当作新改动通过。更新 HANDOFF.md；新增资产后重新导出到新目录并校验，保留已有快照。
```
