# 公开文档站维护

`packages/docs` 是独立的 Fumadocs + React Router 文档站。页面在构建时预渲染，生产由现有 Hono 服务托管到 `/docs/`，不需要额外运行文档服务、访问数据库或向浏览器提供 GitHub 凭据。

## 本地开发

```bash
pnpm install
pnpm dev:docs
# http://localhost:5174/docs/
```

`pnpm dev` 同时启动服务端、面板与文档站；开发时面板的 `/docs` 入口跳转到文档端口 5174，文档的「管理面板」入口返回面板端口 5173，让两个 Vite 应用各自处理模块与热更新。生产环境仍共用 `/docs/` 路径。只编辑文档时使用 `pnpm dev:docs`，无需 `.env`、数据库或 Bot Token。

## 内容边界

- 公开指南只来自 `packages/docs/content/docs/`。新增页面使用 Markdown/MDX，填写 `title` 与 `description`，并更新对应 `meta.json` 导航。
- 仓库根 `docs/` 仍保存内部设计和运维记录，不会整体被公开。唯一显式读取的内容目录是 `docs/releases/`。
- 公开内容只使用示例域名、示例账号和通用步骤。不要放生产地址、个人路径、运行日志或凭据。
- 文档站公开不代表源码已开源。仓库可见性和许可证应在真正开源时单独确定。
- 首版正文为中文；管理面板的文档入口提供中英文文案。

## 更新说明：一份正文，两个出口

将版本正文保存为 `docs/releases/vX.Y.Z.md`。文档站在开发和构建时生成对应的更新详情页，不手动维护第二份内容。

发布 GitHub Release 时也使用此文件：

```bash
gh release create vX.Y.Z --target FULL_COMMIT_SHA \
  --title "vX.Y.Z — 更新主题" \
  --notes-file docs/releases/vX.Y.Z.md
```

发布前核对版本、目标 SHA、变更范围和 CI，遵循维护者的发布授权流程。创建 tag/Release 不会自动改变已经部署的文档；站点内容在下一次构建部署后更新。

涉及使用方式、权限、配置或部署变化时，同一 PR 也要更新对应指南和 README 入口。版本号、发布正文、公共导航、GitHub Release 与部署验证的完整约定见根目录 [AGENTS.md](../AGENTS.md#public-documentation-and-releases)。

## 构建与验证

```bash
pnpm --filter @cos-tool-bot/docs typecheck
pnpm build:docs
pnpm preview:docs # production static handler, http://127.0.0.1:4174/docs/
pnpm test:docs    # desktop/mobile against the production static handler
pnpm exec vitest run packages/server/src/routes/public-docs.test.ts
```

Docker 将 `packages/docs/build/client/docs/` 复制到 `public/docs/`，并复制 React Router 首页导航需要的 `docs.data`。文档站的根 `index.html` 和 SPA fallback 不会复制，避免覆盖管理面板入口。新增页面与资源保持在 `/docs` 路径空间内。

Hono 对文档 HTML 中的构建脚本计算 CSP 哈希；管理面板的安全策略保持独立。文档缺失路径返回真正的 404，不回退到面板登录页。验收应覆盖未登录访问、深层地址刷新、搜索、移动端菜单和更新说明入口。
