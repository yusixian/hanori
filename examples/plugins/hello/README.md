# Hello 插件示例

这是零依赖的 API v1 插件，包含只读 `greet` 工具和 `hello` 范围的合成文本检索。它不访问网络，不读写账号数据，也不需要密钥。运行环境为 Node.js 22.19.0 或更高版本。

## 本地验证

在本目录运行以下命令。它验证入口、工具参数、单页检索、取消和会话销毁，不安装插件或更改 Hanori 实例。

```bash
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import plugin from './index.mjs';

const manifest = JSON.parse(await readFile('./hanori.plugin.json', 'utf8'));
assert.equal(manifest.id, 'example.hello');
assert.equal(manifest.apiVersion, 1);
assert.equal(plugin.apiVersion, 1);
const controller = new AbortController();
const context = {
  actor: { botId: 'example', chatId: 1, isAdmin: false, isPrivate: true, readOnly: true },
  configuration: { greeting: 'Hello' },
  signal: controller.signal,
};
const session = await plugin.createSession(context);
const tool = session.tools[0];
assert.equal(tool.effect, 'read_only');
assert.deepEqual(await tool.execute({ name: 'Ada' }, controller.signal), {
  status: 'ok', text: 'Hello, Ada!',
});
assert.equal((await tool.execute({ name: '' }, controller.signal)).status, 'invalid_request');
assert.equal((await tool.execute({ name: 'Ada', extra: true }, controller.signal)).status, 'invalid_request');
const provider = session.searchProviders[0];
const request = { scope: 'hello', query: 'synthetic', page: 1, limit: 5 };
const results = await provider.search(request, controller.signal);
assert.equal(results.status, 'ok');
assert.equal(results.items[0].id, 'synthetic');
assert.equal(results.hasMore, false);
assert.equal((await provider.search({ ...request, page: 2 }, controller.signal)).status, 'invalid_request');
assert.equal((await provider.search({ ...request, query: 'no matching entry' }, controller.signal)).status, 'empty');
const aborted = new AbortController();
aborted.abort();
await assert.rejects(tool.execute({ name: 'Ada' }, aborted.signal), /plugin_stopped/);
await session.dispose();
await assert.rejects(provider.search(request, controller.signal), /plugin_stopped/);
const next = await plugin.createSession(context);
assert.equal((await next.tools[0].execute({ name: 'Ada' }, controller.signal)).status, 'ok');
controller.abort();
await assert.rejects(next.tools[0].execute({ name: 'Ada' }, new AbortController().signal), /plugin_stopped/);
await next.dispose();
console.log('Hello plugin smoke test passed');
NODE
```

## 打包与安装

把本目录的 `hanori.plugin.json`、`index.mjs` 和可选说明文件放到独立公开 GitHub 仓库的根目录。安装器读取仓库根目录，不能直接安装当前 Hanori 仓库中的这个子目录。

将 `example.hello` 改成你自己稳定且唯一的插件 ID，例如 `yourname.hello`，同步检查版本与作者字段。使用依赖时，在发布前自行打包成可运行的 ESM；安装器不执行 `npm install`、构建脚本、Git hooks 或子模块更新。本示例可以原样运行，无需构建。

在管理面板的插件页面填写 `https://github.com/yourname/hello-plugin` 与实际发布提交的完整 40 位小写 SHA。分支名、tag、短 SHA、私有仓库和带账号凭据的 URL 不受支持。此地址仅演示格式，不是现成可安装的仓库。

安装时需要明确接受插件具有服务端进程权限。插件 SDK 与只读标记不提供沙箱。安装后为目标 Bot 单独保存 `greeting` 配置并启用；其他 Bot 不会自动启用。

本示例没有 `check` 钩子。面板中的配置测试仅验证它能创建合法会话，不能据此判断外部服务认证成功。完整契约见公开的插件开发指南及仓库 `packages/shared/src/plugin-runtime.ts`、`packages/shared/src/search.ts`。
